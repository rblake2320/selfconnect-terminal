import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  type ContextBlobKind,
  type ContextBlobRef,
} from '../shared/contracts';
import { estimateTokens } from '../agent/cost-kernel';

/**
 * Content-addressed context store (A1). Every context artifact (file content,
 * scrollback chunk, git diff, doc) is hashed (SHA-256) into immutable blobs
 * under <dir>/<hash>. The same bytes are never stored — or paid for — twice.
 *
 * A per-session "seen-by-model" index records which blob hashes have already
 * been sent to a given provider in this session. When a blob was already sent,
 * the context builder emits a stable ref + 3-line digest instead of the full
 * bytes — dedup that applies across turns AND across mesh agents (A2A handoffs
 * pass blob refs, not copies).
 */
export interface DedupResult {
  ref: ContextBlobRef;
  /** True when the model has already seen this blob (send ref+digest only). */
  alreadySeen: boolean;
  /** Tokens NOT resent because of dedup (0 on a fresh send). */
  tokensSaved: number;
  /** What to actually send the model: full bytes, or the compact ref+digest. */
  payload: string;
}

function sha256(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

function makeDigest(text: string): string {
  return text
    .split(/\r?\n/)
    .filter((l) => l.trim().length > 0)
    .slice(0, 3)
    .map((l) => (l.length > 100 ? l.slice(0, 100) + '…' : l))
    .join('\n');
}

export class ContextStore {
  private refs = new Map<string, ContextBlobRef>();
  /** key = `${provider}:${hash}` -> seen. */
  private seen = new Set<string>();

  constructor(private readonly dir: string) {
    this.ensureDir();
  }

  private ensureDir(): void {
    if (!existsSync(this.dir)) mkdirSync(this.dir, { recursive: true });
  }

  private pathFor(hash: string): string {
    return join(this.dir, hash);
  }

  /** Store bytes (idempotent) and return their immutable ref. */
  put(content: string, kind: ContextBlobKind, source: string, provenance: string[] = []): ContextBlobRef {
    this.ensureDir();
    const hash = sha256(content);
    const existing = this.refs.get(hash);
    if (existing) {
      // Merge provenance event ids without duplicating.
      for (const p of provenance) if (!existing.provenance.includes(p)) existing.provenance.push(p);
      return existing;
    }
    const target = this.pathFor(hash);
    if (!existsSync(target)) writeFileSync(target, content, 'utf8');
    const ref: ContextBlobRef = {
      hash,
      kind,
      source,
      bytes: Buffer.byteLength(content, 'utf8'),
      tokens: estimateTokens(content),
      digest: makeDigest(content),
      provenance: [...provenance],
      pinned: false,
    };
    this.refs.set(hash, ref);
    return ref;
  }

  /** Read the full bytes of a stored blob (COLD-tier rehydration). */
  read(hash: string): string | null {
    const target = this.pathFor(hash);
    if (!existsSync(target)) return null;
    try {
      return readFileSync(target, 'utf8');
    } catch {
      return null;
    }
  }

  get(hash: string): ContextBlobRef | undefined {
    return this.refs.get(hash);
  }

  list(): ContextBlobRef[] {
    return [...this.refs.values()];
  }

  pinnedList(): ContextBlobRef[] {
    return this.list().filter((r) => r.pinned);
  }

  pin(hash: string): ContextBlobRef | null {
    const ref = this.refs.get(hash);
    if (!ref) return null;
    ref.pinned = true;
    return ref;
  }

  unpin(hash: string): ContextBlobRef | null {
    const ref = this.refs.get(hash);
    if (!ref) return null;
    ref.pinned = false;
    return ref;
  }

  /**
   * Decide what to send the model for a context artifact. On first sight for a
   * provider the full bytes are sent and the blob is marked seen; thereafter
   * only the stable ref + 3-line digest is sent — the rest of the tokens are
   * counted as "not resent".
   */
  prepareForSend(
    content: string,
    kind: ContextBlobKind,
    source: string,
    provider: string,
    provenance: string[] = [],
  ): DedupResult {
    const ref = this.put(content, kind, source, provenance);
    const key = `${provider}:${ref.hash}`;
    if (this.seen.has(key)) {
      const digestTokens = estimateTokens(ref.digest);
      return {
        ref,
        alreadySeen: true,
        tokensSaved: Math.max(0, ref.tokens - digestTokens),
        payload: `[ctx ${ref.hash.slice(0, 12)} ${ref.kind} ${ref.source}]\n${ref.digest}`,
      };
    }
    this.seen.add(key);
    return { ref, alreadySeen: false, tokensSaved: 0, payload: content };
  }

  /** Mark a blob as already seen by a provider (e.g. arrived via A2A ref). */
  markSeen(provider: string, hash: string): void {
    this.seen.add(`${provider}:${hash}`);
  }

  hasSeen(provider: string, hash: string): boolean {
    return this.seen.has(`${provider}:${hash}`);
  }

  /** Restore blob refs + pinned state on resume (bytes stay on disk). */
  restore(refs: ContextBlobRef[]): void {
    for (const r of refs) this.refs.set(r.hash, { ...r });
  }
}

import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, appendFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import {
  LedgerEntrySchema,
  type ChainStatus,
  type EventType,
  type Identity,
  type LedgerEntry,
} from '../shared/contracts';

export const GENESIS_HASH = '0'.repeat(64);

/**
 * Canonical serialization used for hashing. Field order is fixed so that the
 * hash is reproducible across processes and platforms. We deliberately exclude
 * the `hash` field itself.
 */
function canonical(entry: Omit<LedgerEntry, 'hash'>): string {
  return JSON.stringify({
    seq: entry.seq,
    ts: entry.ts,
    type: entry.type,
    sessionId: entry.sessionId ?? null,
    runId: entry.runId ?? null,
    agentId: entry.agentId ?? null,
    payload: entry.payload ?? null,
    prevHash: entry.prevHash,
  });
}

export function hashEntry(entry: Omit<LedgerEntry, 'hash'>): string {
  return createHash('sha256').update(canonical(entry)).digest('hex');
}

export interface LedgerAppendInput {
  type: EventType;
  payload?: unknown;
  identity?: Partial<Identity>;
}

/**
 * Append-only JSONL ledger with a SHA-256 hash chain. Each entry's hash covers
 * its own canonical content plus the previous entry's hash, so any mutation,
 * insertion, deletion, or reordering breaks the chain and is detected by
 * `verifyChain` (HARD SECURITY RULES 13 & 14).
 */
export class AuditLedger {
  private entries: LedgerEntry[] = [];
  private lastHash = GENESIS_HASH;

  constructor(private readonly path: string) {
    this.ensureDir();
    this.load();
  }

  private ensureDir(): void {
    const dir = dirname(this.path);
    if (dir && !existsSync(dir)) mkdirSync(dir, { recursive: true });
  }

  private load(): void {
    if (!existsSync(this.path)) return;
    const raw = readFileSync(this.path, 'utf8');
    const lines = raw.split('\n').filter((l) => l.trim().length > 0);
    for (const line of lines) {
      const parsed = LedgerEntrySchema.parse(JSON.parse(line));
      this.entries.push(parsed);
      this.lastHash = parsed.hash;
    }
  }

  append(input: LedgerAppendInput): LedgerEntry {
    const base: Omit<LedgerEntry, 'hash'> = {
      seq: this.entries.length,
      ts: Date.now(),
      type: input.type,
      sessionId: input.identity?.sessionId,
      runId: input.identity?.runId,
      agentId: input.identity?.agentId,
      payload: input.payload,
      prevHash: this.lastHash,
    };
    const hash = hashEntry(base);
    const entry: LedgerEntry = { ...base, hash };
    appendFileSync(this.path, JSON.stringify(entry) + '\n', 'utf8');
    this.entries.push(entry);
    this.lastHash = hash;
    return entry;
  }

  /**
   * Recompute the chain from genesis and report the first index where the
   * stored hash diverges from the recomputed hash (tamper detection).
   */
  verifyChain(): ChainStatus {
    let prev = GENESIS_HASH;
    let brokenAt: number | null = null;
    for (let i = 0; i < this.entries.length; i++) {
      const e = this.entries[i];
      if (e.prevHash !== prev) {
        brokenAt = i;
        break;
      }
      const recomputed = hashEntry({
        seq: e.seq,
        ts: e.ts,
        type: e.type,
        sessionId: e.sessionId,
        runId: e.runId,
        agentId: e.agentId,
        payload: e.payload,
        prevHash: e.prevHash,
      });
      if (recomputed !== e.hash) {
        brokenAt = i;
        break;
      }
      prev = e.hash;
    }
    return {
      ok: brokenAt === null,
      entries: this.entries.length,
      lastHash: this.lastHash,
      brokenAt,
    };
  }

  status(): ChainStatus {
    return this.verifyChain();
  }

  all(): readonly LedgerEntry[] {
    return this.entries;
  }

  /** Test/maintenance helper: overwrite the on-disk JSONL verbatim. */
  rewriteRaw(entries: LedgerEntry[]): void {
    const body = entries.map((e) => JSON.stringify(e)).join('\n') + (entries.length ? '\n' : '');
    writeFileSync(this.path, body, 'utf8');
    this.entries = entries.slice();
    this.lastHash = entries.length ? entries[entries.length - 1].hash : GENESIS_HASH;
  }
}

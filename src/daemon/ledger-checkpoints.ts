import { existsSync, mkdirSync, readFileSync, appendFileSync } from 'node:fs';
import { dirname } from 'node:path';
import {
  LedgerCheckpointSchema,
  type LedgerCheckpoint,
  type LedgerEntry,
  type Signature,
} from '../shared/contracts';
import { verifySignature } from './agent-keys';

/**
 * Signed ledger checkpoints (Section B). The audit ledger is already a SHA-256
 * hash chain; a checkpoint additionally SIGNS the chain head (seq + hash) with
 * the system agent's Ed25519 key. This defends against whole-file substitution:
 * a tampered ledger can be re-hashed to look internally consistent, but it
 * cannot be re-signed without the daemon's private key. `selfconnect ledger
 * verify` checks both the hash chain AND every checkpoint signature.
 *
 * Persisted as append-only JSONL (D7: no databases) next to the ledger.
 */

/** Canonical message a checkpoint signs. Stable field order = reproducible. */
export function checkpointMessage(seq: number, hash: string, entries: number, ts: number): string {
  return JSON.stringify({ seq, hash, entries, ts });
}

export interface CheckpointVerification {
  ok: boolean;
  checkpoints: number;
  /** Index of the first bad checkpoint, or null. */
  badAt: number | null;
  reason?: string;
}

export class CheckpointStore {
  private checkpoints: LedgerCheckpoint[] = [];

  constructor(private readonly path: string) {
    const dir = dirname(this.path);
    if (dir && !existsSync(dir)) mkdirSync(dir, { recursive: true });
    this.load();
  }

  private load(): void {
    if (!existsSync(this.path)) return;
    const raw = readFileSync(this.path, 'utf8');
    for (const line of raw.split('\n').filter((l) => l.trim().length > 0)) {
      const parsed = LedgerCheckpointSchema.safeParse(JSON.parse(line));
      if (parsed.success) this.checkpoints.push(parsed.data);
    }
  }

  /**
   * Seal the current ledger head: sign (seq, hash, entries, ts) and append the
   * checkpoint. `sign` is provided by the daemon keystore (system agent).
   */
  seal(head: { seq: number; hash: string; entries: number }, sign: (msg: string) => Signature): LedgerCheckpoint {
    const ts = Date.now();
    const msg = checkpointMessage(head.seq, head.hash, head.entries, ts);
    const checkpoint: LedgerCheckpoint = {
      seq: head.seq,
      hash: head.hash,
      entries: head.entries,
      ts,
      signature: sign(msg),
    };
    this.checkpoints.push(checkpoint);
    try {
      appendFileSync(this.path, JSON.stringify(checkpoint) + '\n', 'utf8');
    } catch {
      // best-effort persistence
    }
    return checkpoint;
  }

  all(): readonly LedgerCheckpoint[] {
    return this.checkpoints;
  }

  count(): number {
    return this.checkpoints.length;
  }

  /**
   * Verify every checkpoint: its signature must validate AND the sealed hash
   * must match the corresponding ledger entry's hash (so a checkpoint cannot
   * vouch for a substituted entry).
   */
  verify(entries: readonly LedgerEntry[]): CheckpointVerification {
    for (let i = 0; i < this.checkpoints.length; i++) {
      const cp = this.checkpoints[i];
      const msg = checkpointMessage(cp.seq, cp.hash, cp.entries, cp.ts);
      if (!verifySignature(msg, cp.signature)) {
        return { ok: false, checkpoints: this.checkpoints.length, badAt: i, reason: `checkpoint ${i} (seq ${cp.seq}) signature invalid` };
      }
      const entry = entries[cp.seq];
      if (!entry || entry.hash !== cp.hash) {
        return { ok: false, checkpoints: this.checkpoints.length, badAt: i, reason: `checkpoint ${i} (seq ${cp.seq}) does not match ledger entry hash` };
      }
    }
    return { ok: true, checkpoints: this.checkpoints.length, badAt: null };
  }
}

import { createHash } from 'node:crypto';
import {
  type AgentPublicKey,
  type LedgerCheckpoint,
  type LedgerEntry,
  type ReplayBundle,
  type Signature,
} from '../shared/contracts';
import { verifySignature } from './agent-keys';
import { checkpointMessage } from './ledger-checkpoints';

/**
 * Session flight-recorder bundles (Section B). A `.screplay` is a signed,
 * self-contained record of one session's ledger slice plus the checkpoint
 * signatures and public keys needed to verify it offline. `replay verify`
 * recomputes the hash chain over the events, checks every checkpoint signature
 * against its sealed entry, and verifies the bundle's own signature — so a
 * tampered replay is detectable without the daemon or its keystore.
 */

/** Canonical message the bundle signs (commits to events + checkpoints). */
export function replayMessage(b: Omit<ReplayBundle, 'signature'>): string {
  return JSON.stringify({
    version: b.version,
    sessionId: b.sessionId,
    exportedAt: b.exportedAt,
    eventHashes: b.events.map((e) => e.hash),
    checkpointHashes: b.checkpoints.map((c) => c.hash),
  });
}

export function buildReplayBundle(input: {
  sessionId: string;
  events: LedgerEntry[];
  checkpoints: LedgerCheckpoint[];
  publicKeys: AgentPublicKey[];
  sign: (msg: string) => Signature;
  exportedAt?: number;
}): ReplayBundle {
  const unsigned: Omit<ReplayBundle, 'signature'> = {
    version: 1,
    sessionId: input.sessionId,
    exportedAt: input.exportedAt ?? Date.now(),
    events: input.events,
    checkpoints: input.checkpoints,
    publicKeys: input.publicKeys,
  };
  return { ...unsigned, signature: input.sign(replayMessage(unsigned)) };
}

export interface ReplayVerification {
  ok: boolean;
  signatureOk: boolean;
  chainOk: boolean;
  checkpointsOk: boolean;
  events: number;
  brokenAt: number | null;
  reason: string;
}

function hashLedgerEntry(e: LedgerEntry): string {
  const canonical = JSON.stringify({
    seq: e.seq,
    ts: e.ts,
    type: e.type,
    sessionId: e.sessionId ?? null,
    runId: e.runId ?? null,
    agentId: e.agentId ?? null,
    payload: e.payload ?? null,
    prevHash: e.prevHash,
  });
  return createHash('sha256').update(canonical).digest('hex');
}

/**
 * Verify a replay bundle end-to-end: signature, internal hash chain over the
 * events slice, and each checkpoint signature + its match to a sealed event.
 */
export function verifyReplayBundle(bundle: ReplayBundle): ReplayVerification {
  const events = bundle.events.length;
  const signatureOk = verifySignature(replayMessage(bundle), bundle.signature);
  if (!signatureOk) {
    return { ok: false, signatureOk, chainOk: false, checkpointsOk: false, events, brokenAt: null, reason: 'bundle signature invalid' };
  }

  // Internal hash chain over the events slice (relative consistency).
  let brokenAt: number | null = null;
  for (let i = 0; i < bundle.events.length; i++) {
    const e = bundle.events[i];
    if (i > 0 && e.prevHash !== bundle.events[i - 1].hash) {
      brokenAt = i;
      break;
    }
    if (hashLedgerEntry(e) !== e.hash) {
      brokenAt = i;
      break;
    }
  }
  const chainOk = brokenAt === null;
  if (!chainOk) {
    return { ok: false, signatureOk, chainOk, checkpointsOk: false, events, brokenAt, reason: `event chain broken at index ${brokenAt}` };
  }

  // Checkpoint signatures + match to a covered event.
  const bySeq = new Map(bundle.events.map((e) => [e.seq, e] as const));
  for (const cp of bundle.checkpoints) {
    const msg = checkpointMessage(cp.seq, cp.hash, cp.entries, cp.ts);
    if (!verifySignature(msg, cp.signature)) {
      return { ok: false, signatureOk, chainOk, checkpointsOk: false, events, brokenAt: null, reason: `checkpoint seq ${cp.seq} signature invalid` };
    }
    const e = bySeq.get(cp.seq);
    if (e && e.hash !== cp.hash) {
      return { ok: false, signatureOk, chainOk, checkpointsOk: false, events, brokenAt: null, reason: `checkpoint seq ${cp.seq} does not match its event hash` };
    }
  }

  return { ok: true, signatureOk, chainOk, checkpointsOk: true, events, brokenAt: null, reason: 'replay bundle verified' };
}

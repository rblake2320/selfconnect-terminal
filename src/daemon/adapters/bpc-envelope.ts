import { createHash, randomUUID } from 'node:crypto';
import {
  BpcEnvelopeSchema,
  type A2aKind,
  type BpcEnvelope,
  type Identity,
} from '../../shared/contracts';

/**
 * BPC (Basic Protocol Communication) envelope — the on-the-wire format for A2A
 * (agent-to-agent) messaging. Each peer conversation is a SHA-256 hash chain
 * exactly like the audit ledger: every envelope's hash covers its content plus
 * the previous envelope's hash, so any tamper/reorder/drop is detectable.
 */

export const BPC_GENESIS = '0'.repeat(64);

function canonical(e: Omit<BpcEnvelope, 'hash'>): string {
  return JSON.stringify({
    bpc: e.bpc,
    id: e.id,
    from: e.from,
    to: e.to,
    ts: e.ts,
    kind: e.kind,
    payload: e.payload ?? null,
    prevHash: e.prevHash,
  });
}

export function hashEnvelope(e: Omit<BpcEnvelope, 'hash'>): string {
  return createHash('sha256').update(canonical(e)).digest('hex');
}

export interface SealInput {
  from: Identity;
  to: string;
  kind: A2aKind;
  payload: unknown;
  prevHash: string;
  ts?: number;
}

/** Build the next sealed envelope in a peer chain. */
export function sealEnvelope(input: SealInput): BpcEnvelope {
  const base: Omit<BpcEnvelope, 'hash'> = {
    bpc: '1.0',
    id: `bpc_${randomUUID()}`,
    from: input.from,
    to: input.to,
    ts: input.ts ?? Date.now(),
    kind: input.kind,
    payload: input.payload,
    prevHash: input.prevHash,
  };
  return { ...base, hash: hashEnvelope(base) };
}

/** Verify a single envelope's self-hash. */
export function verifyEnvelope(env: BpcEnvelope): boolean {
  const parsed = BpcEnvelopeSchema.safeParse(env);
  if (!parsed.success) return false;
  const { hash, ...rest } = env;
  return hashEnvelope(rest) === hash;
}

export interface ChainVerification {
  ok: boolean;
  brokenAt: number | null;
  lastHash: string;
}

/** Verify an ordered chain of envelopes (per-peer tamper detection). */
export function verifyChain(envelopes: BpcEnvelope[]): ChainVerification {
  let prev = BPC_GENESIS;
  for (let i = 0; i < envelopes.length; i++) {
    const e = envelopes[i];
    if (e.prevHash !== prev || !verifyEnvelope(e)) {
      return { ok: false, brokenAt: i, lastHash: prev };
    }
    prev = e.hash;
  }
  return { ok: true, brokenAt: null, lastHash: prev };
}

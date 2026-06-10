import { describe, it, expect } from 'vitest';
import {
  BPC_GENESIS,
  sealEnvelope,
  verifyEnvelope,
  verifyChain,
} from '../src/daemon/adapters/bpc-envelope';
import type { Identity } from '../src/shared/contracts';

const from: Identity = { sessionId: 's', runId: 'r', agentId: 'agent_shell' };

function chainOf(n: number) {
  const envs = [];
  let prev = BPC_GENESIS;
  for (let i = 0; i < n; i++) {
    const e = sealEnvelope({ from, to: 'peer', kind: 'msg', payload: { i }, prevHash: prev });
    envs.push(e);
    prev = e.hash;
  }
  return envs;
}

describe('BPC envelope hash chain', () => {
  it('seals an envelope whose self-hash verifies', () => {
    const e = sealEnvelope({ from, to: 'peer', kind: 'msg', payload: { hi: 1 }, prevHash: BPC_GENESIS });
    expect(e.bpc).toBe('1.0');
    expect(e.prevHash).toBe(BPC_GENESIS);
    expect(verifyEnvelope(e)).toBe(true);
  });

  it('links prevHash to the previous envelope hash', () => {
    const [a, b] = chainOf(2);
    expect(b.prevHash).toBe(a.hash);
    expect(verifyChain([a, b]).ok).toBe(true);
  });

  it('verifies a long intact chain', () => {
    const envs = chainOf(8);
    const res = verifyChain(envs);
    expect(res.ok).toBe(true);
    expect(res.brokenAt).toBeNull();
    expect(res.lastHash).toBe(envs[envs.length - 1].hash);
  });

  it('detects payload tampering (self-hash mismatch)', () => {
    const envs = chainOf(4);
    (envs[2] as { payload: unknown }).payload = { i: 999 };
    const res = verifyChain(envs);
    expect(res.ok).toBe(false);
    expect(res.brokenAt).toBe(2);
  });

  it('detects reorder / dropped envelope (prevHash mismatch)', () => {
    const envs = chainOf(4);
    const broken = [envs[0], envs[2], envs[3]]; // dropped index 1
    const res = verifyChain(broken);
    expect(res.ok).toBe(false);
    expect(res.brokenAt).toBe(1);
  });

  it('a single tampered self-hash fails verifyEnvelope', () => {
    const e = sealEnvelope({ from, to: 'peer', kind: 'msg', payload: 'x', prevHash: BPC_GENESIS });
    const bad = { ...e, hash: 'deadbeef'.repeat(8) };
    expect(verifyEnvelope(bad)).toBe(false);
  });
});

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AgentKeystore } from '../src/daemon/agent-keys';
import {
  buildMerkle,
  merkleProof,
  rootFromProof,
  buildPassport,
  revealLeaf,
  verifyPassport,
  verifyReveal,
  summarize,
} from '../src/daemon/passport';
import type { LedgerEntry } from '../src/shared/contracts';

function entry(seq: number, type: LedgerEntry['type']): LedgerEntry {
  return { seq, ts: 1000 + seq, type, sessionId: 'sess', runId: 'run', agentId: 'a', payload: { i: seq }, prevHash: 'p'.repeat(64), hash: `h${seq}`.padEnd(64, '0') };
}

describe('Passport + Merkle (B2.3)', () => {
  let dir: string;
  let ks: AgentKeystore;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'sc-pass-'));
    ks = new AgentKeystore(dir);
    ks.ensure('agent');
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('builds a Merkle tree and verifies inclusion proofs for every leaf', () => {
    const leaves = ['a', 'b', 'c', 'd', 'e'].map((s) => s.repeat(8));
    const { root, levels } = buildMerkle(leaves);
    for (let i = 0; i < leaves.length; i++) {
      const proof = merkleProof(levels, i);
      expect(rootFromProof(leaves[i], proof)).toBe(root);
    }
  });

  it('rejects an inclusion proof against the wrong root', () => {
    const { levels } = buildMerkle(['a', 'b', 'c'].map((s) => s.repeat(8)));
    const proof = merkleProof(levels, 0);
    expect(rootFromProof('z'.repeat(8), proof)).not.toBe('a'.repeat(8));
  });

  it('summarizes ledger events into signed counts', () => {
    const entries = [entry(0, 'tool.call'), entry(1, 'tool.call'), entry(2, 'risk.detected'), entry(3, 'approval.requested')];
    const s = summarize(entries);
    expect(s.toolCalls).toBe(2);
    expect(s.riskFindings).toBe(1);
    expect(s.approvalsRequested).toBe(1);
    expect(s.events).toBe(4);
  });

  it('builds + verifies a signed passport', () => {
    const entries = [entry(0, 'tool.call'), entry(1, 'risk.detected')];
    const { passport } = buildPassport('agent', entries, (m) => ks.sign('agent', m));
    expect(verifyPassport(passport).ok).toBe(true);
  });

  it('rejects a passport whose summary was inflated after signing', () => {
    const { passport } = buildPassport('agent', [entry(0, 'tool.call')], (m) => ks.sign('agent', m));
    passport.summary.toolCalls = 999;
    expect(verifyPassport(passport).ok).toBe(false);
  });

  it('selectively reveals one leaf and verifies it against the signed root', () => {
    const entries = [entry(0, 'tool.call'), entry(1, 'tool.call'), entry(2, 'risk.detected')];
    const artifact = buildPassport('agent', entries, (m) => ks.sign('agent', m));
    const reveal = revealLeaf(artifact, 1, 'disclosed content');
    expect(verifyReveal(artifact.passport, reveal)).toBe(true);
    // a forged leaf does not verify
    expect(verifyReveal(artifact.passport, { ...reveal, leafHash: 'f'.repeat(64) })).toBe(false);
  });

  it('rejects a passport signed by a different agent than it claims', () => {
    ks.ensure('other');
    const artifact = buildPassport('agent', [entry(0, 'tool.call')], (m) => ks.sign('other', m));
    const v = verifyPassport(artifact.passport);
    expect(v.ok).toBe(false);
    expect(v.reason).toMatch(/different agent/);
  });
});

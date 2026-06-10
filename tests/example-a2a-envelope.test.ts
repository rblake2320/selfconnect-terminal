import { describe, it, expect } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
// @ts-expect-error — examples/ is plain ESM JS, not part of the typed src graph.
import { buildEnvelope, hashEnvelope, canonical, BPC_GENESIS } from '../examples/a2a-send-to-selfconnect.mjs';
import {
  hashEnvelope as daemonHashEnvelope,
  verifyEnvelope,
  verifyChain,
  BPC_GENESIS as DAEMON_GENESIS,
} from '../src/daemon/adapters/bpc-envelope';
import { A2aManager } from '../src/daemon/a2a-manager';
import { FileTskTransport } from '../src/daemon/adapters/tsk-transport';

/**
 * Proves the standalone example (examples/a2a-send-to-selfconnect.mjs) produces
 * envelopes the real daemon accepts. If the canonical/seal logic ever drifts in
 * src/, this test fails — keeping the doc's runnable example honest.
 */
describe('examples/a2a-send-to-selfconnect.mjs', () => {
  it('uses the same genesis hash as the daemon', () => {
    expect(BPC_GENESIS).toBe(DAEMON_GENESIS);
  });

  it('computes the identical canonical hash as the daemon', () => {
    const base = {
      bpc: '1.0' as const,
      id: 'bpc_fixed',
      from: { sessionId: 's', runId: 'r', agentId: 'claude-code' },
      to: 'system',
      ts: 1700000000000,
      kind: 'msg' as const,
      payload: 'hello',
      prevHash: BPC_GENESIS,
    };
    expect(hashEnvelope(base)).toBe(daemonHashEnvelope(base));
    // canonical() must serialize the exact 8 keys in order.
    expect(canonical(base)).toBe(
      JSON.stringify({
        bpc: '1.0',
        id: 'bpc_fixed',
        from: base.from,
        to: 'system',
        ts: 1700000000000,
        kind: 'msg',
        payload: 'hello',
        prevHash: BPC_GENESIS,
      }),
    );
  });

  it('produces an envelope the daemon verifyEnvelope accepts', () => {
    const env = buildEnvelope({ peerId: 'claude-code', to: 'system', text: 'hi', ts: 123 });
    expect(verifyEnvelope(env)).toBe(true);
  });

  it('chains so verifyChain passes for a two-envelope peer chain', () => {
    const first = buildEnvelope({ peerId: 'claude-code', to: 'system', text: 'one', ts: 1 });
    const second = buildEnvelope({
      peerId: 'claude-code',
      to: 'system',
      text: 'two',
      ts: 2,
      prevHash: first.hash,
    });
    expect(verifyChain([first, second]).ok).toBe(true);
  });

  it('is ingested by the daemon and keyed by from.agentId as the peer', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'sc-a2a-'));
    const transport = new FileTskTransport(dir);
    await transport.start();
    const mgr = new A2aManager({ mode: 'file', dir, wsPort: 0, allowlist: [] });
    mgr.setTransport(transport);

    const env = buildEnvelope({ peerId: 'claude-code', to: 'system', text: 'hello', ts: 5 });
    transport.deliverToSelf(env);

    const { received, findings } = await mgr.poll();
    expect(received).toHaveLength(1);
    expect(findings).toHaveLength(0); // valid single-envelope chain, no signature
    expect(mgr.peerList().map((p) => p.peer)).toContain('claude-code');
  });
});

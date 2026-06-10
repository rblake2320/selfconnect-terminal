import { describe, it, expect, beforeEach } from 'vitest';
import { A2aManager } from '../src/daemon/a2a-manager';
import { InMemoryTskTransport } from '../src/daemon/adapters/tsk-transport';
import { sealEnvelope, BPC_GENESIS } from '../src/daemon/adapters/bpc-envelope';
import type { Identity } from '../src/shared/contracts';

const from: Identity = { sessionId: 's', runId: 'r', agentId: 'agent_shell' };

function makeManager(allowlist: string[]) {
  const mgr = new A2aManager({ mode: 'file', dir: '/tmp/unused', wsPort: 0, allowlist });
  const transport = new InMemoryTskTransport();
  mgr.setTransport(transport);
  return { mgr, transport };
}

describe('A2aManager governance', () => {
  let mgr: A2aManager;
  let transport: InMemoryTskTransport;

  beforeEach(() => {
    ({ mgr, transport } = makeManager(['researcher']));
  });

  it('ALWAYS redacts the outbound payload', async () => {
    const secret = 'my api key is sk-ABCDEFGHIJKLMNOPQRSTUVWX and AWS_SECRET=topsecretvalue';
    const { envelope, redactions } = await mgr.send(from, 'researcher', 'msg', secret);
    expect(redactions).toBeGreaterThan(0);
    expect(String(envelope.payload)).not.toContain('sk-ABCDEFGHIJKLMNOPQRSTUVWX');
    expect(String(envelope.payload)).not.toContain('topsecretvalue');
    // The transport saw the redacted envelope, never the raw secret.
    const sent = transport.drainOutbox();
    expect(sent).toHaveLength(1);
    expect(String(sent[0].payload)).not.toContain('topsecretvalue');
  });

  it('does NOT require approval for an allowlisted msg', () => {
    expect(mgr.requiresApproval('researcher', 'msg')).toBe(false);
  });

  it('requires approval for a non-allowlisted peer', () => {
    expect(mgr.requiresApproval('stranger', 'msg')).toBe(true);
  });

  it('requires approval for ANY handoff, even allowlisted', () => {
    expect(mgr.requiresApproval('researcher', 'handoff')).toBe(true);
  });

  it('maintains a per-peer outbound hash chain', async () => {
    await mgr.send(from, 'researcher', 'msg', 'one');
    const { envelope: second } = await mgr.send(from, 'researcher', 'msg', 'two');
    expect(second.prevHash).not.toBe(BPC_GENESIS);
  });

  it('flags a broken inbound chain with a HIGH finding', async () => {
    const peer: Identity = { sessionId: 's2', runId: 'r2', agentId: 'evil' };
    const good = sealEnvelope({ from: peer, to: 'me', kind: 'msg', payload: 'a', prevHash: BPC_GENESIS });
    // Second envelope with a bogus prevHash => chain break.
    const bad = sealEnvelope({ from: peer, to: 'me', kind: 'msg', payload: 'b', prevHash: 'f'.repeat(64) });
    transport.inject(good);
    transport.inject(bad);
    const { received, findings } = await mgr.poll();
    expect(received).toHaveLength(2);
    expect(findings).toHaveLength(1);
    expect(findings[0].severity).toBe('high');
  });
});

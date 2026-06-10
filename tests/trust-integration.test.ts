import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SelfConnectClient } from '../src/sdk/index';
import type { DaemonConfig } from '../src/sdk/index';
import { verifySignature } from '../src/daemon/agent-keys';

function tempConfig(dir: string): Partial<DaemonConfig> {
  return {
    localOnly: true,
    ledgerPath: join(dir, 'ledger.jsonl'),
    sessionsDir: join(dir, 'sessions'),
    a2aMode: 'off',
    a2aDir: join(dir, 'a2a'),
    a2aAllowlist: ['researcher'],
    mcpConfigPath: join(dir, 'mcp.json'),
    checkpointsDir: join(dir, 'checkpoints'),
    hooksPath: join(dir, 'hooks.json'),
    keysDir: join(dir, 'keys'),
    checkpointsLedgerPath: join(dir, 'cp.jsonl'),
    delegationsPath: join(dir, 'deleg.jsonl'),
  };
}

describe('Trust layer integration (daemon)', () => {
  let dir: string;
  let client: SelfConnectClient;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'sc-trust-'));
    client = new SelfConnectClient({ config: tempConfig(dir), cwd: dir });
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('mints a human-rooted system grant at session start', () => {
    const grants = client.daemon.listGrants();
    const root = grants.find((g) => g.parent === null);
    expect(root).toBeTruthy();
    expect(root!.issuer).toBe('human');
    expect(root!.humanApproved).toBe(true);
    expect(client.daemon.verifyGrant(root!.hash).ok).toBe(true);
  });

  it('allows a system-agent tool call (covered by the root grant)', async () => {
    const res = await client.daemon.tools.invoke('ledger_verify', {}, 'system');
    expect(res.blocked).toBeUndefined();
  });

  it('refuses a tool call for an agent with no delegation chain', async () => {
    const res = await client.daemon.tools.invoke('ledger_verify', {}, 'agent_unauthorized_xyz');
    expect(res.blocked).toBe(true);
    expect(res.blockReason).toMatch(/delegation refused/);
  });

  it('honors a scoped sub-grant: in-scope allowed, out-of-scope refused', async () => {
    client.daemon.delegate({ grantee: 'agent_worker', tools: ['ledger_verify'] });
    const ok = await client.daemon.tools.invoke('ledger_verify', {}, 'agent_worker');
    expect(ok.blocked).toBeUndefined();
    const bad = await client.daemon.tools.invoke('read_file', { path: 'x' }, 'agent_worker');
    expect(bad.blocked).toBe(true);
    expect(bad.blockReason).toMatch(/delegation refused/);
  });

  it('records a delegation.denied event on refusal', async () => {
    const events: string[] = [];
    client.onEvent((e) => events.push(e.type));
    await client.daemon.tools.invoke('ledger_verify', {}, 'agent_unauthorized_xyz');
    expect(events).toContain('delegation.denied');
  });

  it('signs outbound A2A envelopes with a verifiable system signature', async () => {
    const result = await client.daemon.a2a.send(
      client.daemon.stamp('system'),
      'researcher',
      'msg',
      'hello peer',
    );
    expect(result.envelope.signature).toBeTruthy();
    expect(verifySignature(result.envelope.hash, result.envelope.signature!)).toBe(true);
  });

  it('verifies the ledger chain AND checkpoint signatures together', () => {
    client.daemon.sealCheckpoint();
    const v = client.daemon.verifyLedgerFull();
    expect(v.chainOk).toBe(true);
    expect(v.checkpointsOk).toBe(true);
    expect(v.checkpoints).toBeGreaterThan(0);
  });

  it('per-agent metering accrues and is recorded', () => {
    client.daemon.meterAgent('agent_worker', { toolCalls: 1, spendUsd: 0.01 });
    client.daemon.meterAgent('agent_worker', { toolCalls: 2, inputTokens: 100 });
    const rec = client.daemon.cost.meteringFor('agent_worker');
    expect(rec.toolCalls).toBe(3);
    expect(rec.spendUsd).toBeCloseTo(0.01);
    expect(rec.inputTokens).toBe(100);
  });
});

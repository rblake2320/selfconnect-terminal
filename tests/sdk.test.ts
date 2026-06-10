import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SelfConnectClient } from '../src/sdk/index';
import type { DaemonConfig } from '../src/sdk/index';

function tempConfig(dir: string): Partial<DaemonConfig> {
  return {
    localOnly: true,
    ledgerPath: join(dir, 'ledger.jsonl'),
    sessionsDir: join(dir, 'sessions'),
    a2aMode: 'off',
    a2aDir: join(dir, 'a2a'),
    a2aAllowlist: ['researcher'],
    mcpConfigPath: join(dir, 'mcp-servers.json'),
    checkpointsDir: join(dir, 'checkpoints'),
    hooksPath: join(dir, 'hooks.json'),
  };
}

describe('SelfConnectClient SDK', () => {
  let dir: string;
  let client: SelfConnectClient;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'sc-sdk-'));
    client = new SelfConnectClient({ config: tempConfig(dir), cwd: dir });
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('exposes a governed UI state snapshot', () => {
    const s = client.state();
    expect(s.permissionMode).toBe('auto');
    expect(s.identity.sessionId).toBeTruthy();
    expect(Array.isArray(s.agents)).toBe(true);
  });

  it('lists the governed tool surface (read + write tools)', () => {
    const names = client.listTools().map((t) => t.name);
    expect(names).toContain('read_file');
    expect(names).toContain('bash');
    expect(names).toContain('ledger_verify');
  });

  it('verifies an intact ledger chain', () => {
    const status = client.verifyLedger();
    expect(status.ok).toBe(true);
    expect(status.entries).toBeGreaterThan(0);
  });

  it('round-trips permission mode through the daemon', () => {
    client.setPermissionMode('plan');
    expect(client.getPermissionMode()).toBe('plan');
  });

  it('persists and reads todos', () => {
    client.writeTodos([{ content: 'ship v2', status: 'in_progress' }]);
    const todos = client.todos();
    expect(todos).toHaveLength(1);
    expect(todos[0].content).toBe('ship v2');
  });

  it('emits identity-stamped events on the bus', async () => {
    const seen: string[] = [];
    const off = client.onEvent((e) => seen.push(e.type));
    await client.slash('/cost');
    off();
    expect(seen).toContain('command.slash');
  });

  it('runs a read-only tool through invokeTool', async () => {
    const target = join(dir, 'hello.txt');
    writeFileSync(target, 'abc', 'utf8');
    const res = await client.invokeTool('read_file', { path: target }, 'shell');
    expect(res.ok).toBe(true);
    expect(res.output).toContain('abc');
  });

  it('blocks a mutating tool in plan mode via the SDK', async () => {
    client.setPermissionMode('plan');
    const res = await client.invokeTool('write_file', { path: join(dir, 'x'), content: 'y' });
    expect(res.blocked).toBe(true);
  });

  it('persists a session snapshot that can be listed and resumed', () => {
    client.daemon.persistSnapshot();
    const sessions = client.listSessions();
    expect(sessions.length).toBeGreaterThan(0);
    const sid = sessions[0].sessionId;
    const resumed = client.resume(sid);
    expect(resumed.ok).toBe(true);
  });
});

describe('slash dispatch via SDK', () => {
  let dir: string;
  let client: SelfConnectClient;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'sc-slash-'));
    client = new SelfConnectClient({ config: tempConfig(dir), cwd: dir });
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('/help lists available commands', async () => {
    const r = await client.slash('/help');
    expect(r.ok).toBe(true);
    expect(r.output).toMatch(/sessions/);
    expect(r.output).toMatch(/verify/);
  });

  it('/cost reports spend', async () => {
    const r = await client.slash('/cost');
    expect(r.ok).toBe(true);
  });

  it('/verify confirms the ledger', async () => {
    const r = await client.slash('/verify');
    expect(r.ok).toBe(true);
  });

  it('an unknown command fails with a hint and is still audited', async () => {
    const seen: string[] = [];
    const off = client.onEvent((e) => {
      if (e.type === 'command.slash') seen.push(JSON.stringify(e.payload));
    });
    const r = await client.slash('/definitely-not-a-command');
    off();
    expect(r.ok).toBe(false);
    expect(r.output.toLowerCase()).toMatch(/unknown|help/);
    expect(seen.length).toBe(1);
    expect(seen[0]).toMatch(/"ok":false/);
  });

  it('/clear signals a terminal clear', async () => {
    const r = await client.slash('/clear');
    expect(r.clear).toBe(true);
  });

  it('audits the command name but never the raw args', async () => {
    const payloads: unknown[] = [];
    const off = client.onEvent((e) => {
      if (e.type === 'command.slash') payloads.push(e.payload);
    });
    await client.slash('/redact-test my secret AWS_SECRET=topsecretvalue');
    off();
    const text = JSON.stringify(payloads);
    expect(text).toContain('redact-test');
    expect(text).not.toContain('topsecretvalue');
  });
});

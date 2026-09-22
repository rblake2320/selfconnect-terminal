/**
 * SCT partner lane, part 3: outbound honesty + plan-mode Lab verify + saved history.
 *   - Lab verify command must not create a sentinel in plan mode (audit failure)
 *   - A2A WebSocket send must fail loudly (was a silent no-op)
 *   - web_fetch HTTP / connection failures must be ok:false, not text
 *   - web_search must refuse under local-only and without a search URL
 *   - sessionHistory is a pure read: same scrollback as saved, no identity change,
 *     missing or damaged snapshots throw
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SelfConnectClient } from '../src/sdk/index';
import type { DaemonConfig } from '../src/sdk/index';

function tempConfig(dir: string, extra: Partial<DaemonConfig> = {}): Partial<DaemonConfig> {
  return {
    localOnly: true,
    ledgerPath: join(dir, 'ledger.jsonl'),
    sessionsDir: join(dir, 'sessions'),
    a2aMode: 'off',
    a2aDir: join(dir, 'a2a'),
    a2aAllowlist: ['peer'],
    mcpConfigPath: join(dir, 'mcp.json'),
    checkpointsDir: join(dir, 'checkpoints'),
    hooksPath: join(dir, 'hooks.json'),
    keysDir: join(dir, 'keys'),
    checkpointsLedgerPath: join(dir, 'cp.jsonl'),
    delegationsPath: join(dir, 'deleg.jsonl'),
    contextStoreDir: join(dir, 'context-store'),
    scratchpadPath: join(dir, 'scratchpad.json'),
    jevApiKey: '',
    jevKeyFile: join(dir, 'no-jev-key.dpapi'),
    searchApiUrl: '',
    ...extra,
  };
}

/** Invoke a tool and grant any approval it raises, like a human at the panel. */
async function invokeApproved(client: SelfConnectClient, name: string, input: unknown) {
  const pending = client.invokeTool(name, input, 'shell');
  const deadline = Date.now() + 4000;
  while (Date.now() < deadline) {
    const open = client.state().approvals.filter((a) => a.status === 'pending');
    if (open.length) {
      for (const a of open) client.decideApproval(a.id, true);
      break;
    }
    await new Promise((r) => setTimeout(r, 25));
  }
  return pending;
}

function listen(server: Server): Promise<number> {
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      resolve(typeof addr === 'object' && addr ? addr.port : 0);
    });
  });
}

describe('sct-partner: plan mode governs the Lab verifier', () => {
  let dir: string;
  let client: SelfConnectClient;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'sct-lab-'));
    client = new SelfConnectClient({ config: tempConfig(dir), cwd: dir });
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('a verify command cannot create a sentinel in plan mode and raises no approval', async () => {
    client.setPermissionMode('plan');
    const sentinel = join(dir, 'plan-mode-write');
    const probe = join(dir, 'probe.txt');
    writeFileSync(probe, 'probe', 'utf8');
    const verify = process.platform === 'win32' ? `echo x>"${sentinel}"` : `echo x > "${sentinel}"`;

    const report = await client.runLab({
      name: 'plan-verify',
      prompt: '',
      steps: [{ tool: 'read_file', input: { path: probe } }],
      arms: [{ name: 'only', tools: ['read_file', 'bash'] }],
      verify,
    });

    expect(existsSync(sentinel)).toBe(false);
    expect(report.scores).toHaveLength(1);
    expect(report.scores[0].verifyExitCode).not.toBe(0);
    expect(report.scores[0].success).toBe(false);
    expect(client.state().approvals.filter((a) => a.status === 'pending')).toHaveLength(0);
    expect(client.getPermissionMode()).toBe('plan');
  }, 15000);

  it('an arm-level permissionMode of plan is also honored for the verify command', async () => {
    client.setPermissionMode('auto');
    const sentinel = join(dir, 'arm-plan-write');
    const probe = join(dir, 'probe.txt');
    writeFileSync(probe, 'probe', 'utf8');
    const verify = process.platform === 'win32' ? `echo x>"${sentinel}"` : `echo x > "${sentinel}"`;

    const report = await client.runLab({
      name: 'arm-plan-verify',
      prompt: '',
      steps: [{ tool: 'read_file', input: { path: probe } }],
      arms: [{ name: 'planned', tools: ['read_file', 'bash'], permissionMode: 'plan' }],
      verify,
    });

    expect(existsSync(sentinel)).toBe(false);
    expect(report.scores[0].verifyExitCode).not.toBe(0);
    expect(client.getPermissionMode()).toBe('auto');
  }, 15000);
});

describe('sct-partner: outbound calls fail honestly', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'sct-out-'));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('A2A over WebSocket rejects instead of silently dropping the message', async () => {
    const client = new SelfConnectClient({ config: tempConfig(dir, { a2aMode: 'ws', a2aWsPort: 0 }), cwd: dir });
    await expect(client.daemon.a2aSend('peer', 'hello')).rejects.toThrow(/No message was sent|not configured/i);
  });

  it('web_fetch reports an HTTP failure as ok:false with the status', async () => {
    const server = createServer((_req, res) => {
      res.statusCode = 500;
      res.end('boom');
    });
    const port = await listen(server);
    try {
      const client = new SelfConnectClient({ config: tempConfig(dir), cwd: dir });
      const res = await client.invokeTool('web_fetch', { url: `http://127.0.0.1:${port}/x` }, 'shell');
      expect(res.ok).toBe(false);
      expect(res.error).toMatch(/web_fetch failed: HTTP 500/);
      expect(res.output).toBe('');
    } finally {
      server.close();
    }
  });

  it('web_fetch reports a refused connection as ok:false', async () => {
    const server = createServer((_req, res) => res.end('x'));
    const port = await listen(server);
    await new Promise<void>((r) => server.close(() => r()));
    const client = new SelfConnectClient({ config: tempConfig(dir), cwd: dir });
    const res = await client.invokeTool('web_fetch', { url: `http://127.0.0.1:${port}/closed` }, 'shell');
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/web_fetch failed/);
  });

  it('web_fetch returns real body text on success', async () => {
    const server = createServer((_req, res) => res.end('sct-partner-body'));
    const port = await listen(server);
    try {
      const client = new SelfConnectClient({ config: tempConfig(dir), cwd: dir });
      const res = await client.invokeTool('web_fetch', { url: `http://127.0.0.1:${port}/ok` }, 'shell');
      expect(res.ok).toBe(true);
      expect(res.output).toContain('sct-partner-body');
    } finally {
      server.close();
    }
  });

  it('web_search is refused under local-only, before any HTTP', async () => {
    const client = new SelfConnectClient({ config: tempConfig(dir, { searchApiUrl: 'http://127.0.0.1:9/never' }), cwd: dir });
    const res = await invokeApproved(client, 'web_search', { query: 'anything' });
    expect(res.ok).toBe(false);
    expect(res.error ?? res.blockReason).toMatch(/local-only/i);
  }, 15000);

  it('web_search without a configured search URL is an error, not a fake result', async () => {
    const client = new SelfConnectClient({ config: tempConfig(dir, { localOnly: false, searchApiUrl: '' }), cwd: dir });
    const res = await invokeApproved(client, 'web_search', { query: 'anything' });
    expect(res.ok).toBe(false);
    expect(res.error ?? res.blockReason).toMatch(/SEARCH_API_URL|blocked/i);
  }, 15000);
});

describe('sct-partner: saved history is a pure read', () => {
  let dir: string;
  let client: SelfConnectClient;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'sct-hist-'));
    client = new SelfConnectClient({ config: tempConfig(dir), cwd: dir });
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('returns exactly the saved scrollback and changes no daemon identity or mode', () => {
    client.daemon.ingestTerminalOutput('$ echo one\r\none\r\n$ echo two\r\ntwo\r\n');
    client.setPermissionMode('ask');
    client.daemon.persistSnapshot();
    const sid = client.state().identity.sessionId;
    const before = client.state();

    const hist = client.daemon.sessionHistory(sid);
    expect(hist.sessionId).toBe(sid);
    expect(hist.capturedAt).toBeGreaterThan(0);
    expect(hist.scrollback.join('\n')).toContain('one');
    expect(hist.scrollback.join('\n')).toContain('two');

    const after = client.state();
    expect(after.identity.sessionId).toBe(before.identity.sessionId);
    expect(after.identity.agentId).toBe(before.identity.agentId);
    expect(after.permissionMode).toBe('ask');
    expect(after.ledger.entries).toBe(before.ledger.entries); // no session.resumed recorded
    expect(client.daemon.replayEvents().map((e) => e.type)).not.toContain('session.resumed');
  });

  it('reads another session from disk without switching to it', () => {
    client.daemon.ingestTerminalOutput('first-session-output\r\n');
    client.daemon.persistSnapshot();
    const first = client.state().identity.sessionId;

    const second = new SelfConnectClient({ config: tempConfig(dir), cwd: dir });
    const sidSecond = second.state().identity.sessionId;
    expect(sidSecond).not.toBe(first);
    const hist = second.daemon.sessionHistory(first);
    expect(hist.scrollback.join('\n')).toContain('first-session-output');
    expect(second.state().identity.sessionId).toBe(sidSecond);
  });

  it('throws for an unknown id and for a damaged snapshot file', () => {
    expect(() => client.daemon.sessionHistory('no-such-session')).toThrow(/missing or damaged/i);
    client.daemon.persistSnapshot();
    const files = readdirSync(join(dir, 'sessions')).filter((f) => f.endsWith('.json'));
    expect(files.length).toBeGreaterThan(0);
    writeFileSync(join(dir, 'sessions', files[0]), '{"version":3,"broken":', 'utf8');
    expect(() => client.daemon.sessionHistory(client.state().identity.sessionId)).toThrow(/missing or damaged/i);
  });
});

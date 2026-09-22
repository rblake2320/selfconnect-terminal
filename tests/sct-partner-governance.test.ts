/**
 * SCT partner regression lane (independent of the daemon author).
 * Real filesystem, real shell, real ledger files. No mocked providers except a
 * substituted `anthropic.complete` spy that MUST never be reached.
 *
 * Covers the REALITY_AUDIT.md failures:
 *   - missing-file read must be ok:false
 *   - plan mode must block mutations even through the SDK/registry path
 *   - ledger corruption must block governed writes and Jev
 *   - signed replay must verify after another session + resume (continuity)
 *   - real shell errors must surface as errors, not ok:true
 *   - local-only must block a forced cloud consult before any provider call
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SelfConnectClient } from '../src/sdk/index';
import type { DaemonConfig } from '../src/sdk/index';
import { verifyReplayBundle } from '../src/daemon/replay';
import { runShellCommand } from '../src/daemon/shell-executor';

function tempConfig(dir: string, extra: Partial<DaemonConfig> = {}): Partial<DaemonConfig> {
  return {
    localOnly: true,
    ledgerPath: join(dir, 'ledger.jsonl'),
    sessionsDir: join(dir, 'sessions'),
    a2aMode: 'off',
    a2aDir: join(dir, 'a2a'),
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
    ...extra,
  };
}

describe('sct-partner: governance gates', () => {
  let dir: string;
  let client: SelfConnectClient;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'sct-gov-'));
    client = new SelfConnectClient({ config: tempConfig(dir), cwd: dir });
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('missing-file read is ok:false with an error, not a success carrying an error string', async () => {
    const res = await client.invokeTool('read_file', { path: join(dir, 'does-not-exist.txt') }, 'shell');
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/no such file/);
    expect(res.output).toBe('');
  });

  it('plan mode blocks write_file through the SDK and leaves no bytes on disk', async () => {
    client.setPermissionMode('plan');
    const target = join(dir, 'plan-mode-write.txt');
    const res = await client.invokeTool('write_file', { path: target, content: 'must not land' }, 'shell');
    expect(res.ok).toBe(false);
    expect(res.blocked).toBe(true);
    expect(existsSync(target)).toBe(false);
  });

  it('plan mode still allows a read of a real file', async () => {
    client.setPermissionMode('plan');
    const target = join(dir, 'readable.txt');
    writeFileSync(target, 'readable-bytes', 'utf8');
    const res = await client.invokeTool('read_file', { path: target }, 'shell');
    expect(res.ok).toBe(true);
    expect(res.output).toContain('readable-bytes');
  });

  it('a corrupted ledger file blocks governed writes in a fresh daemon and keeps the disk unchanged', async () => {
    // Put real events on disk, then tamper one payload on disk.
    await client.invokeTool('write_file', { path: join(dir, 'seed.txt'), content: 'seed' }, 'shell');
    const ledgerPath = join(dir, 'ledger.jsonl');
    const lines = readFileSync(ledgerPath, 'utf8').trimEnd().split('\n');
    expect(lines.length).toBeGreaterThan(2);
    const idx = 1;
    const entry = JSON.parse(lines[idx]) as { payload: Record<string, unknown> };
    entry.payload = { ...entry.payload, tampered: true };
    lines[idx] = JSON.stringify(entry);
    writeFileSync(ledgerPath, lines.join('\n') + '\n', 'utf8');

    const reopened = new SelfConnectClient({ config: tempConfig(dir), cwd: dir });
    const status = reopened.verifyLedger();
    expect(status.ok).toBe(false);
    expect(status.brokenAt).not.toBeNull();

    const target = join(dir, 'after-corruption.txt');
    const res = await reopened.invokeTool('write_file', { path: target, content: 'must not land' }, 'shell');
    expect(res.ok).toBe(false);
    expect(res.blocked).toBe(true);
    expect(res.blockReason).toMatch(/integrity/i);
    expect(existsSync(target)).toBe(false);

    // Jev transmission is also refused on a broken chain, before any network.
    reopened.daemon.ingestTerminalOutput('$ echo x\r\nx\r\n');
    const snap = reopened.daemon.previewJev();
    await expect(reopened.daemon.analyzeJev(snap.id, true)).rejects.toThrow(/integrity/i);
  });

  it('signed replay stays verifiable after a second session and a resume (continuity)', () => {
    // Session A: some events + checkpoint, persisted.
    const a = client;
    a.writeTodos([{ content: 'a-1', status: 'pending' }]);
    a.daemon.sealCheckpoint();
    const sidA = a.state().identity.sessionId;
    a.daemon.persistSnapshot();

    // Session B on the SAME ledger file interleaves events after A's.
    const b = new SelfConnectClient({ config: tempConfig(dir), cwd: dir });
    b.writeTodos([{ content: 'b-1', status: 'pending' }]);
    b.daemon.sealCheckpoint();
    expect(b.state().identity.sessionId).not.toBe(sidA);

    // Resume A in a third daemon; more A events land after B's.
    const c = new SelfConnectClient({ config: tempConfig(dir), cwd: dir });
    const resumed = c.resume(sidA);
    expect(resumed.ok).toBe(true);
    c.writeTodos([{ content: 'a-2', status: 'pending' }]);
    c.daemon.sealCheckpoint();

    const bundle = c.daemon.exportReplay(sidA);
    const v = verifyReplayBundle(bundle);
    expect(v.ok, v.reason).toBe(true);
    expect(v.brokenAt).toBeNull();
    // The bundle carries a contiguous seq range (interleaved B events included).
    for (let i = 1; i < bundle.events.length; i++) {
      expect(bundle.events[i].seq).toBe(bundle.events[i - 1].seq + 1);
    }
    expect(bundle.events.some((e) => e.sessionId === sidA)).toBe(true);
    expect(c.verifyLedger().ok).toBe(true);
  });

  it('local-only blocks a forced cloud consult before any provider call is made', async () => {
    const withKey = new SelfConnectClient({ config: tempConfig(dir, { anthropicApiKey: 'sk-test-not-real' }), cwd: dir });
    expect(withKey.state().localOnly).toBe(true);
    const anthropic = withKey.daemon.registry.get('anthropic');
    let calls = 0;
    (anthropic as unknown as { complete: unknown }).complete = async () => {
      calls++;
      return { text: 'should never run', inputTokens: 1, outputTokens: 1 };
    };
    const res = await withKey.consult({ question: 'is this safe?', provider: 'anthropic' });
    expect(res.ok).toBe(false);
    expect(res.blocked).toBe(true);
    expect(res.blockReason).toMatch(/LOCAL_ONLY/);
    expect(calls).toBe(0);
  });
});

/** Invoke a high-risk tool and approve its pending request like a human would (auto mode still gates high risk). */
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

describe('sct-partner: real shell errors', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'sct-sh-'));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('a missing command rejects with a non-zero exit and its stderr', async () => {
    await expect(runShellCommand('definitely-not-a-command-xyz 2>&1', dir, 15000)).rejects.toThrow(/Shell exited/);
  });

  it('a successful command resolves with its real output', async () => {
    const out = await runShellCommand('echo sct-partner-ok', dir, 15000);
    expect(out).toContain('sct-partner-ok');
  });

  it('a slow command is killed at the timeout and reported as such', async () => {
    const cmd = process.platform === 'win32' ? 'ping -n 6 127.0.0.1 >nul' : 'sleep 5';
    await expect(runShellCommand(cmd, dir, 800)).rejects.toThrow(/timed out/);
  }, 15000);

  it('the governed bash tool surfaces a failing command as ok:false (audit: bash queued)', async () => {
    const client = new SelfConnectClient({ config: tempConfig(dir), cwd: dir });
    const res = await invokeApproved(client, 'bash', { command: 'definitely-not-a-command-xyz 2>&1' });
    expect(res.ok).toBe(false);
    expect(res.blocked).not.toBe(true);
    expect(res.error).toMatch(/Shell exited/);
  }, 20000);

  it('the governed bash tool really runs an approved command (audit: no sentinel file)', async () => {
    const client = new SelfConnectClient({ config: tempConfig(dir), cwd: dir });
    const sentinel = join(dir, 'sentinel.txt');
    const cmd = process.platform === 'win32' ? `echo sct>"${sentinel}"` : `echo sct > "${sentinel}"`;
    const res = await invokeApproved(client, 'bash', { command: cmd });
    expect(res.ok, res.error ?? res.blockReason).toBe(true);
    expect(res.output).not.toMatch(/queued/);
    expect(existsSync(sentinel)).toBe(true);
  }, 20000);
});

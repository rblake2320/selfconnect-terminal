/**
 * SCT partner Jev acceptance: the JevAssistant with a substituted fetch.
 * Nothing here touches the network, the DPAPI key file, or any workbook.
 */
import { describe, it, expect } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { JevAssistant, JEV_ENDPOINT, cleanJevText, jevHash } from '../src/daemon/jev';
import type { JevSnapshot } from '../src/shared/jev';
import { SelfConnectClient } from '../src/sdk/index';
import type { DaemonConfig } from '../src/sdk/index';

// Placeholder credential for the substituted fetch; shaped so secret scanners do not flag it.
const TEST_KEY = ['partner', 'placeholder', 'credential', '0001'].join('-');

function snap(text: string): JevSnapshot {
  return { id: 's1', sessionId: 'sess', capturedAt: Date.now(), text, hash: jevHash(text), redactions: 0, configured: true };
}
function assistant(request: typeof fetch, timeoutMs = 2000): JevAssistant {
  return new JevAssistant({ apiKey: TEST_KEY, keyFile: join(tmpdir(), 'never-there.dpapi'), model: 'jev-test', timeoutMs }, request);
}
function response(status: number, body: unknown): Response {
  return new Response(typeof body === 'string' ? body : JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}
const good = {
  model: 'jev-test',
  answers: {
    status: { type: 'choice', choice: 'error', confidence: 0.9, probabilities: { error: 0.9, waiting: 0.02, running: 0.02, success: 0.02, idle: 0.02, unknown: 0.02 } },
    action: { type: 'choice', choice: 'check_path', confidence: 0.8, probabilities: { check_path: 0.8, check_dependency: 0.05, check_connection: 0.05, review_failure: 0.04, answer_prompt: 0.02, verify_result: 0.02, wait: 0.01, inspect_more: 0.01 } },
  },
  usage: { input_tokens: 10, output_tokens: 5 },
};

describe('sct-partner: Jev assistant failure handling', () => {
  it('401 becomes a re-import message and no recommendation', async () => {
    let calls = 0;
    const jev = assistant(async () => { calls++; return response(401, { error: 'bad key' }); });
    await expect(jev.analyze(snap('$ ls\nls: cannot access x'), () => true)).rejects.toThrow(/authentication failed/i);
    expect(calls).toBe(1);
  });

  it('timeout aborts the request and says the terminal is still available', async () => {
    const jev = assistant((_url, init) => new Promise((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
    }), 100);
    await expect(jev.analyze(snap('$ npm test\nFAIL'), () => true)).rejects.toThrow(/timed out/i);
  });

  it('invalid schema is rejected and nothing is accepted', async () => {
    const jev = assistant(async () => response(200, { model: 'x', answers: { status: { nope: true } } }));
    await expect(jev.analyze(snap('$ x\nerror'), () => true)).rejects.toThrow(/invalid response/i);
  });

  it('unknown choice is rejected', async () => {
    const bad = JSON.parse(JSON.stringify(good)) as typeof good;
    bad.answers.status.choice = 'exploded';
    const jev = assistant(async () => response(200, bad));
    await expect(jev.analyze(snap('$ x\nerror'), () => true)).rejects.toThrow(/unknown or missing choices/i);
  });

  it('inconsistent probabilities are rejected', async () => {
    const bad = JSON.parse(JSON.stringify(good)) as typeof good;
    bad.answers.action.probabilities.check_path = 0.1; // sum no longer 1, chosen not max
    const jev = assistant(async () => response(200, bad));
    await expect(jev.analyze(snap('$ x\nerror'), () => true)).rejects.toThrow(/inconsistent probability/i);
  });

  it('invalid JSON is reported as such', async () => {
    const jev = assistant(async () => response(200, '{not json'));
    await expect(jev.analyze(snap('$ x\nerror'), () => true)).rejects.toThrow(/invalid JSON/i);
  });

  it('local-only prevents the call entirely (no fetch)', async () => {
    let calls = 0;
    const jev = assistant(async () => { calls++; return response(200, good); });
    await expect(jev.analyze(snap('$ x\nerror'), () => false)).rejects.toThrow(/local-only/i);
    expect(calls).toBe(0);
  });

  it('a snapshot containing the configured key never leaves the machine', async () => {
    let calls = 0;
    const jev = assistant(async () => { calls++; return response(200, good); });
    await expect(jev.analyze(snap(`token=${TEST_KEY}`), () => true)).rejects.toThrow(/credential/i);
    expect(calls).toBe(0);
  });

  it('a valid response posts only the excerpt to the endpoint and returns an advisory result', async () => {
    let seenUrl = '';
    let seenBody = '';
    const jev = assistant(async (url, init) => { seenUrl = String(url); seenBody = String(init?.body); return response(200, good); });
    const result = await jev.analyze(snap('$ cat missing.txt\ncat: missing.txt: No such file'), () => true);
    expect(seenUrl).toBe(JEV_ENDPOINT);
    expect(JSON.parse(seenBody).state.terminal_output).toContain('missing.txt');
    expect(result.status).toBe('error');
    expect(result.action).toBe('check_path');
    expect(result.uncertain).toBe(false);
    expect(result.cached).toBe(false);
  });

  it('cleanJevText strips ANSI and redacts a configured secret', () => {
    const { text, redactions } = cleanJevText('\x1b[31mred\x1b[0m key=supersecretvalue99', ['supersecretvalue99']);
    expect(text).not.toContain('\x1b');
    expect(text).toContain('[REDACTED:configured_key]');
    expect(redactions).toBeGreaterThanOrEqual(1);
  });
});

describe('sct-partner: daemon-level Jev gates (no execution, approved snapshot only)', () => {
  function tempConfig(dir: string): Partial<DaemonConfig> {
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
      jevApiKey: TEST_KEY,
      jevKeyFile: join(dir, 'never.dpapi'),
    };
  }

  it('refuses an unapproved snapshot, an unknown snapshot, and local-only, in that order', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'sct-jev-'));
    try {
      const client = new SelfConnectClient({ config: tempConfig(dir), cwd: dir });
      client.daemon.ingestTerminalOutput('$ npm test\r\nFAIL tests/x.test.ts\r\n');
      const snap = client.daemon.previewJev();
      expect(snap.configured).toBe(true);
      expect(snap.text).toContain('FAIL');
      await expect(client.daemon.analyzeJev(snap.id, false)).rejects.toThrow(/approve/i);
      await expect(client.daemon.analyzeJev('not-a-snapshot', true)).rejects.toThrow(/expired|session changed/i);
      // local-only is on by default: blocked before any network is attempted.
      await expect(client.daemon.analyzeJev(snap.id, true)).rejects.toThrow(/local-only/i);
      const types = client.daemon.replayEvents().map((e) => e.type);
      expect(types).not.toContain('jev.result');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

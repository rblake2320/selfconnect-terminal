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
    // Force the local path: ollama is the only configured provider, so consult
    // falls back to it (free, ungated) and no network/key is ever touched.
    anthropicApiKey: '',
    openaiCompatApiKey: '',
    openaiCompatUrl: '',
  };
}

describe('E7 consult (second opinion): gating, budget, redaction', () => {
  let dir: string;
  let client: SelfConnectClient;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'sc-consult-'));
    client = new SelfConnectClient({ config: tempConfig(dir), cwd: dir });
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('redacts the question + context and refuses when over budget', async () => {
    const secret = 'sk-ant-ABCDEFGHIJKLMNOPQRSTUVWX';
    const res = await client.consult({
      question: `Is it safe to commit ${secret}?`,
      contextRefs: [`token=${secret}`],
      budgetUsd: -1, // any estimate (>=0) exceeds a negative budget
    });
    expect(res.blocked).toBe(true);
    expect(res.blockReason).toMatch(/budget/);
    // redaction happened on the trusted side before any provider call
    expect(res.redactionCount).toBeGreaterThan(0);
    // the secret never appears in the returned critique
    expect(res.critique).not.toContain(secret);
  });

  it('audits consult.requested and consult.result with a redacted critique', async () => {
    // Stub the local provider so no network is touched.
    const local = client.daemon.registry.local();
    local.complete = async () => ({
      text: 'Looks risky; verify the migration. sk-ant-ABCDEFGHIJKLMNOPQRSTUVWX',
      inputTokens: 10,
      outputTokens: 12,
    });

    const res = await client.consult({ question: 'Review this plan' });
    expect(res.ok).toBe(true);
    // outbound critique is redacted before it re-enters context / ledger
    expect(res.critique).not.toContain('sk-ant-ABCDEFGHIJKLMNOPQRSTUVWX');
    expect(res.redactionCount).toBeGreaterThan(0);

    const types = client.daemon.ledger.all().map((e) => e.type);
    expect(types).toContain('consult.requested');
    expect(types).toContain('consult.result');

    // the ledger payload for consult.result must NOT embed the raw critique text
    const resultEntry = client.daemon.ledger
      .all()
      .find((e) => e.type === 'consult.result');
    expect(JSON.stringify(resultEntry?.payload)).not.toContain('Looks risky; verify the migration');
  });

  it('local-tier consult is free and ungated (cost 0, not blocked)', async () => {
    const local = client.daemon.registry.local();
    local.complete = async () => ({ text: 'fine', inputTokens: 1, outputTokens: 1 });
    const res = await client.consult({ question: 'cheap?' });
    expect(res.ok).toBe(true);
    expect(res.cost.costUsd).toBe(0);
    expect(res.provider).toBe('ollama');
  });
});

describe('D6 harness lab: arm isolation + ledger-derived scoring (stub tools)', () => {
  let dir: string;
  let client: SelfConnectClient;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'sc-lab-'));
    client = new SelfConnectClient({ config: tempConfig(dir), cwd: dir });
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('runs two arms sequentially in isolated runIds and scores each', async () => {
    const probe = join(dir, 'probe.txt');
    writeFileSync(probe, 'hello world', 'utf8');

    const report = await client.runLab({
      name: 'read-probe',
      prompt: '',
      steps: [{ tool: 'read_file', input: { path: probe } }],
      arms: [
        { name: 'baseline', tools: ['read_file'] },
        { name: 'restricted', tools: ['read_file'] },
      ],
    });

    expect(report.scores).toHaveLength(2);
    const [a, b] = report.scores;
    expect(a.arm).toBe('baseline');
    expect(b.arm).toBe('restricted');
    // distinct runIds => isolation
    expect(a.runId).not.toBe(b.runId);
    // one tool.call per arm
    expect(a.turns).toBe(1);
    expect(b.turns).toBe(1);
    expect(a.totalTokens).toBeGreaterThan(0);

    // each arm's tool events are stamped with that arm's runId in the ledger
    const callRuns = client.daemon.ledger
      .all()
      .filter((e) => e.type === 'tool.call')
      .map((e) => e.runId);
    expect(callRuns).toContain(a.runId);
    expect(callRuns).toContain(b.runId);

    // the run is recorded and retrievable for the renderer
    expect(client.daemon.latestLabReport()?.task).toBe('read-probe');
  });

  it('lab report re-scores a finished run purely from the session ledger', async () => {
    const probe = join(dir, 'p.txt');
    writeFileSync(probe, 'data', 'utf8');
    const live = await client.runLab({
      name: 'rescore-me',
      prompt: '',
      steps: [{ tool: 'read_file', input: { path: probe } }],
      arms: [{ name: 'only', tools: ['read_file'] }],
    });
    const sessionId = client.state().identity.sessionId;
    const rescored = client.reportLab(sessionId, 'rescore-me');
    expect(rescored.scores).toHaveLength(1);
    expect(rescored.scores[0].arm).toBe('only');
    expect(rescored.scores[0].turns).toBe(live.scores[0].turns);
  });

  it('renders a comparison table', async () => {
    const probe = join(dir, 'p.txt');
    writeFileSync(probe, 'x', 'utf8');
    const report = await client.runLab({
      name: 't',
      prompt: '',
      steps: [{ tool: 'read_file', input: { path: probe } }],
      arms: [{ name: 'a', tools: ['read_file'] }],
    });
    const table = client.renderLab(report);
    expect(table).toContain('a');
    expect(table).toContain('turns');
  });
});

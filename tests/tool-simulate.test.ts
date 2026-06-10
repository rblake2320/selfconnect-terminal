import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ToolRegistry } from '../src/daemon/tools/registry';
import { CheckpointStore } from '../src/daemon/tools/checkpoint-store';
import { HookEngine } from '../src/daemon/tools/hooks';
import type { ToolServices } from '../src/daemon/tools/types';
import type { SimulationPreview, PermissionMode } from '../src/shared/contracts';

function stubServices(cwd: string): ToolServices {
  return {
    cwd,
    runBash: async (command) => `ran: ${command}`,
    webFetch: async (url) => `fetched ${url}`,
    webSearch: async (q) => `searched ${q}`,
    spawnTask: async (p) => `task: ${p}`,
    askUser: async (q) => `answer to ${q}`,
    ledgerVerify: () => 'ledger ok',
    ledgerQuery: () => '[]',
    costReport: () => 'cost',
    redactText: (t) => t,
    reviewRequest: async (m) => `review ${m}`,
    a2aSend: async (peer, msg) => `sent ${msg} to ${peer}`,
    a2aPeers: () => '[]',
    sessionList: () => '[]',
    sessionResume: () => 'resumed',
    mcpCall: async () => 'mcp',
    todoWrite: () => 'todos set',
    todoRead: () => '[]',
    memoryRead: () => 'memory',
    memoryWrite: () => 'wrote memory',
    contextRequest: (query, source) => `ctx ${source}: ${query}`,
    scratchpadWrite: (key, value) => `wrote ${key}=${value}`,
    scratchpadRead: (query) => `scratch: ${query}`,
    introspect: () => '{}',
    metabolic: () => '{}',
    limits: () => '{}',
    crystallizePlaybook: () => 'crystallized',
    loadPlaybooks: (situation) => `playbooks: ${situation}`,
    recordFailure: () => 'recorded',
    delegateGrant: (input) => `granted ${input.grantee}`,
    grantsList: () => '[]',
    passportExport: () => '{}',
    evidenceExport: () => '{}',
    consult: async (input) => `consulted: ${input.question}`,
  };
}

function makeRegistry(dir: string, mode: PermissionMode = 'auto') {
  const audits: { type: string }[] = [];
  const checkpoints = new CheckpointStore(join(dir, 'ckpt'), 'sess_test');
  const registry = new ToolRegistry({
    checkpoints,
    hooks: new HookEngine(),
    services: stubServices(dir),
    stampFor: (agent) => ({ sessionId: 'sess_test', runId: 'run_1', agentId: `agent_${agent}` }),
    permissionMode: () => mode,
    audit: (type) => audits.push({ type }),
    requestApproval: async () => true,
  });
  return { registry, audits };
}

function parsePreview(output: string): SimulationPreview {
  return JSON.parse(output) as SimulationPreview;
}

describe('E5 dry-run: simulate every mutating tool without executing', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'sc-sim-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('write_file simulate previews a diff and touches no disk', async () => {
    const { registry, audits } = makeRegistry(dir);
    const target = join(dir, 'new.txt');
    const res = await registry.invoke('write_file', { path: target, content: 'hello' }, 'tool', undefined, {
      simulate: true,
    });
    expect(res.ok).toBe(true);
    const preview = parsePreview(res.output ?? '');
    expect(preview.tool).toBe('write_file');
    expect(preview.mutating).toBe(true);
    expect(preview.filesTouched).toContain(target);
    expect(preview.diff).toContain('hello');
    // nothing executed
    expect(existsSync(target)).toBe(false);
    // audited as tool.simulated, not tool.call
    expect(audits.some((a) => a.type === 'tool.simulated')).toBe(true);
    expect(audits.some((a) => a.type === 'tool.call')).toBe(false);
  });

  it('edit_file simulate previews edits against the current file, no write', async () => {
    const { registry } = makeRegistry(dir);
    const target = join(dir, 'edit.txt');
    writeFileSync(target, 'original', 'utf8');
    const res = await registry.invoke(
      'edit_file',
      { path: target, edits: [{ oldString: 'original', newString: 'changed' }] },
      'tool',
      undefined,
      { simulate: true },
    );
    const preview = parsePreview(res.output ?? '');
    expect(preview.summary).toMatch(/apply 1 edit/);
    expect(preview.diff).toContain('changed');
    // file unchanged
    const { readFileSync } = await import('node:fs');
    expect(readFileSync(target, 'utf8')).toBe('original');
  });

  it('bash simulate classifies command risk without running it', async () => {
    const { registry } = makeRegistry(dir);
    const res = await registry.invoke('bash', { command: 'rm -rf /' }, 'tool', undefined, {
      simulate: true,
    });
    const preview = parsePreview(res.output ?? '');
    expect(preview.summary).toMatch(/would run/);
    expect(preview.risk).toBeTruthy();
    expect(preview.riskReason).toBeTruthy();
  });

  it('simulate runs even in plan mode (no execution, so not blocked)', async () => {
    const { registry } = makeRegistry(dir, 'plan');
    const target = join(dir, 'p.txt');
    const res = await registry.invoke('write_file', { path: target, content: 'x' }, 'tool', undefined, {
      simulate: true,
    });
    expect(res.ok).toBe(true);
    expect(res.blocked).toBeFalsy();
    expect(existsSync(target)).toBe(false);
  });

  it('web_fetch simulate estimates a cost and flags network egress', async () => {
    const { registry } = makeRegistry(dir);
    const res = await registry.invoke('web_fetch', { url: 'https://example.com' }, 'tool', undefined, {
      simulate: true,
    });
    const preview = parsePreview(res.output ?? '');
    expect(preview.estimatedCostUsd).toBeGreaterThan(0);
    expect(preview.riskReason).toMatch(/egress/);
  });
});

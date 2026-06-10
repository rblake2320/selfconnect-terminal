import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ToolRegistry } from '../src/daemon/tools/registry';
import { CheckpointStore } from '../src/daemon/tools/checkpoint-store';
import { HookEngine } from '../src/daemon/tools/hooks';
import type { ToolServices } from '../src/daemon/tools/types';
import type { Identity, PermissionMode } from '../src/shared/contracts';

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
  };
}

interface AuditRecord {
  type: string;
  payload: unknown;
  identity: Identity;
}

function makeRegistry(opts: {
  mode?: PermissionMode;
  approve?: boolean;
  dir: string;
  hooks?: HookEngine;
}) {
  const audits: AuditRecord[] = [];
  const approvals: string[] = [];
  const checkpoints = new CheckpointStore(join(opts.dir, 'ckpt'), 'sess_test');
  const hooks = opts.hooks ?? new HookEngine();
  let mode: PermissionMode = opts.mode ?? 'auto';
  const registry = new ToolRegistry({
    checkpoints,
    hooks,
    services: stubServices(opts.dir),
    stampFor: (agent) => ({ sessionId: 'sess_test', runId: 'run_1', agentId: `agent_${agent}` }),
    permissionMode: () => mode,
    audit: (type, payload, identity) => audits.push({ type, payload, identity }),
    requestApproval: async (summary) => {
      approvals.push(summary);
      return opts.approve ?? false;
    },
  });
  return {
    registry,
    audits,
    approvals,
    checkpoints,
    setMode: (m: PermissionMode) => {
      mode = m;
    },
  };
}

describe('ToolRegistry governance', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'sc-tools-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('lists the full built-in tool surface', () => {
    const { registry } = makeRegistry({ dir });
    const names = registry.list().map((t) => t.name);
    expect(names).toContain('read_file');
    expect(names).toContain('bash');
    expect(names).toContain('edit_file');
    expect(names.length).toBeGreaterThanOrEqual(25);
  });

  it('exposes only read-only tools to the MCP subset', () => {
    const { registry } = makeRegistry({ dir });
    const ro = registry.readOnlyNames();
    expect(ro).toContain('read_file');
    expect(ro).toContain('ledger_verify');
    expect(ro).not.toContain('bash');
    expect(ro).not.toContain('write_file');
  });

  it('identity-stamps every invocation in the audit trail', async () => {
    const { registry, audits } = makeRegistry({ dir });
    await registry.invoke('cost_report', {}, 'shell');
    const call = audits.find((a) => a.type === 'tool.call');
    expect(call?.identity.agentId).toBe('agent_shell');
    expect(call?.identity.sessionId).toBe('sess_test');
  });

  it('blocks an unknown tool', async () => {
    const { registry } = makeRegistry({ dir });
    const res = await registry.invoke('does_not_exist', {});
    expect(res.blocked).toBe(true);
    expect(res.blockReason).toMatch(/unknown tool/);
  });

  it('rejects invalid input via the schema (no run)', async () => {
    const { registry } = makeRegistry({ dir });
    const res = await registry.invoke('read_file', { path: 123 });
    expect(res.blocked).toBe(true);
    expect(res.blockReason).toMatch(/invalid input/);
  });

  it('enforces a scoped tool allowlist', async () => {
    const { registry } = makeRegistry({ dir });
    const res = await registry.invoke('write_file', { path: join(dir, 'x'), content: 'y' }, 'sub', [
      'read_file',
    ]);
    expect(res.blocked).toBe(true);
    expect(res.blockReason).toMatch(/scoped allowlist/);
  });

  it('plan mode blocks mutating tools but allows read-only ones', async () => {
    const { registry } = makeRegistry({ dir, mode: 'plan' });
    const blocked = await registry.invoke('write_file', { path: join(dir, 'a'), content: 'b' });
    expect(blocked.blocked).toBe(true);
    expect(blocked.blockReason).toMatch(/plan mode/);

    const ok = await registry.invoke('read_file', { path: join(dir, 'nope') });
    expect(ok.ok).toBe(true); // read-only runs even in plan mode
  });

  it('ask mode gates a mutating tool through approval (denied => blocked)', async () => {
    const { registry, approvals } = makeRegistry({ dir, mode: 'ask', approve: false });
    const res = await registry.invoke('write_file', { path: join(dir, 'a'), content: 'b' });
    expect(approvals.length).toBe(1);
    expect(res.blocked).toBe(true);
    expect(res.blockReason).toMatch(/not approved/);
  });

  it('ask mode lets a mutating tool run once approved', async () => {
    const { registry } = makeRegistry({ dir, mode: 'ask', approve: true });
    const target = join(dir, 'a.txt');
    const res = await registry.invoke('write_file', { path: target, content: 'hello' });
    expect(res.ok).toBe(true);
    expect(readFileSync(target, 'utf8')).toBe('hello');
  });

  it('always gates high-risk bash even in auto mode', async () => {
    const { registry, approvals } = makeRegistry({ dir, mode: 'auto', approve: true });
    const res = await registry.invoke('bash', { command: 'echo hi' }, 'shell');
    expect(approvals.length).toBe(1); // bash is high-risk → gated even in auto
    expect(res.ok).toBe(true);
    expect(res.output).toBe('ran: echo hi');
  });

  it('checkpoints a file before edit, and rewind restores prior contents', async () => {
    const { registry, checkpoints } = makeRegistry({ dir, mode: 'auto' });
    const target = join(dir, 'edit.txt');
    writeFileSync(target, 'original', 'utf8');

    const res = await registry.invoke('edit_file', {
      path: target,
      edits: [{ oldString: 'original', newString: 'changed' }],
    });
    expect(res.ok).toBe(true);
    expect(readFileSync(target, 'utf8')).toBe('changed');
    expect(checkpoints.list().length).toBe(1);

    const restored = checkpoints.rewind(target);
    expect(restored).not.toBeNull();
    expect(readFileSync(target, 'utf8')).toBe('original');
  });
});

describe('ToolRegistry hooks', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'sc-hooks-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('a blocking pre-hook denies the tool and audits hook.fired', async () => {
    const hooks = new HookEngine();
    hooks.load([{ event: 'pre', match: 'write_file', block: true }]);
    const { registry, audits } = makeRegistry({ dir, mode: 'auto', hooks });
    const res = await registry.invoke('write_file', { path: join(dir, 'a'), content: 'b' });
    expect(res.blocked).toBe(true);
    expect(res.blockReason).toMatch(/pre-hook/);
    expect(audits.some((a) => a.type === 'hook.fired')).toBe(true);
  });

  it('a non-matching hook does not fire', async () => {
    const hooks = new HookEngine();
    hooks.load([{ event: 'pre', match: 'bash', block: true }]);
    const { registry, audits } = makeRegistry({ dir, mode: 'auto', hooks });
    const res = await registry.invoke('cost_report', {});
    expect(res.ok).toBe(true);
    expect(audits.some((a) => a.type === 'hook.fired')).toBe(false);
  });
});

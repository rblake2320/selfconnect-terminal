import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SelfConnectClient } from '../src/sdk/index';
import type { DaemonConfig } from '../src/sdk/index';
import type { EventType } from '../src/shared/contracts';

function tempConfig(dir: string): Partial<DaemonConfig> {
  return {
    localOnly: true,
    ledgerPath: join(dir, 'ledger.jsonl'),
    sessionsDir: join(dir, 'sessions'),
    a2aMode: 'off',
    a2aDir: join(dir, 'a2a'),
    mcpConfigPath: join(dir, 'mcp-servers.json'),
    checkpointsDir: join(dir, 'checkpoints'),
    hooksPath: join(dir, 'hooks.json'),
    contextStoreDir: join(dir, 'context-store'),
    scratchpadPath: join(dir, 'scratchpad.json'),
    playbooksPath: join(dir, 'playbooks.jsonl'),
    failuresPath: join(dir, 'failures.jsonl'),
    limitsPath: join(dir, 'limits.json'),
    hotTurnBudgetTokens: 2000,
  };
}

describe('Context Economy — daemon integration', () => {
  let dir: string;
  let client: SelfConnectClient;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'sc-econ-'));
    client = new SelfConnectClient({ config: tempConfig(dir), cwd: dir });
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  function collect(): { types: EventType[]; off: () => void } {
    const types: EventType[] = [];
    const off = client.onEvent((e) => types.push(e.type));
    return { types, off };
  }

  it('loads a limits manifest at boot (auditable event)', () => {
    const entries = client.daemon.ledger.all().map((e) => e.type);
    expect(entries).toContain('limits.loaded');
  });

  it('ingesting context stores a blob and emits context.stored', () => {
    const { types, off } = collect();
    const r = client.daemon.ingestContext('file body here', 'file', 'src/x.ts');
    off();
    expect(r.alreadySeen).toBe(false);
    expect(r.payload).toBe('file body here');
    expect(types).toContain('context.stored');
  });

  it('re-ingesting the same blob dedups (context.dedup) and saves tokens', () => {
    const big = Array.from({ length: 50 }, (_, i) => `line ${i} of content`).join('\n');
    client.daemon.ingestContext(big, 'scrollback', 'log', 'ollama');
    const { types, off } = collect();
    const second = client.daemon.ingestContext(big, 'scrollback', 'log', 'ollama');
    off();
    expect(second.alreadySeen).toBe(true);
    expect(types).toContain('context.dedup');
    const cost = client.state().cost;
    expect(cost.tokensNotResent).toBeGreaterThan(0);
    expect(cost.cacheSavingsUsd).toBeGreaterThan(0);
  });

  it('distills a turn at $0 and emits context.distilled', async () => {
    const { types, off } = collect();
    await client.daemon.distillTurn('Decided to ship v3a. wrote src/daemon/daemon.ts');
    off();
    expect(types).toContain('context.distilled');
    const k = client.state().knowledge;
    const learned = k.decisions.length + k.facts.length + Object.keys(k.fileStates).length;
    expect(learned).toBeGreaterThan(0);
    expect(client.state().cost.distillationSavingsUsd).toBeGreaterThan(0);
  });

  it('pins/unpins blobs with audit events and reflects pinned tokens', () => {
    const ref = client.daemon.contextStore.put('pin this content', 'doc', 's');
    const { types, off } = collect();
    expect(client.daemon.pinBlob(ref.hash)).toContain('pinned');
    expect(client.daemon.unpinBlob(ref.hash)).toContain('unpinned');
    off();
    expect(types).toContain('context.pinned');
    expect(types).toContain('context.unpinned');
  });

  it('actuator compacts at warn and emits context.compacted', async () => {
    // Push hot pressure into the warn band (>=60% of 200k).
    client.daemon.contextStore; // ensure store init
    for (let i = 0; i < 60; i++) {
      client.daemon.ingestContext('x'.repeat(8000) + ` salt${i}`, 'other', `s${i}`);
    }
    const { types, off } = collect();
    const label = await client.daemon.actuateContext();
    off();
    expect(label).toMatch(/compact/i);
    expect(types).toContain('context.compacted');
  });

  it('migrates to a successor run at >=90% pressure (same session, new run, ledger-linked)', async () => {
    client.daemon.crystallizePlaybook({ situation: 's', title: 't', steps: ['a'] });
    const before = client.state().identity.runId;
    for (let i = 0; i < 95; i++) {
      client.daemon.ingestContext('y'.repeat(8000) + ` z${i}`, 'other', `m${i}`);
    }
    const { types, off } = collect();
    const label = await client.daemon.actuateContext();
    off();
    expect(label).toMatch(/migrat/i);
    expect(types).toContain('context.migrated');
    expect(client.state().identity.runId).not.toBe(before);
    expect(client.state().identity.sessionId).toBeTruthy();
  });

  it('context_request pulls from knowledge/ledger/store and audits', () => {
    client.daemon.contextStore.put('needle content', 'doc', 'findme.ts');
    const { types, off } = collect();
    const k = client.daemon.contextRequest('anything', 'knowledge');
    const led = client.daemon.contextRequest('limits', 'ledger');
    const st = client.daemon.contextRequest('findme', 'store');
    off();
    expect(JSON.parse(k)).toHaveProperty('decisions');
    expect(led).toContain('limits.loaded');
    expect(st).toContain('needle content');
    expect(types.filter((t) => t === 'context.requested')).toHaveLength(3);
  });

  it('introspect reports session stats and audits the query', () => {
    const { types, off } = collect();
    const out = JSON.parse(client.daemon.introspect());
    off();
    expect(out.sessionId).toBe(client.state().identity.sessionId);
    expect(out.events).toBeGreaterThan(0);
    expect(out).toHaveProperty('contextEfficiencyPct');
    expect(types).toContain('introspect.query');
  });

  it('metabolic returns cheap readable resource state', () => {
    const m = client.daemon.metabolic();
    expect(m.contextRemainingPct).toBeGreaterThanOrEqual(0);
    expect(m.contextRemainingPct).toBeLessThanOrEqual(100);
    expect(m.budgetRemainingUsd).toBeGreaterThanOrEqual(0);
    expect(m.elapsedMs).toBeGreaterThanOrEqual(0);
  });

  it('crystallizes a playbook and loads it back; records + warns on failures', () => {
    client.daemon.crystallizePlaybook({
      situation: 'typecheck fails after schema change',
      title: 'Propagate schema fields',
      steps: ['add default', 'update literals'],
    });
    const loaded = client.daemon.loadPlaybooks('typecheck schema change');
    expect(loaded).toContain('Propagate schema fields');

    client.daemon.recordFailure({
      signature: 'mock db in integration tests',
      whatNotToDo: 'mock the database',
      whatWorkedInstead: 'hit a real test database',
    });
    const warn = client.daemon.failureWarning('mock database in tests');
    expect(warn).toContain('seen before');
  });

  it('persists and resumes WARM knowledge so resume re-reads nothing', async () => {
    await client.daemon.distillTurn('Decided to keep gemma3 as the distiller');
    client.daemon.persistSnapshot();
    const sid = client.state().identity.sessionId;

    const dir2Client = new SelfConnectClient({ config: tempConfig(dir), cwd: dir });
    const resumed = dir2Client.resume(sid);
    expect(resumed.ok).toBe(true);
    expect(dir2Client.state().knowledge.decisions.some((d) => /gemma3/.test(d))).toBe(true);
  });
});

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AgentKeystore } from '../src/daemon/agent-keys';
import { DelegationRegistry, HUMAN_ROOT } from '../src/daemon/delegation';
import type { DelegationScope } from '../src/shared/contracts';

const FULL: DelegationScope = { tools: ['*'], dataClasses: ['public', 'internal', 'secret', 'cui'], expiresAt: 0, spendBudgetUsd: 0 };

describe('DelegationRegistry (B2.2 capability chains)', () => {
  let dir: string;
  let ks: AgentKeystore;
  let reg: DelegationRegistry;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'sc-deleg-'));
    ks = new AgentKeystore(dir);
    reg = new DelegationRegistry(join(dir, 'delegations.jsonl'));
    ks.ensure('system');
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  function root() {
    return reg.issue({
      issuer: HUMAN_ROOT,
      grantee: 'system',
      scope: FULL,
      parent: null,
      humanApproved: true,
      sign: (m) => ks.sign('system', m),
    });
  }

  it('verifies a human-rooted chain', () => {
    const r = root();
    const v = reg.verifyChain(r.hash);
    expect(v.ok).toBe(true);
    expect(v.effectiveScope?.tools).toEqual(['*']);
  });

  it('refuses a root that is not human-approved', () => {
    const bad = reg.issue({ issuer: 'system', grantee: 'system', scope: FULL, parent: null, humanApproved: false, sign: (m) => ks.sign('system', m) });
    const v = reg.verifyChain(bad.hash);
    expect(v.ok).toBe(false);
    expect(v.reason).toMatch(/human root/);
  });

  it('intersects scope down the chain (child cannot exceed parent)', () => {
    const r = root();
    ks.ensure('worker');
    const child = reg.issue({
      issuer: 'system',
      grantee: 'worker',
      scope: { tools: ['read_file', 'grep'], dataClasses: ['public'], expiresAt: 0, spendBudgetUsd: 0.05 },
      parent: r.hash,
      sign: (m) => ks.sign('system', m),
    });
    const v = reg.authorize('worker', { tool: 'read_file' });
    expect(v.ok).toBe(true);
    expect(reg.authorize('worker', { tool: 'bash' }).ok).toBe(false);
    expect(child.scope.spendBudgetUsd).toBe(0.05);
  });

  it('refuses an over-budget action', () => {
    const r = root();
    reg.issue({ issuer: 'system', grantee: 'worker', scope: { tools: ['*'], dataClasses: ['public'], expiresAt: 0, spendBudgetUsd: 0.01 }, parent: r.hash, sign: (m) => ks.sign('system', m) });
    const v = reg.authorize('worker', { tool: 'bash', spendUsd: 0.5 });
    expect(v.ok).toBe(false);
    expect(v.reason).toMatch(/budget/);
  });

  it('refuses an expired delegation', () => {
    const r = root();
    reg.issue({ issuer: 'system', grantee: 'worker', scope: { tools: ['*'], dataClasses: ['public'], expiresAt: Date.now() - 1000, spendBudgetUsd: 0 }, parent: r.hash, sign: (m) => ks.sign('system', m) });
    const v = reg.authorize('worker', { tool: 'read_file' });
    expect(v.ok).toBe(false);
    expect(v.reason).toMatch(/expired/);
  });

  it('refuses an out-of-data-class action', () => {
    const r = root();
    reg.issue({ issuer: 'system', grantee: 'worker', scope: { tools: ['*'], dataClasses: ['public'], expiresAt: 0, spendBudgetUsd: 0 }, parent: r.hash, sign: (m) => ks.sign('system', m) });
    expect(reg.authorize('worker', { tool: 'read_file', dataClass: 'secret' }).ok).toBe(false);
    expect(reg.authorize('worker', { tool: 'read_file', dataClass: 'public' }).ok).toBe(true);
  });

  it('detects a broken authority link (child issuer != parent grantee)', () => {
    const r = root();
    // forge a child whose issuer is not the parent grantee
    ks.ensure('imposter');
    const child = reg.issue({ issuer: 'imposter', grantee: 'worker', scope: FULL, parent: r.hash, sign: (m) => ks.sign('imposter', m) });
    const v = reg.verifyChain(child.hash);
    expect(v.ok).toBe(false);
    expect(v.reason).toMatch(/authority link/);
  });

  it('refuses an action for an agent with no grant', () => {
    const v = reg.authorize('nobody', { tool: 'read_file' });
    expect(v.ok).toBe(false);
    expect(v.reason).toMatch(/no delegation grant/);
  });

  it('detects a tampered certificate (content hash mismatch)', () => {
    const r = root();
    const cert = reg.get(r.hash)!;
    // mutate scope in place; the stored hash no longer matches the content
    (cert.scope as { spendBudgetUsd: number }).spendBudgetUsd = 9999;
    const v = reg.verifyChain(r.hash);
    expect(v.ok).toBe(false);
    expect(v.reason).toMatch(/content does not match|signature/);
  });
});

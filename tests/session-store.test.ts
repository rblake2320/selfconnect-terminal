import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SessionStore } from '../src/daemon/session-store';
import type { SessionSnapshot } from '../src/shared/contracts';

function snap(sessionId: string, over: Partial<SessionSnapshot> = {}): SessionSnapshot {
  return {
    version: 2,
    sessionId,
    startedAt: 1000,
    lastActiveAt: 2000,
    cost: {
      sessionSpendUsd: 0.01,
      avoidedSpendUsd: 0.5,
      perCallCapUsd: 0.25,
      last: null,
      tokensNotResent: 0,
      cacheSavingsUsd: 0,
      distillationSavingsUsd: 0,
      contextEfficiencyPct: 100,
    },
    context: {
      usedTokens: 100,
      maxTokens: 1000,
      pressure: 10,
      level: 'normal',
      hotTokens: 100,
      warmTokens: 0,
      pinnedTokens: 0,
      dedupHits: 0,
      compactions: 0,
    },
    sentinel: {
      redactionCount: 0,
      riskCount: 0,
      highCount: 0,
      criticalCount: 0,
      findings: [],
    },
    agents: [],
    localOnly: true,
    permissionMode: 'auto',
    todos: [],
    scrollback: ['line one', 'line two'],
    blobs: [],
    ...over,
  };
}

describe('SessionStore', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'sc-sessions-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('saves and loads a snapshot round-trip', () => {
    const store = new SessionStore(dir);
    store.save(snap('sess_a'));
    const loaded = store.load('sess_a');
    expect(loaded?.sessionId).toBe('sess_a');
    expect(loaded?.scrollback).toEqual(['line one', 'line two']);
  });

  it('returns null for a missing session', () => {
    const store = new SessionStore(dir);
    expect(store.load('nope')).toBeNull();
  });

  it('lists summaries newest-first', () => {
    const store = new SessionStore(dir);
    store.save(snap('older', { lastActiveAt: 1000 }));
    store.save(snap('newer', { lastActiveAt: 5000 }));
    const list = store.list();
    expect(list.map((s) => s.sessionId)).toEqual(['newer', 'older']);
    expect(list[0].eventCount).toBe(2); // derived from scrollback length
  });

  it('survives a fresh store instance reading the same dir', () => {
    new SessionStore(dir).save(snap('persisted'));
    const reopened = new SessionStore(dir);
    expect(reopened.load('persisted')?.sessionId).toBe('persisted');
  });

  it('sanitizes path separators in the sessionId', () => {
    const store = new SessionStore(dir);
    store.save(snap('../escape/attempt'));
    // It is retrievable under the same (sanitized) id, and stays inside dir.
    expect(store.load('../escape/attempt')?.sessionId).toBe('../escape/attempt');
  });
});

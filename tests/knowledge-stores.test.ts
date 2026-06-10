import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PlaybookStore, FailureStore } from '../src/daemon/knowledge-stores';

describe('PlaybookStore (E1 skill crystallization)', () => {
  let dir: string;
  let file: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'sc-pb-'));
    file = join(dir, 'playbooks.jsonl');
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('crystallizes a playbook and persists it as JSONL', () => {
    const store = new PlaybookStore(file);
    const pb = store.crystallize({
      situation: 'zod schema field added',
      title: 'Propagate to literals',
      steps: ['add default', 'update literals'],
      provenance: ['evt_1'],
    });
    expect(pb.version).toBe(1);
    expect(existsSync(file)).toBe(true);
    expect(readFileSync(file, 'utf8').trim().split('\n')).toHaveLength(1);
  });

  it('is idempotent by content (same body -> same hash, no dup)', () => {
    const store = new PlaybookStore(file);
    store.crystallize({ situation: 's', title: 't', steps: ['a'] });
    store.crystallize({ situation: 's', title: 't', steps: ['a'] });
    expect(store.all()).toHaveLength(1);
  });

  it('versions distinct playbooks that share a title', () => {
    const store = new PlaybookStore(file);
    const v1 = store.crystallize({ situation: 's1', title: 'T', steps: ['a'] });
    const v2 = store.crystallize({ situation: 's2', title: 'T', steps: ['b'] });
    expect(v1.version).toBe(1);
    expect(v2.version).toBe(2);
  });

  it('matches by situation similarity, best first', () => {
    const store = new PlaybookStore(file);
    store.crystallize({ situation: 'typecheck fails after schema change', title: 'Fix schema', steps: ['x'] });
    store.crystallize({ situation: 'database migration deadlock', title: 'Fix db', steps: ['y'] });
    const hits = store.match('typecheck schema change broke build');
    expect(hits.length).toBeGreaterThanOrEqual(1);
    expect(hits[0].title).toBe('Fix schema');
  });

  it('reloads persisted playbooks on a fresh store', () => {
    new PlaybookStore(file).crystallize({ situation: 's', title: 't', steps: ['a'] });
    const reopened = new PlaybookStore(file);
    expect(reopened.all()).toHaveLength(1);
  });
});

describe('FailureStore (E2 failure memory)', () => {
  let dir: string;
  let file: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'sc-fail-'));
    file = join(dir, 'failures.jsonl');
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('records an anti-pattern and warns on a similar situation', () => {
    const store = new FailureStore(file);
    store.record({
      signature: 'distillation needs network',
      whatNotToDo: 'assume ollama is reachable',
      whatWorkedInstead: 'use heuristic fallback',
    });
    const warn = store.warn('distillation network call failed');
    expect(warn).toContain('seen before');
    expect(warn).toContain('heuristic fallback');
  });

  it('returns null when no similar failure is on record', () => {
    const store = new FailureStore(file);
    store.record({ signature: 'foo bar baz', whatNotToDo: 'x', whatWorkedInstead: 'y' });
    expect(store.warn('completely unrelated topic here')).toBeNull();
  });

  it('is idempotent by signature+whatNotToDo', () => {
    const store = new FailureStore(file);
    store.record({ signature: 's', whatNotToDo: 'n', whatWorkedInstead: 'w' });
    store.record({ signature: 's', whatNotToDo: 'n', whatWorkedInstead: 'w2' });
    expect(store.all()).toHaveLength(1);
  });
});

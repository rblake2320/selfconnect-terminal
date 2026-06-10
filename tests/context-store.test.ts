import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ContextStore } from '../src/daemon/context-store';

describe('ContextStore', () => {
  let dir: string;
  let store: ContextStore;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'sc-ctx-'));
    store = new ContextStore(dir);
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('stores bytes content-addressed and is idempotent', () => {
    const a = store.put('hello world', 'doc', 'src/a.ts');
    const b = store.put('hello world', 'doc', 'src/a.ts');
    expect(a.hash).toBe(b.hash);
    expect(store.list()).toHaveLength(1);
    expect(existsSync(join(dir, a.hash))).toBe(true);
    expect(readFileSync(join(dir, a.hash), 'utf8')).toBe('hello world');
  });

  it('different content yields different hashes', () => {
    const a = store.put('one', 'file', 's');
    const b = store.put('two', 'file', 's');
    expect(a.hash).not.toBe(b.hash);
    expect(store.list()).toHaveLength(2);
  });

  it('builds a 3-line digest capped per line', () => {
    const long = 'x'.repeat(200);
    const ref = store.put(`${long}\n\nsecond\nthird\nfourth`, 'doc', 's');
    const lines = ref.digest.split('\n');
    expect(lines).toHaveLength(3);
    expect(lines[0].endsWith('…')).toBe(true);
    expect(lines[0].length).toBeLessThanOrEqual(101);
  });

  it('merges provenance event ids without duplicating', () => {
    store.put('c', 'file', 's', ['evt_1']);
    const ref = store.put('c', 'file', 's', ['evt_1', 'evt_2']);
    expect(ref.provenance).toEqual(['evt_1', 'evt_2']);
  });

  it('sends full bytes on first sight, then ref+digest, saving tokens', () => {
    const content = 'line a\nline b\nline c\nline d\nline e\nline f';
    const first = store.prepareForSend(content, 'scrollback', 's', 'ollama');
    expect(first.alreadySeen).toBe(false);
    expect(first.tokensSaved).toBe(0);
    expect(first.payload).toBe(content);

    const second = store.prepareForSend(content, 'scrollback', 's', 'ollama');
    expect(second.alreadySeen).toBe(true);
    expect(second.tokensSaved).toBeGreaterThan(0);
    expect(second.payload).toContain(second.ref.hash.slice(0, 12));
    expect(second.payload.length).toBeLessThan(content.length + 80);
  });

  it('dedup is per-provider (seen by ollama != seen by anthropic)', () => {
    const c = 'shared blob content here';
    store.prepareForSend(c, 'doc', 's', 'ollama');
    const onAnthropic = store.prepareForSend(c, 'doc', 's', 'anthropic');
    expect(onAnthropic.alreadySeen).toBe(false);
  });

  it('markSeen lets an A2A-received blob ref dedup without resending', () => {
    const ref = store.put('mesh blob', 'doc', 's');
    expect(store.hasSeen('ollama', ref.hash)).toBe(false);
    store.markSeen('ollama', ref.hash);
    expect(store.hasSeen('ollama', ref.hash)).toBe(true);
    const sent = store.prepareForSend('mesh blob', 'doc', 's', 'ollama');
    expect(sent.alreadySeen).toBe(true);
  });

  it('pins and unpins blobs', () => {
    const ref = store.put('pin me', 'doc', 's');
    expect(store.pin(ref.hash)?.pinned).toBe(true);
    expect(store.pinnedList()).toHaveLength(1);
    expect(store.unpin(ref.hash)?.pinned).toBe(false);
    expect(store.pinnedList()).toHaveLength(0);
    expect(store.pin('nope')).toBeNull();
  });

  it('reads bytes back and returns null for unknown hash', () => {
    const ref = store.put('rehydrate me', 'file', 's');
    expect(store.read(ref.hash)).toBe('rehydrate me');
    expect(store.read('deadbeef')).toBeNull();
  });

  it('restores refs on resume (bytes already on disk)', () => {
    const ref = store.put('persisted', 'file', 's');
    const fresh = new ContextStore(dir);
    expect(fresh.get(ref.hash)).toBeUndefined();
    fresh.restore([ref]);
    expect(fresh.get(ref.hash)?.hash).toBe(ref.hash);
    expect(fresh.read(ref.hash)).toBe('persisted');
  });
});

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Scratchpad } from '../src/daemon/scratchpad';

describe('Scratchpad (E4 external working memory)', () => {
  let dir: string;
  let file: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'sc-pad-'));
    file = join(dir, 'scratchpad.json');
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('writes and reads by key, returning the byte length on write', () => {
    const pad = new Scratchpad(file);
    expect(pad.write('plan', 'step one')).toBe('step one'.length);
    expect(pad.read('plan')).toBe('step one');
    expect(pad.read('missing')).toBeNull();
  });

  it('overwrites an existing key', () => {
    const pad = new Scratchpad(file);
    pad.write('k', 'v1');
    pad.write('k', 'v2');
    expect(pad.read('k')).toBe('v2');
    expect(pad.keys()).toEqual(['k']);
  });

  it('queries across keys and values (substring, case-insensitive)', () => {
    const pad = new Scratchpad(file);
    pad.write('alpha', 'the QUICK brown fox');
    pad.write('beta', 'lazy dog');
    expect(pad.query('quick')).toEqual(['alpha']);
    expect(pad.query('beta')).toEqual(['beta']);
    expect(pad.query('zzz')).toEqual([]);
  });

  it('deletes a key', () => {
    const pad = new Scratchpad(file);
    pad.write('k', 'v');
    expect(pad.delete('k')).toBe(true);
    expect(pad.delete('k')).toBe(false);
    expect(pad.read('k')).toBeNull();
  });

  it('persists across instances (survives shutdown)', () => {
    new Scratchpad(file).write('persisted', 'value');
    const reopened = new Scratchpad(file);
    expect(reopened.read('persisted')).toBe('value');
  });
});

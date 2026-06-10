import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadLimits, DEFAULT_LIMITS } from '../src/daemon/limits';

describe('limits manifest (E10)', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'sc-lim-'));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('returns the default manifest when no file exists', () => {
    const lim = loadLimits(join(dir, 'nope.json'));
    expect(lim).toEqual(DEFAULT_LIMITS);
    expect(lim.cannot.some((c) => /API keys/.test(c))).toBe(true);
  });

  it('merges a user limits.json over the default', () => {
    const path = join(dir, 'limits.json');
    writeFileSync(
      path,
      JSON.stringify({ cannot: ['talk to prod'], blockedDomains: ['evil.test'], notes: ['custom note'] }),
      'utf8',
    );
    const lim = loadLimits(path);
    expect(lim.cannot).toContain('talk to prod');
    expect(lim.cannot.length).toBe(DEFAULT_LIMITS.cannot.length + 1);
    expect(lim.blockedDomains).toContain('evil.test');
    expect(lim.notes).toContain('custom note');
  });

  it('falls back to default on malformed json', () => {
    const path = join(dir, 'bad.json');
    writeFileSync(path, '{ not valid', 'utf8');
    expect(loadLimits(path)).toEqual(DEFAULT_LIMITS);
  });
});

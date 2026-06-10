import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { IPC } from '../src/shared/contracts';

/**
 * Problem 7: electron/preload.ts INLINES the IPC channel constants instead of
 * importing them from ../src/shared/contracts. That is deliberate — under
 * `sandbox: true` the preload's restricted require cannot load arbitrary
 * relative modules, so a runtime require('../src/shared/contracts') throws and
 * aborts the preload before contextBridge.exposeInMainWorld runs (window.
 * selfconnect ends up undefined). The downside of inlining is drift: this test
 * fails loudly if the inlined values ever diverge from the canonical IPC map.
 */

function parseInlinedIpc(source: string): Record<string, string> {
  const block = source.match(/const IPC = \{([\s\S]*?)\} as const;/);
  if (!block) throw new Error('could not find inlined `const IPC = { ... } as const;` in preload.ts');
  const out: Record<string, string> = {};
  const entryRe = /(\w+)\s*:\s*'([^']+)'/g;
  let m: RegExpExecArray | null;
  while ((m = entryRe.exec(block[1])) !== null) {
    out[m[1]] = m[2];
  }
  return out;
}

describe('Problem 7: preload inlined IPC parity', () => {
  const preloadSrc = readFileSync(resolve(__dirname, '../electron/preload.ts'), 'utf8');

  it('preload.ts does NOT runtime-import the contracts module (sandbox-safe)', () => {
    // Type-only imports are fine (erased); a value import of contracts is not.
    expect(preloadSrc).not.toMatch(/^import\s+\{[^}]*\bIPC\b[^}]*\}\s+from\s+['"]\.\.\/src\/shared\/contracts['"]/m);
    expect(preloadSrc).toMatch(/import type \{[\s\S]*?\} from '\.\.\/src\/shared\/contracts'/);
  });

  it('inlined IPC matches the canonical contracts IPC exactly', () => {
    const inlined = parseInlinedIpc(preloadSrc);
    expect(inlined).toEqual({ ...IPC });
  });
});

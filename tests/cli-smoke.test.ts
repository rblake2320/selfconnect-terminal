import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { main } from '../src/cli/index';

describe('selfconnect CLI smoke', () => {
  let dir: string;
  let out: string[];
  let writeSpy: { mockRestore: () => void };
  const saved: Record<string, string | undefined> = {};

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'sc-cli-'));
    // Point the daemon's persistence at the temp dir so the CLI does not write
    // into the repo's ./data during tests.
    const env: Record<string, string> = {
      SELFCONNECT_LOCAL_ONLY: 'true',
      SELFCONNECT_LEDGER_PATH: join(dir, 'ledger.jsonl'),
      SELFCONNECT_SESSIONS_DIR: join(dir, 'sessions'),
      SELFCONNECT_A2A_MODE: 'off',
      SELFCONNECT_A2A_DIR: join(dir, 'a2a'),
      SELFCONNECT_MCP_CONFIG: join(dir, 'mcp-servers.json'),
      SELFCONNECT_CHECKPOINTS_DIR: join(dir, 'checkpoints'),
      SELFCONNECT_HOOKS_CONFIG: join(dir, 'hooks.json'),
    };
    for (const [k, v] of Object.entries(env)) {
      saved[k] = process.env[k];
      process.env[k] = v;
    }
    out = [];
    writeSpy = vi
      .spyOn(process.stdout, 'write')
      .mockImplementation(((chunk: unknown): boolean => {
        out.push(String(chunk));
        return true;
      }) as typeof process.stdout.write);
  });

  afterEach(() => {
    writeSpy.mockRestore();
    for (const k of Object.keys(saved)) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
    rmSync(dir, { recursive: true, force: true });
  });

  it('help returns 0 and prints usage', async () => {
    const code = await main(['help']);
    expect(code).toBe(0);
    expect(out.join('')).toMatch(/Commands:/);
  });

  it('verify returns 0 on an intact chain and prints JSON', async () => {
    const code = await main(['verify']);
    expect(code).toBe(0);
    const parsed = JSON.parse(out.join(''));
    expect(parsed.ok).toBe(true);
  });

  it('tools lists the governed surface as JSON', async () => {
    const code = await main(['tools']);
    expect(code).toBe(0);
    const tools = JSON.parse(out.join(''));
    expect(tools.some((t: { name: string }) => t.name === 'bash')).toBe(true);
  });

  it('slash "/cost" runs and returns 0', async () => {
    const code = await main(['slash', '/cost']);
    expect(code).toBe(0);
  });

  it('an unknown slash command returns a non-zero exit code', async () => {
    const code = await main(['slash', '/nope']);
    expect(code).toBe(1);
    expect(out.join('').toLowerCase()).toMatch(/unknown|help/);
  });

  it('an unknown top-level command returns 1', async () => {
    const code = await main(['frobnicate']);
    expect(code).toBe(1);
    expect(out.join('')).toMatch(/unknown command/);
  });

  it('sessions returns 0 with a JSON array', async () => {
    const code = await main(['sessions']);
    expect(code).toBe(0);
    expect(Array.isArray(JSON.parse(out.join('')))).toBe(true);
  });
});

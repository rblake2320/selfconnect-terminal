import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SelfConnectClient } from '../src/sdk/index';
import type { DaemonConfig } from '../src/sdk/index';
import { main } from '../src/cli/index';

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
  };
}

describe('slash parser: command-token case-insensitive, argument case preserved', () => {
  let dir: string;
  let client: SelfConnectClient;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'sc-fix-'));
    client = new SelfConnectClient({ config: tempConfig(dir), cwd: dir });
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('matches the command token case-insensitively (/COST == /cost)', async () => {
    const lower = await client.slash('/cost');
    const upper = await client.slash('/COST');
    const mixed = await client.slash('/Cost');
    expect(lower.ok).toBe(true);
    expect(upper.ok).toBe(true);
    expect(mixed.ok).toBe(true);
    expect(upper.output).toBe(lower.output);
    expect(mixed.output).toBe(lower.output);
  });

  it('preserves the original case of argument payloads', async () => {
    // /redact-test echoes its (redaction-free) argument back verbatim.
    const r = await client.slash('/redact-test Hello MixedCase WORLD CamelToken');
    expect(r.ok).toBe(true);
    expect(r.output).toContain('Hello MixedCase WORLD CamelToken');
  });

  it('preserves argument case even when the command token is uppercased', async () => {
    const r = await client.slash('/REDACT-TEST PreserveThisExactCase');
    expect(r.ok).toBe(true);
    expect(r.output).toContain('PreserveThisExactCase');
  });

  it('preserves case through a subcommand argument (/memory write)', async () => {
    const w = await client.slash('/memory write KeepThis CamelCase And UPPER');
    expect(w.ok).toBe(true);
    const show = await client.slash('/MEMORY show');
    expect(show.output).toContain('KeepThis CamelCase And UPPER');
  });
});

describe('/simulate parses a raw JSON payload with mixed-case values preserved', () => {
  let dir: string;
  let client: SelfConnectClient;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'sc-sim-'));
    client = new SelfConnectClient({ config: tempConfig(dir), cwd: dir });
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('splits off the tool name and treats the remainder as raw JSON (spaces inside JSON kept)', async () => {
    const target = join(dir, 'MixedCaseName.TXT');
    const r = await client.slash(
      `/simulate write_file {"path": "${target}", "content": "Hello WORLD MixedCase"}`,
    );
    expect(r.ok).toBe(true);
    // The case-sensitive path and content survive verbatim in the preview.
    expect(r.output).toContain(target);
    expect(r.output).toContain('Hello WORLD MixedCase');
  });

  it('emits a clear usage message when no tool is given', async () => {
    const r = await client.slash('/simulate');
    expect(r.ok).toBe(false);
    expect(r.output).toMatch(/usage:.*\/simulate <tool> <json-input>/);
  });

  it('emits a clear usage message when the JSON payload is invalid', async () => {
    const r = await client.slash('/simulate write_file {not valid json');
    expect(r.ok).toBe(false);
    expect(r.output).toMatch(/usage:.*valid JSON/);
  });
});

describe('passport verify <file> CLI argument handling', () => {
  let dir: string;
  let out: string[];
  let writeSpy: { mockRestore: () => void };
  const saved: Record<string, string | undefined> = {};

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'sc-pv-'));
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

  it('prints a clear usage string when the file argument is omitted', async () => {
    const code = await main(['passport', 'verify']);
    expect(code).toBe(1);
    expect(out.join('')).toMatch(/usage: selfconnect passport verify <path-to-passport\.json>/);
  });

  it('prints a helpful error (and does not throw) when the file is missing', async () => {
    const code = await main(['passport', 'verify', join(dir, 'no-such-file.json')]);
    expect(code).toBe(1);
    expect(out.join('')).toMatch(/cannot read file/);
  });

  it('reports invalid JSON helpfully instead of crashing', async () => {
    const bad = join(dir, 'bad.json');
    writeFileSync(bad, '{ not json', 'utf8');
    const code = await main(['passport', 'verify', bad]);
    expect(code).toBe(1);
    expect(out.join('')).toMatch(/not valid JSON/);
  });

  it('verifies a freshly exported, signed passport as VALID (happy path)', async () => {
    const file = join(dir, 'passport.json');
    const exportCode = await main(['passport', 'export', file]);
    expect(exportCode).toBe(0);
    out.length = 0;
    const verifyCode = await main(['passport', 'verify', file]);
    expect(verifyCode).toBe(0);
    expect(out.join('')).toMatch(/VALID/);
    expect(out.join('')).not.toMatch(/INVALID/);
  });
});

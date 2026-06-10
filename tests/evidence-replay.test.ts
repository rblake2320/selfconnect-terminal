import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SelfConnectClient } from '../src/sdk/index';
import type { DaemonConfig } from '../src/sdk/index';
import { buildEvidenceBundle, zipStore, bundleFiles, bundleDigest } from '../src/daemon/evidence';
import { verifyReplayBundle } from '../src/daemon/replay';
import { ReplayBundleSchema } from '../src/shared/contracts';

function tempConfig(dir: string): Partial<DaemonConfig> {
  return {
    localOnly: true,
    ledgerPath: join(dir, 'ledger.jsonl'),
    sessionsDir: join(dir, 'sessions'),
    a2aMode: 'off',
    a2aDir: join(dir, 'a2a'),
    mcpConfigPath: join(dir, 'mcp.json'),
    checkpointsDir: join(dir, 'checkpoints'),
    hooksPath: join(dir, 'hooks.json'),
    keysDir: join(dir, 'keys'),
    checkpointsLedgerPath: join(dir, 'cp.jsonl'),
    delegationsPath: join(dir, 'deleg.jsonl'),
  };
}

describe('Evidence + replay bundles (B)', () => {
  let dir: string;
  let client: SelfConnectClient;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'sc-ev-'));
    client = new SelfConnectClient({ config: tempConfig(dir), cwd: dir });
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('exports a self-verifying replay bundle for the current session', () => {
    client.daemon.sealCheckpoint();
    const bundle = client.daemon.exportReplay();
    expect(bundle.events.length).toBeGreaterThan(0);
    const v = verifyReplayBundle(bundle);
    expect(v.ok).toBe(true);
    expect(v.signatureOk).toBe(true);
    expect(v.chainOk).toBe(true);
    expect(v.checkpointsOk).toBe(true);
  });

  it('rejects a replay bundle whose events were tampered', () => {
    client.daemon.sealCheckpoint();
    const bundle = client.daemon.exportReplay();
    const tampered = { ...bundle, events: bundle.events.map((e, i) => (i === 1 ? { ...e, payload: { hacked: true } } : e)) };
    const v = verifyReplayBundle(tampered);
    expect(v.ok).toBe(false);
  });

  it('rejects a replay bundle with an invalid signature', () => {
    client.daemon.sealCheckpoint();
    const bundle = client.daemon.exportReplay();
    const v = verifyReplayBundle({ ...bundle, signature: { ...bundle.signature, sigHex: '00'.repeat(64) } });
    expect(v.ok).toBe(false);
    expect(v.signatureOk).toBe(false);
  });

  it('replay bundle round-trips through its schema', () => {
    client.daemon.sealCheckpoint();
    const bundle = client.daemon.exportReplay();
    const parsed = ReplayBundleSchema.safeParse(JSON.parse(JSON.stringify(bundle)));
    expect(parsed.success).toBe(true);
  });

  it('builds an evidence bundle with a verification report', () => {
    client.daemon.sealCheckpoint();
    const bundle = client.daemon.exportEvidence();
    expect(bundle.report.chainOk).toBe(true);
    expect(bundle.report.checkpointsOk).toBe(true);
    expect(bundle.report.entries).toBeGreaterThan(0);
    expect(bundle.publicKeys.length).toBeGreaterThan(0);
  });

  it('packages an evidence bundle as a valid (non-empty) zip with the expected members', () => {
    const bundle = buildEvidenceBundle({
      sessionId: 'sess_x',
      events: [],
      checkpoints: [],
      publicKeys: [],
      chainOk: true,
      checkpointsOk: true,
      brokenAt: null,
    });
    const files = bundleFiles(bundle);
    expect(Object.keys(files)).toContain('verification-report.json');
    expect(Object.keys(files)).toContain('pubkeys.json');
    const zip = zipStore(files);
    // Local file header + EOCD signatures present.
    expect(zip.subarray(0, 4)).toEqual(Buffer.from([0x50, 0x4b, 0x03, 0x04]));
    expect(zip.length).toBeGreaterThan(50);
    // digest is stable for identical content
    expect(bundleDigest(bundle)).toBe(bundleDigest(bundle));
  });
});

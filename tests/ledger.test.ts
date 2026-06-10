import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AuditLedger } from '../src/daemon/audit-ledger';
import type { Identity } from '../src/shared/contracts';

const identity: Identity = { sessionId: 's1', runId: 'r1', agentId: 'a1' };

describe('audit ledger hash chain', () => {
  let dir: string;
  let path: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'sc-ledger-'));
    path = join(dir, 'ledger.jsonl');
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('verifyChain is OK on a clean chain', () => {
    const ledger = new AuditLedger(path);
    ledger.append({ type: 'run.start', payload: { a: 1 }, identity });
    ledger.append({ type: 'route.decision', payload: { b: 2 }, identity });
    ledger.append({ type: 'cost.update', payload: { c: 3 }, identity });

    const status = ledger.verifyChain();
    expect(status.ok).toBe(true);
    expect(status.entries).toBe(3);
    expect(status.brokenAt).toBeNull();
    expect(status.lastHash).toHaveLength(64);
  });

  it('links each entry to the previous hash', () => {
    const ledger = new AuditLedger(path);
    const e0 = ledger.append({ type: 'run.start', payload: {}, identity });
    const e1 = ledger.append({ type: 'run.end', payload: {}, identity });
    expect(e1.prevHash).toBe(e0.hash);
  });

  it('detects tampering: BROKEN after a payload is mutated', () => {
    const ledger = new AuditLedger(path);
    ledger.append({ type: 'run.start', payload: { value: 'original' }, identity });
    ledger.append({ type: 'risk.detected', payload: { value: 'second' }, identity });
    ledger.append({ type: 'run.end', payload: { value: 'third' }, identity });

    // Tamper with the middle entry while keeping its stored hash.
    const entries = ledger.all().map((e) => ({ ...e }));
    entries[1] = { ...entries[1], payload: { value: 'TAMPERED' } };
    ledger.rewriteRaw(entries);

    const reloaded = new AuditLedger(path);
    const status = reloaded.verifyChain();
    expect(status.ok).toBe(false);
    expect(status.brokenAt).toBe(1);
  });

  it('detects deletion/reordering of entries', () => {
    const ledger = new AuditLedger(path);
    ledger.append({ type: 'run.start', payload: { n: 1 }, identity });
    ledger.append({ type: 'cost.update', payload: { n: 2 }, identity });
    ledger.append({ type: 'run.end', payload: { n: 3 }, identity });

    const entries = ledger.all().map((e) => ({ ...e }));
    // Drop the middle entry -> entry[2].prevHash no longer matches entry[0].hash.
    const reduced = [entries[0], entries[2]];
    ledger.rewriteRaw(reduced);

    const reloaded = new AuditLedger(path);
    const status = reloaded.verifyChain();
    expect(status.ok).toBe(false);
    expect(status.brokenAt).toBe(1);
  });

  it('persists and reloads the chain across instances', () => {
    const a = new AuditLedger(path);
    a.append({ type: 'run.start', payload: {}, identity });
    a.append({ type: 'run.end', payload: {}, identity });
    const b = new AuditLedger(path);
    expect(b.verifyChain().ok).toBe(true);
    expect(b.all().length).toBe(2);
  });
});

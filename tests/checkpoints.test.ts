import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AgentKeystore } from '../src/daemon/agent-keys';
import { CheckpointStore, checkpointMessage } from '../src/daemon/ledger-checkpoints';
import { AuditLedger } from '../src/daemon/audit-ledger';
import { verifySignature } from '../src/daemon/agent-keys';

describe('Signed ledger checkpoints (B)', () => {
  let dir: string;
  let ks: AgentKeystore;
  let ledger: AuditLedger;
  let store: CheckpointStore;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'sc-cp-'));
    ks = new AgentKeystore(dir);
    ks.ensure('system');
    ledger = new AuditLedger(join(dir, 'ledger.jsonl'));
    store = new CheckpointStore(join(dir, 'cp.jsonl'));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  function head() {
    const all = ledger.all();
    const h = all[all.length - 1];
    return { seq: h.seq, hash: h.hash, entries: all.length };
  }

  it('seals a signed checkpoint over the ledger head', () => {
    ledger.append({ type: 'run.start', payload: {} });
    const cp = store.seal(head(), (m) => ks.sign('system', m));
    expect(verifySignature(checkpointMessage(cp.seq, cp.hash, cp.entries, cp.ts), cp.signature)).toBe(true);
    expect(store.count()).toBe(1);
  });

  it('verifies checkpoints against the ledger entries', () => {
    ledger.append({ type: 'run.start', payload: {} });
    store.seal(head(), (m) => ks.sign('system', m));
    ledger.append({ type: 'tool.call', payload: {} });
    store.seal(head(), (m) => ks.sign('system', m));
    const v = store.verify(ledger.all());
    expect(v.ok).toBe(true);
    expect(v.checkpoints).toBe(2);
  });

  it('detects a checkpoint that does not match its ledger entry (substitution)', () => {
    ledger.append({ type: 'run.start', payload: {} });
    const cp = store.seal(head(), (m) => ks.sign('system', m));
    // Re-sign a checkpoint pointing at the same seq but a forged hash.
    const forged = store.seal({ seq: cp.seq, hash: 'f'.repeat(64), entries: cp.entries }, (m) => ks.sign('system', m));
    expect(forged.hash).not.toBe(cp.hash);
    const v = store.verify(ledger.all());
    expect(v.ok).toBe(false);
    expect(v.reason).toMatch(/does not match/);
  });

  it('reloads checkpoints across store instances', () => {
    ledger.append({ type: 'run.start', payload: {} });
    store.seal(head(), (m) => ks.sign('system', m));
    const store2 = new CheckpointStore(join(dir, 'cp.jsonl'));
    expect(store2.count()).toBe(1);
    expect(store2.verify(ledger.all()).ok).toBe(true);
  });
});

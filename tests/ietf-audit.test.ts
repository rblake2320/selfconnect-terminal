import { describe, it, expect } from 'vitest';
import { toIetfAuditEvent, toIetfAuditTrail, ietfAction, IETF_MAPPING_TABLE } from '../src/daemon/ietf-audit';
import type { LedgerEntry } from '../src/shared/contracts';

function entry(seq: number, type: LedgerEntry['type'], agentId?: string): LedgerEntry {
  return {
    seq,
    ts: 1700000000000 + seq * 1000,
    type,
    sessionId: 'sess',
    runId: 'run',
    agentId,
    payload: { i: seq },
    prevHash: 'p'.repeat(64),
    hash: `h${seq}`.padEnd(64, '0'),
  };
}

describe('IETF draft-sharif-agent-audit-trail mapping (B)', () => {
  it('maps event types onto coarse action categories', () => {
    expect(ietfAction('tool.call')).toBe('invoke');
    expect(ietfAction('a2a.sent')).toBe('communicate');
    expect(ietfAction('route.decision')).toBe('decide');
    expect(ietfAction('delegation.issued')).toBe('authorize');
    expect(ietfAction('checkpoint.signed')).toBe('attest');
    expect(ietfAction('run.start')).toBe('lifecycle');
    expect(ietfAction('context.update')).toBe('observe');
  });

  it('maps a ledger entry preserving hash linkage + native type', () => {
    const e = toIetfAuditEvent(entry(3, 'tool.call', 'agent_worker'));
    expect(e.recordId).toBe(3);
    expect(e.time).toBe(new Date(1700000003000).toISOString());
    expect(e.action).toBe('invoke');
    expect(e.eventType).toBe('tool.call');
    expect(e.actor).toEqual({ id: 'agent_worker', type: 'agent' });
    expect(e.context).toEqual({ sessionId: 'sess', runId: 'run' });
    expect(e.hash).toBe(entry(3, 'tool.call').hash);
    expect(e.prevHash).toBe('p'.repeat(64));
  });

  it('infers human/system actors', () => {
    expect(toIetfAuditEvent(entry(0, 'grant.root', 'human')).actor.type).toBe('human');
    expect(toIetfAuditEvent(entry(1, 'checkpoint.signed', 'system')).actor.type).toBe('system');
    expect(toIetfAuditEvent(entry(2, 'tool.call', undefined)).actor.type).toBe('system');
  });

  it('maps a whole trail in order', () => {
    const trail = toIetfAuditTrail([entry(0, 'run.start', 'system'), entry(1, 'tool.call', 'a')]);
    expect(trail.map((t) => t.recordId)).toEqual([0, 1]);
    expect(trail.map((t) => t.action)).toEqual(['lifecycle', 'invoke']);
  });

  it('publishes a documented field mapping table', () => {
    const natives = IETF_MAPPING_TABLE.map((r) => r.native);
    expect(natives).toContain('hash, prevHash');
    expect(natives).toContain('payload');
    expect(IETF_MAPPING_TABLE.length).toBeGreaterThanOrEqual(6);
  });
});

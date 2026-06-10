import { describe, it, expect } from 'vitest';
import { EventSchema, UiStateSchema, type EventType } from '../src/shared/contracts';

const NON_OUTPUT_TYPES: EventType[] = [
  'agent.spawn',
  'run.start',
  'route.decision',
  'cost.update',
  'approval.requested',
  'redaction.applied',
  'risk.detected',
  'review.result',
  'ledger.append',
  'policy.block',
];

describe('event schema identity enforcement', () => {
  it('rejects a non-output event missing sessionId/runId/agentId', () => {
    for (const type of NON_OUTPUT_TYPES) {
      const result = EventSchema.safeParse({
        id: 'evt_1',
        ts: Date.now(),
        type,
        payload: {},
      });
      expect(result.success, `${type} should require identity`).toBe(false);
    }
  });

  it('rejects when only some identity fields are present', () => {
    const result = EventSchema.safeParse({
      id: 'evt_1',
      ts: Date.now(),
      type: 'run.start',
      sessionId: 's1',
      runId: 'r1',
      // agentId missing
    });
    expect(result.success).toBe(false);
  });

  it('accepts a fully identity-stamped non-output event', () => {
    const result = EventSchema.safeParse({
      id: 'evt_1',
      ts: Date.now(),
      type: 'route.decision',
      sessionId: 's1',
      runId: 'r1',
      agentId: 'a1',
      payload: { ok: true },
    });
    expect(result.success).toBe(true);
  });

  it('allows terminal.output WITHOUT identity (the only exemption)', () => {
    const result = EventSchema.safeParse({
      id: 'evt_2',
      ts: Date.now(),
      type: 'terminal.output',
      payload: { data: 'hello' },
    });
    expect(result.success).toBe(true);
  });

  it('UiStateSchema validates a minimal well-formed state', () => {
    const state = {
      identity: { sessionId: 's', runId: 'r', agentId: 'a' },
      cost: { sessionSpendUsd: 0, avoidedSpendUsd: 0, perCallCapUsd: 0.25, last: null },
      context: { usedTokens: 0, maxTokens: 200000, pressure: 0, level: 'normal' },
      route: null,
      liveness: [],
      localOnly: true,
      sentinel: { redactionCount: 0, riskCount: 0, highCount: 0, criticalCount: 0, findings: [] },
      agents: [],
      approvals: [],
      ledger: { ok: true, entries: 0, lastHash: '0', brokenAt: null },
      permissionMode: 'auto',
      todos: [],
      sessions: [],
      peers: [],
      knowledge: {},
      metabolic: { contextRemainingPct: 100, budgetRemainingUsd: 0.25, elapsedMs: 0 },
    };
    expect(UiStateSchema.safeParse(state).success).toBe(true);
  });
});

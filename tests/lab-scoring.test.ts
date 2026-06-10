import { describe, it, expect } from 'vitest';
import {
  scoreArm,
  rescoreFromLedger,
  renderComparison,
  inputToText,
  type ArmRunObservation,
} from '../src/daemon/lab';
import type { LedgerEntry, ToolResult } from '../src/shared/contracts';

function entry(partial: Partial<LedgerEntry> & { type: LedgerEntry['type'] }): LedgerEntry {
  return {
    seq: 0,
    ts: 1,
    sessionId: 'sess_1',
    runId: 'run_a',
    agentId: 'agent_tool',
    prevHash: '0',
    hash: '1',
    payload: {},
    ...partial,
  } as LedgerEntry;
}

const okResult: ToolResult = { ok: true, tool: 'read_file', output: 'done' };

describe('D6 lab scoring (pure, from ledger slices)', () => {
  it('derives turns / errors / approvals / cache from the ledger slice', () => {
    const slice: LedgerEntry[] = [
      entry({ type: 'tool.call' }),
      entry({ type: 'tool.result', payload: { ok: true } }),
      entry({ type: 'tool.call' }),
      entry({ type: 'tool.result', payload: { ok: false } }),
      entry({ type: 'tool.result', payload: { ok: true, cached: true } }),
      entry({ type: 'approval.requested' }),
    ];
    const obs: ArmRunObservation = {
      arm: 'baseline',
      runId: 'run_a',
      steps: [
        { tool: 'read_file', inputText: 'abcd', result: okResult },
        { tool: 'bash', inputText: 'echo hi', result: { ok: false, tool: 'bash', output: 'boom' } },
      ],
      ledgerSlice: slice,
      wallTimeMs: 42.6,
      verifyExitCode: null,
    };
    const score = scoreArm(obs);
    expect(score.turns).toBe(2);
    expect(score.approvalsTriggered).toBe(1);
    // 1 error of 3 results = 33.33%
    expect(score.toolErrorRate).toBeCloseTo(33.33, 1);
    // 1 cached of 3 results = 33.33%
    expect(score.cacheHitPct).toBeCloseTo(33.33, 1);
    expect(score.wallTimeMs).toBe(43); // rounded
    expect(score.totalTokens).toBeGreaterThan(0);
  });

  it('success is verify-exit-driven when a verify command is declared', () => {
    const base: ArmRunObservation = {
      arm: 'a',
      runId: 'run_a',
      steps: [],
      ledgerSlice: [entry({ type: 'tool.call' })],
      wallTimeMs: 1,
      verifyExitCode: 0,
    };
    expect(scoreArm(base).success).toBe(true);
    expect(scoreArm({ ...base, verifyExitCode: 1 }).success).toBe(false);
  });

  it('without a verify command, success = no tool errors and at least one turn', () => {
    const clean: ArmRunObservation = {
      arm: 'a',
      runId: 'run_a',
      steps: [],
      ledgerSlice: [entry({ type: 'tool.call' }), entry({ type: 'tool.result', payload: { ok: true } })],
      wallTimeMs: 1,
      verifyExitCode: null,
    };
    expect(scoreArm(clean).success).toBe(true);
    // an error flips it
    const failing = {
      ...clean,
      ledgerSlice: [...clean.ledgerSlice, entry({ type: 'tool.result', payload: { ok: false } })],
    };
    expect(scoreArm(failing).success).toBe(false);
    // no turns => not a success
    const empty = { ...clean, ledgerSlice: [] as LedgerEntry[] };
    expect(scoreArm(empty).success).toBe(false);
  });

  it('rescoreFromLedger slices the session ledger by each arm marker runId', () => {
    const ledger: LedgerEntry[] = [
      entry({ type: 'lab.run' }),
      // arm A: runId run_a, 1 call, no errors
      entry({ type: 'tool.call', runId: 'run_a' }),
      entry({ type: 'tool.result', runId: 'run_a', payload: { ok: true } }),
      entry({
        type: 'lab.arm',
        runId: 'run_a',
        payload: { arm: 'A', runId: 'run_a', wallTimeMs: 10, verifyExitCode: 0 },
      }),
      // arm B: runId run_b, 2 calls, 1 error
      entry({ type: 'tool.call', runId: 'run_b' }),
      entry({ type: 'tool.call', runId: 'run_b' }),
      entry({ type: 'tool.result', runId: 'run_b', payload: { ok: false } }),
      entry({
        type: 'lab.arm',
        runId: 'run_b',
        payload: { arm: 'B', runId: 'run_b', wallTimeMs: 20, verifyExitCode: 1 },
      }),
    ];
    const report = rescoreFromLedger('mytask', 'sess_1', ledger);
    expect(report.task).toBe('mytask');
    expect(report.scores).toHaveLength(2);
    const [a, b] = report.scores;
    expect(a.arm).toBe('A');
    expect(a.turns).toBe(1);
    expect(a.success).toBe(true);
    expect(b.arm).toBe('B');
    expect(b.turns).toBe(2);
    expect(b.toolErrorRate).toBeCloseTo(100, 1);
    expect(b.success).toBe(false);
  });

  it('renders a side-by-side comparison table with PASS/FAIL', () => {
    const report = rescoreFromLedger('t', 'sess_1', [
      entry({ type: 'tool.call', runId: 'run_a' }),
      entry({
        type: 'lab.arm',
        runId: 'run_a',
        payload: { arm: 'baseline', runId: 'run_a', wallTimeMs: 5, verifyExitCode: 0 },
      }),
    ]);
    const table = renderComparison(report);
    expect(table).toContain('baseline');
    expect(table).toContain('turns');
    expect(table).toContain('PASS');
  });

  it('inputToText stringifies structured input deterministically', () => {
    expect(inputToText('hi')).toBe('hi');
    expect(inputToText({ a: 1 })).toBe('{"a":1}');
    expect(inputToText(undefined)).toBe('');
    expect(inputToText(null)).toBe('');
  });
});

import type {
  LabArmConfig,
  LabArmScore,
  LabReport,
  LabTask,
  LedgerEntry,
  ToolResult,
} from '../shared/contracts';
import { estimateTokens } from '../agent/cost-kernel';

/**
 * D6 HARNESS LAB. The ledger doubles as an eval substrate: the same task is run
 * under different harness configurations ("arms"), each in an isolated runId
 * within one session, and every arm is scored *purely from its ledger slice*.
 *
 * An arm varies toolset, context policy (hot-window size / dedup), model /
 * provider choice, and permission mode. Scoring is deterministic and works with
 * stub/local providers so it is fully testable offline. Nothing here touches the
 * network or the model directly — arms run their declared tool steps through the
 * governed ToolRegistry (injected as `invoke`), and scores are derived from the
 * resulting audit trail.
 */

/** What the lab observes for a single executed tool step (for token tally). */
export interface ArmStepObservation {
  tool: string;
  /** Serialized input handed to the tool (for input-token estimation). */
  inputText: string;
  result: ToolResult;
}

/** Everything the pure scorer needs for one arm. */
export interface ArmRunObservation {
  arm: string;
  runId: string;
  steps: ArmStepObservation[];
  /** Ledger entries stamped with this arm's runId. */
  ledgerSlice: LedgerEntry[];
  wallTimeMs: number;
  /** Exit code of the verify command (null if none declared). */
  verifyExitCode: number | null;
}

/**
 * Score one arm from its observation. Pure: same inputs → same score.
 *
 *   turns              = number of tool.call events in the slice
 *   totalTokens        = estimated input + output tokens across the arm's steps
 *   cacheHitPct        = % of tool.result entries flagged cached/deduped
 *   toolErrorRate      = % of tool.result entries with ok === false
 *   approvalsTriggered = approval.requested events in the slice
 *   wallTimeMs         = measured by the runner
 *   success            = verify exit code === 0 (or, if no verify, no tool errors)
 */
export function scoreArm(obs: ArmRunObservation): LabArmScore {
  const calls = obs.ledgerSlice.filter((e) => e.type === 'tool.call');
  const results = obs.ledgerSlice.filter((e) => e.type === 'tool.result');
  const approvals = obs.ledgerSlice.filter((e) => e.type === 'approval.requested');

  const turns = calls.length;
  const errorCount = results.filter((e) => {
    const p = e.payload as { ok?: boolean } | undefined;
    return p?.ok === false;
  }).length;
  const cachedCount = results.filter((e) => {
    const p = e.payload as { cached?: boolean; deduped?: boolean } | undefined;
    return p?.cached === true || p?.deduped === true;
  }).length;

  let totalTokens = 0;
  for (const s of obs.steps) {
    totalTokens += estimateTokens(s.inputText) + estimateTokens(s.result.output ?? '');
  }

  const resultDenom = results.length || 1;
  const toolErrorRate = (errorCount / resultDenom) * 100;
  const cacheHitPct = (cachedCount / resultDenom) * 100;

  const success =
    obs.verifyExitCode === null ? errorCount === 0 && turns > 0 : obs.verifyExitCode === 0;

  return {
    arm: obs.arm,
    runId: obs.runId,
    turns,
    totalTokens,
    cacheHitPct: round2(cacheHitPct),
    toolErrorRate: round2(toolErrorRate),
    approvalsTriggered: approvals.length,
    wallTimeMs: Math.max(0, Math.round(obs.wallTimeMs)),
    success,
    verifyExitCode: obs.verifyExitCode,
  };
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

/** Render a side-by-side comparison table (CLI). */
export function renderComparison(report: LabReport): string {
  const headers = [
    'arm',
    'turns',
    'tokens',
    'cache%',
    'err%',
    'appr',
    'ms',
    'ok',
  ];
  const rows = report.scores.map((s) => [
    s.arm,
    String(s.turns),
    String(s.totalTokens),
    s.cacheHitPct.toFixed(1),
    s.toolErrorRate.toFixed(1),
    String(s.approvalsTriggered),
    String(s.wallTimeMs),
    s.success ? 'PASS' : 'FAIL',
  ]);
  const widths = headers.map((h, i) =>
    Math.max(h.length, ...rows.map((r) => r[i].length)),
  );
  const fmt = (cells: string[]): string =>
    cells.map((c, i) => c.padEnd(widths[i])).join('  ');
  const lines = [
    `lab: ${report.task}  (session ${report.sessionId})`,
    fmt(headers),
    fmt(widths.map((w) => '-'.repeat(w))),
    ...rows.map(fmt),
  ];
  return lines.join('\n');
}

/**
 * Re-score a finished lab run from the full session ledger. Given the `lab.arm`
 * marker events (one per arm, payload {arm, runId, wallTimeMs, verifyExitCode}),
 * slice the ledger by each arm's runId and re-derive scores. Used by
 * `selfconnect lab report <sessionId>`.
 */
export function rescoreFromLedger(
  task: string,
  sessionId: string,
  ledger: readonly LedgerEntry[],
): LabReport {
  const armMarkers = ledger.filter(
    (e) => e.type === 'lab.arm' && e.sessionId === sessionId,
  );
  const scores: LabArmScore[] = armMarkers.map((m) => {
    const p = (m.payload ?? {}) as {
      arm?: string;
      runId?: string;
      wallTimeMs?: number;
      verifyExitCode?: number | null;
    };
    const runId = p.runId ?? m.runId ?? '';
    const slice = ledger.filter((e) => e.runId === runId);
    return scoreArm({
      arm: p.arm ?? 'arm',
      runId,
      steps: [],
      ledgerSlice: slice,
      wallTimeMs: p.wallTimeMs ?? 0,
      verifyExitCode: p.verifyExitCode ?? null,
    });
  });
  const ranAt = armMarkers.length ? armMarkers[0].ts : Date.now();
  return { task, sessionId, ranAt, scores };
}

/** Coerce an arbitrary task step input into a stable string for token tally. */
export function inputToText(input: unknown): string {
  if (input === undefined || input === null) return '';
  if (typeof input === 'string') return input;
  try {
    return JSON.stringify(input);
  } catch {
    return String(input);
  }
}

export type { LabArmConfig, LabTask, LabReport };

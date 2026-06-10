import type { RiskFinding, SentinelSnapshot } from '../../shared/contracts';

/**
 * Sentinel export adapter — a future hook for shipping Security Sentinel
 * findings to an external SIEM/observability sink. Produces a stable,
 * line-delimited JSON export. The default sink is a string buffer (no network),
 * so it is safe to exercise from tests and the daemon alike.
 */

export interface SentinelExportRecord {
  ts: number;
  redactionCount: number;
  riskCount: number;
  highCount: number;
  criticalCount: number;
  finding: RiskFinding | null;
}

export function toExportRecords(
  snapshot: SentinelSnapshot,
  ts: number = Date.now(),
): SentinelExportRecord[] {
  if (snapshot.findings.length === 0) {
    return [
      {
        ts,
        redactionCount: snapshot.redactionCount,
        riskCount: snapshot.riskCount,
        highCount: snapshot.highCount,
        criticalCount: snapshot.criticalCount,
        finding: null,
      },
    ];
  }
  return snapshot.findings.map((finding) => ({
    ts,
    redactionCount: snapshot.redactionCount,
    riskCount: snapshot.riskCount,
    highCount: snapshot.highCount,
    criticalCount: snapshot.criticalCount,
    finding,
  }));
}

export function exportJsonl(records: SentinelExportRecord[]): string {
  return records.map((r) => JSON.stringify(r)).join('\n');
}

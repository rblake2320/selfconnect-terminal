import type { RiskFinding, SentinelSnapshot } from '../shared/contracts';
import { assessCommand } from './command-risk';

/**
 * Security Sentinel state. Accumulates redaction counts and risky-command
 * findings for the dock widget, and exposes a snapshot. Risk assessment is
 * delegated to command-risk; this module is the running tally + event source.
 */
export class SecuritySentinel {
  private redactionCount = 0;
  private findings: RiskFinding[] = [];

  addRedactions(n: number): void {
    if (n > 0) this.redactionCount += n;
  }

  /** Assess a command; records and returns the finding (or null). */
  inspectCommand(command: string): RiskFinding | null {
    const finding = assessCommand(command);
    if (finding) this.findings.push(finding);
    return finding;
  }

  /** Record an externally-derived finding (e.g. A2A broken chain). */
  addFinding(finding: RiskFinding): void {
    this.findings.push(finding);
  }

  /** Restore counters from a persisted snapshot (session resume). */
  restore(snapshot: SentinelSnapshot): void {
    this.redactionCount = snapshot.redactionCount;
    this.findings = snapshot.findings.slice();
  }

  snapshot(): SentinelSnapshot {
    const high = this.findings.filter((f) => f.severity === 'high').length;
    const critical = this.findings.filter((f) => f.severity === 'critical').length;
    return {
      redactionCount: this.redactionCount,
      riskCount: this.findings.length,
      highCount: high,
      criticalCount: critical,
      findings: this.findings.slice(-50),
    };
  }
}

import type { RiskFinding, RiskSeverity } from '../shared/contracts';

/**
 * Risky-command detection for the Security Sentinel. Pure function over a
 * command string; returns the highest-severity matching finding (or null).
 * Used both to surface warnings in the UI and to emit `risk.detected` events.
 */

interface RiskRule {
  pattern: RegExp;
  severity: RiskSeverity;
  reason: string;
}

const RULES: RiskRule[] = [
  {
    pattern: /\brm\s+(-[a-zA-Z]*\s+)*-[a-zA-Z]*[rf][a-zA-Z]*\b.*(\s\/(\s|$)|\s\/\*|\s~\/?\s*$|\s\.\s*$)/,
    severity: 'critical',
    reason: 'Recursive force delete targeting root, home, or cwd',
  },
  {
    pattern: /\brm\s+-[a-zA-Z]*r[a-zA-Z]*f|\brm\s+-[a-zA-Z]*f[a-zA-Z]*r/,
    severity: 'high',
    reason: 'Recursive force delete (rm -rf)',
  },
  {
    pattern: /\b(mkfs|fdisk|parted|dd)\b.*\bof=\/dev\/|:\(\)\s*\{\s*:\|:&\s*\};:/,
    severity: 'critical',
    reason: 'Disk-format / fork-bomb / raw device write',
  },
  {
    pattern: /\bdd\b.*\bof=\/dev\//,
    severity: 'critical',
    reason: 'Raw write to a block device',
  },
  {
    pattern: /\bchmod\s+(-R\s+)?0?777\b/,
    severity: 'high',
    reason: 'World-writable permissions',
  },
  {
    pattern: /\b(curl|wget)\b[^\n|]*\|\s*(sudo\s+)?(sh|bash|zsh|python[0-9.]*)\b/,
    severity: 'critical',
    reason: 'Piping remote content directly into a shell',
  },
  {
    pattern: /\bsudo\b/,
    severity: 'medium',
    reason: 'Privilege escalation',
  },
  {
    pattern: /\b(shutdown|reboot|halt|poweroff)\b|Stop-Computer|Restart-Computer/i,
    severity: 'high',
    reason: 'Host power-state change',
  },
  {
    pattern: /\bgit\b.*\bpush\b.*(--force|-f)\b/,
    severity: 'medium',
    reason: 'Force push can overwrite remote history',
  },
  {
    pattern: />\s*\/dev\/sd[a-z]|\bRemove-Item\b.*-Recurse.*-Force/i,
    severity: 'critical',
    reason: 'Destructive overwrite / recursive force removal',
  },
];

const SEVERITY_ORDER: Record<RiskSeverity, number> = {
  low: 0,
  medium: 1,
  high: 2,
  critical: 3,
};

export function assessCommand(command: string): RiskFinding | null {
  const trimmed = command.trim();
  if (!trimmed) return null;

  let best: RiskFinding | null = null;
  for (const rule of RULES) {
    if (rule.pattern.test(trimmed)) {
      const finding: RiskFinding = {
        command: trimmed,
        severity: rule.severity,
        reason: rule.reason,
        pattern: rule.pattern.source,
      };
      if (!best || SEVERITY_ORDER[finding.severity] > SEVERITY_ORDER[best.severity]) {
        best = finding;
      }
    }
  }
  return best;
}

export function isCritical(command: string): boolean {
  const f = assessCommand(command);
  return f?.severity === 'critical';
}

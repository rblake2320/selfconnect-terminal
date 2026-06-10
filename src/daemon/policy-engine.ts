import type { ConfidenceDecision, ProviderTier, RiskSeverity } from '../shared/contracts';

/**
 * Policy engine. Owns the security decisions that gate model calls:
 *   - HARD RULE 7: local-only mode hard-blocks all cloud providers.
 *   - HARD RULE 8: cloud sends and premium escalation require approval.
 *   - HARD RULE 10: per-call spend cap refuses over-budget cloud calls.
 *
 * Pure decision logic — no I/O, no timers — so it is fully unit testable.
 */

export interface PolicyInput {
  tier: ProviderTier;
  estimatedCostUsd: number;
}

export interface PolicyDecision {
  blocked: boolean;
  blockReason?: string;
  requiresApproval: boolean;
  approvalKind?: 'cloud-send' | 'premium-escalation';
}

export interface PolicyOptions {
  localOnly: boolean;
  maxSpendPerCallUsd: number;
}

export class PolicyEngine {
  constructor(private opts: PolicyOptions) {}

  get localOnly(): boolean {
    return this.opts.localOnly;
  }

  setLocalOnly(value: boolean): void {
    this.opts.localOnly = value;
  }

  get maxSpendPerCallUsd(): number {
    return this.opts.maxSpendPerCallUsd;
  }

  evaluate(input: PolicyInput): PolicyDecision {
    const isCloud = input.tier === 'cloud' || input.tier === 'premium';

    // RULE 7 — local-only is an absolute block on cloud, regardless of keys.
    if (this.opts.localOnly && isCloud) {
      return {
        blocked: true,
        blockReason: 'LOCAL_ONLY mode active: cloud providers are hard-blocked',
        requiresApproval: false,
      };
    }

    // Local tier: never blocked, never needs approval, no spend cap.
    if (!isCloud) {
      return { blocked: false, requiresApproval: false };
    }

    // RULE 10 — per-call spend cap on cloud calls.
    if (input.estimatedCostUsd > this.opts.maxSpendPerCallUsd) {
      return {
        blocked: true,
        blockReason: `Estimated $${input.estimatedCostUsd.toFixed(
          4,
        )} exceeds per-call cap $${this.opts.maxSpendPerCallUsd.toFixed(4)}`,
        requiresApproval: false,
      };
    }

    // RULE 8 — cloud send / premium escalation require explicit approval.
    return {
      blocked: false,
      requiresApproval: true,
      approvalKind: input.tier === 'premium' ? 'premium-escalation' : 'cloud-send',
    };
  }
}

/**
 * E6 uncertainty router (pure). A reported confidence is judged against a
 * threshold AND the action's blast radius:
 *   - high blast radius = mutating OR risk >= high;
 *   - confidence at/above threshold => proceed (the actor is sure enough);
 *   - below threshold + high blast radius => escalate to human approval;
 *   - below threshold + low blast radius => verify (force a dry-run first).
 * No I/O — fully unit testable. The registry maps `verify`/`escalate` onto its
 * approval gate (both attach a simulation preview as evidence).
 */
export function routeConfidence(input: {
  tool: string;
  mutating: boolean;
  risk: RiskSeverity;
  confidence: number;
  threshold: number;
}): ConfidenceDecision {
  const highBlastRadius = input.mutating || input.risk === 'high' || input.risk === 'critical';
  const confident = input.confidence >= input.threshold;
  let route: ConfidenceDecision['route'];
  let reason: string;
  if (confident) {
    route = 'proceed';
    reason = `confidence ${input.confidence.toFixed(2)} >= threshold ${input.threshold.toFixed(2)}`;
  } else if (highBlastRadius) {
    route = 'escalate';
    reason = `low confidence ${input.confidence.toFixed(2)} on high-blast-radius action — human approval required`;
  } else {
    route = 'verify';
    reason = `low confidence ${input.confidence.toFixed(2)} — dry-run verification before proceeding`;
  }
  return { route, confidence: input.confidence, threshold: input.threshold, highBlastRadius, reason };
}

import type { ProviderTier } from '../shared/contracts';

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

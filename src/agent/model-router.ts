import type { ProviderKind, RouteDecision } from '../shared/contracts';
import { PolicyEngine } from '../daemon/policy-engine';
import type { ProviderRegistry } from './provider-registry';
import type { ModelProvider } from './providers/base';

/**
 * Model Router. Chooses a provider/model and produces a RouteDecision that
 * carries the routing reason and the policy verdict (blocked / requiresApproval).
 *
 * Routing preference, in order:
 *   1. If local-only: always local (cloud is hard-blocked by policy).
 *   2. Caller's explicit preference, if configured.
 *   3. Local provider as the safe default.
 *
 * The router never performs the call; it only decides + annotates. The daemon
 * enforces the decision (redaction, approval, spend) before any provider runs.
 */
export interface RouteInput {
  /** Optional caller preference (e.g. escalate to cloud for a hard review). */
  prefer?: ProviderKind;
  estimatedCostUsd: number;
}

export class ModelRouter {
  constructor(
    private readonly registry: ProviderRegistry,
    private readonly policy: PolicyEngine,
  ) {}

  private pick(input: RouteInput): { provider: ModelProvider; reason: string } {
    if (this.policy.localOnly) {
      return {
        provider: this.registry.local(),
        reason: 'LOCAL_ONLY active — routed to local provider',
      };
    }
    if (input.prefer) {
      const p = this.registry.get(input.prefer);
      if (p.isConfigured()) {
        return { provider: p, reason: `caller preference: ${input.prefer}` };
      }
      return {
        provider: this.registry.local(),
        reason: `preferred provider ${input.prefer} not configured — fell back to local`,
      };
    }
    return { provider: this.registry.local(), reason: 'default local-first routing' };
  }

  route(input: RouteInput): RouteDecision {
    const { provider, reason } = this.pick(input);
    const decision = this.policy.evaluate({
      tier: provider.tier,
      estimatedCostUsd: input.estimatedCostUsd,
    });
    return {
      provider: provider.kind,
      model: provider.model,
      tier: provider.tier,
      reason,
      requiresApproval: decision.requiresApproval,
      blocked: decision.blocked,
      blockReason: decision.blockReason,
    };
  }
}

import { describe, it, expect } from 'vitest';
import { PolicyEngine } from '../src/daemon/policy-engine';

describe('policy engine', () => {
  it('local tier is never blocked and never needs approval', () => {
    const p = new PolicyEngine({ localOnly: false, maxSpendPerCallUsd: 0.25 });
    const d = p.evaluate({ tier: 'local', estimatedCostUsd: 999 });
    expect(d.blocked).toBe(false);
    expect(d.requiresApproval).toBe(false);
  });

  it('local-only hard-blocks cloud regardless of cost', () => {
    const p = new PolicyEngine({ localOnly: true, maxSpendPerCallUsd: 100 });
    const d = p.evaluate({ tier: 'cloud', estimatedCostUsd: 0 });
    expect(d.blocked).toBe(true);
    expect(d.blockReason).toMatch(/LOCAL_ONLY/);
  });

  it('local-only hard-blocks premium too', () => {
    const p = new PolicyEngine({ localOnly: true, maxSpendPerCallUsd: 100 });
    const d = p.evaluate({ tier: 'premium', estimatedCostUsd: 0 });
    expect(d.blocked).toBe(true);
  });

  it('cloud send requires approval when under cap', () => {
    const p = new PolicyEngine({ localOnly: false, maxSpendPerCallUsd: 0.25 });
    const d = p.evaluate({ tier: 'cloud', estimatedCostUsd: 0.1 });
    expect(d.blocked).toBe(false);
    expect(d.requiresApproval).toBe(true);
    expect(d.approvalKind).toBe('cloud-send');
  });

  it('premium escalation requires its own approval kind', () => {
    const p = new PolicyEngine({ localOnly: false, maxSpendPerCallUsd: 0.25 });
    const d = p.evaluate({ tier: 'premium', estimatedCostUsd: 0.1 });
    expect(d.requiresApproval).toBe(true);
    expect(d.approvalKind).toBe('premium-escalation');
  });

  it('over-cap cloud calls are refused before approval', () => {
    const p = new PolicyEngine({ localOnly: false, maxSpendPerCallUsd: 0.25 });
    const d = p.evaluate({ tier: 'cloud', estimatedCostUsd: 0.5 });
    expect(d.blocked).toBe(true);
    expect(d.requiresApproval).toBe(false);
    expect(d.blockReason).toMatch(/cap/);
  });

  it('toggling local-only changes behavior', () => {
    const p = new PolicyEngine({ localOnly: false, maxSpendPerCallUsd: 0.25 });
    expect(p.evaluate({ tier: 'cloud', estimatedCostUsd: 0 }).blocked).toBe(false);
    p.setLocalOnly(true);
    expect(p.evaluate({ tier: 'cloud', estimatedCostUsd: 0 }).blocked).toBe(true);
  });
});

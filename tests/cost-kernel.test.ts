import { describe, it, expect } from 'vitest';
import { CostKernel, priceFor, estimateTokens } from '../src/agent/cost-kernel';

const baseline = { inputPerMillion: 3, outputPerMillion: 15 };

function makeKernel() {
  return new CostKernel({ perCallCapUsd: 0.25, baseline });
}

describe('cost kernel', () => {
  it('local cost is 0 and avoided spend is > 0', () => {
    const k = makeKernel();
    const est = k.estimate('local', 100_000, 50_000, { inputPerMillion: 0, outputPerMillion: 0 });
    expect(est.costUsd).toBe(0);
    expect(est.avoidedUsd).toBeGreaterThan(0);
    // 100k in * $3/M + 50k out * $15/M = 0.30 + 0.75 = 1.05
    expect(est.avoidedUsd).toBeCloseTo(1.05, 5);
  });

  it('records local spend as 0 and accumulates avoided spend', () => {
    const k = makeKernel();
    k.record('local', 1_000_000, 0, { inputPerMillion: 0, outputPerMillion: 0 });
    const snap = k.snapshot();
    expect(snap.sessionSpendUsd).toBe(0);
    expect(snap.avoidedSpendUsd).toBeCloseTo(3, 5);
    expect(snap.last?.kind).toBe('VERIFIED');
  });

  it('cloud cost respects env-configured pricing', () => {
    const k = makeKernel();
    const cloudPrice = { inputPerMillion: 3, outputPerMillion: 15 };
    const est = k.estimate('cloud', 1_000_000, 1_000_000, cloudPrice);
    expect(est.costUsd).toBeCloseTo(18, 5); // 3 + 15
    expect(est.avoidedUsd).toBe(0);
  });

  it('accumulates cloud session spend across calls', () => {
    const k = makeKernel();
    const cloudPrice = { inputPerMillion: 3, outputPerMillion: 15 };
    k.record('cloud', 1_000_000, 0, cloudPrice); // $3
    k.record('cloud', 0, 1_000_000, cloudPrice); // $15
    expect(k.snapshot().sessionSpendUsd).toBeCloseTo(18, 5);
  });

  it('priceFor and estimateTokens helpers behave', () => {
    expect(priceFor(1_000_000, 0, baseline)).toBeCloseTo(3, 5);
    expect(estimateTokens('abcd')).toBe(1);
    expect(estimateTokens('')).toBe(0);
  });

  it('exposes per-call cap from snapshot', () => {
    const k = makeKernel();
    expect(k.snapshot().perCallCapUsd).toBe(0.25);
  });
});

describe('cost kernel v3 — Context Economy counters', () => {
  it('books dedup savings at baseline cloud input pricing', () => {
    const k = makeKernel();
    k.recordDedup(1_000_000);
    const s = k.snapshot();
    expect(s.tokensNotResent).toBe(1_000_000);
    expect(s.cacheSavingsUsd).toBeCloseTo(3, 5);
  });

  it('ignores non-positive dedup amounts', () => {
    const k = makeKernel();
    k.recordDedup(0);
    k.recordDedup(-5);
    expect(k.snapshot().tokensNotResent).toBe(0);
  });

  it('books distillation savings at baseline cloud input pricing', () => {
    const k = makeKernel();
    k.recordDistillation(2_000_000);
    expect(k.snapshot().distillationSavingsUsd).toBeCloseTo(6, 5);
  });

  it('computes context efficiency as fresh/total %, 100 when nothing accounted', () => {
    const k = makeKernel();
    expect(k.contextEfficiencyPct()).toBe(100);
    k.accountContext(250, 1000);
    expect(k.contextEfficiencyPct()).toBeCloseTo(25, 5);
    expect(k.snapshot().contextEfficiencyPct).toBeCloseTo(25, 5);
  });

  it('restores the v3 counters from a snapshot on resume', () => {
    const k = makeKernel();
    k.recordDedup(500_000);
    k.recordDistillation(500_000);
    k.accountContext(100, 200);
    const snap = k.snapshot();
    const k2 = makeKernel();
    k2.restore(snap);
    const restored = k2.snapshot();
    expect(restored.tokensNotResent).toBe(snap.tokensNotResent);
    expect(restored.cacheSavingsUsd).toBeCloseTo(snap.cacheSavingsUsd, 8);
    expect(restored.distillationSavingsUsd).toBeCloseTo(snap.distillationSavingsUsd, 8);
  });
});

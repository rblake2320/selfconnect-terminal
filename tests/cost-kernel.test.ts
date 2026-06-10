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

import { describe, it, expect } from 'vitest';
import { ContextGauge, levelFor, actionFor } from '../src/daemon/context-gauge';

describe('levelFor / actionFor thresholds', () => {
  it('maps pressure to levels per spec', () => {
    expect(levelFor(0)).toBe('normal');
    expect(levelFor(59.9)).toBe('normal');
    expect(levelFor(60)).toBe('warn');
    expect(levelFor(79.9)).toBe('warn');
    expect(levelFor(80)).toBe('danger');
    expect(levelFor(89.9)).toBe('danger');
    expect(levelFor(90)).toBe('migrate');
    expect(levelFor(100)).toBe('migrate');
  });

  it('maps levels to actuator actions', () => {
    expect(actionFor('normal')).toBe('none');
    expect(actionFor('warn')).toBe('compact');
    expect(actionFor('danger')).toBe('dedup');
    expect(actionFor('migrate')).toBe('migrate');
  });
});

describe('ContextGauge actuation', () => {
  it('tracks hot/warm/pinned in the used total', () => {
    const g = new ContextGauge(1000);
    g.add(100);
    g.addWarm(50);
    g.setPinnedTokens(30);
    expect(g.used).toBe(180);
    const s = g.snapshot();
    expect(s.hotTokens).toBe(100);
    expect(s.warmTokens).toBe(50);
    expect(s.pinnedTokens).toBe(30);
  });

  it('recommends compact at warn, dedup at danger, migrate at migrate', () => {
    const g = new ContextGauge(1000);
    g.add(650); // 65%
    expect(g.recommendedAction()).toBe('compact');
    g.add(200); // 85%
    expect(g.recommendedAction()).toBe('dedup');
    g.add(100); // 95%
    expect(g.recommendedAction()).toBe('migrate');
  });

  it('compacts hot to warm at a discount and increments compactions', () => {
    const g = new ContextGauge(10_000);
    g.add(1000);
    const warmAdded = g.compactHotToWarm(800, 0.15);
    expect(warmAdded).toBe(Math.ceil(800 * 0.15));
    const s = g.snapshot();
    expect(s.hotTokens).toBe(200);
    expect(s.warmTokens).toBe(warmAdded);
    expect(s.compactions).toBe(1);
    expect(s.usedTokens).toBeLessThan(1000); // net reduction
  });

  it('records dedup hits', () => {
    const g = new ContextGauge();
    g.recordDedupHit();
    g.recordDedupHit();
    expect(g.snapshot().dedupHits).toBe(2);
  });

  it('reset clears hot+warm but restoreBreakdown reseeds counters', () => {
    const g = new ContextGauge();
    g.add(500);
    g.reset();
    expect(g.used).toBe(0);
    g.restoreBreakdown({ hotTokens: 10, warmTokens: 5, pinnedTokens: 2, dedupHits: 3, compactions: 1 });
    const s = g.snapshot();
    expect(s.hotTokens).toBe(10);
    expect(s.warmTokens).toBe(5);
    expect(s.pinnedTokens).toBe(2);
    expect(s.dedupHits).toBe(3);
    expect(s.compactions).toBe(1);
  });

  it('caps pressure at 100', () => {
    const g = new ContextGauge(100);
    g.add(500);
    expect(g.snapshot().pressure).toBe(100);
    expect(g.level()).toBe('migrate');
  });
});

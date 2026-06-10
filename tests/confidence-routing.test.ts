import { describe, it, expect } from 'vitest';
import { routeConfidence } from '../src/daemon/policy-engine';

describe('E6 confidence routing (pure)', () => {
  it('proceeds when confidence is at/above threshold regardless of blast radius', () => {
    const d = routeConfidence({
      tool: 'write_file',
      mutating: true,
      risk: 'high',
      confidence: 0.9,
      threshold: 0.5,
    });
    expect(d.route).toBe('proceed');
    expect(d.highBlastRadius).toBe(true);
  });

  it('escalates low confidence on a high-blast-radius (mutating) action', () => {
    const d = routeConfidence({
      tool: 'write_file',
      mutating: true,
      risk: 'low',
      confidence: 0.2,
      threshold: 0.5,
    });
    expect(d.route).toBe('escalate');
    expect(d.highBlastRadius).toBe(true);
    expect(d.reason).toMatch(/human approval/);
  });

  it('escalates low confidence on a high-risk read-only action', () => {
    const d = routeConfidence({
      tool: 'web_search',
      mutating: false,
      risk: 'high',
      confidence: 0.1,
      threshold: 0.5,
    });
    expect(d.route).toBe('escalate');
    expect(d.highBlastRadius).toBe(true);
  });

  it('verifies (dry-run) low confidence on a low-blast-radius action', () => {
    const d = routeConfidence({
      tool: 'read_file',
      mutating: false,
      risk: 'low',
      confidence: 0.2,
      threshold: 0.5,
    });
    expect(d.route).toBe('verify');
    expect(d.highBlastRadius).toBe(false);
    expect(d.reason).toMatch(/dry-run/);
  });

  it('treats exactly-at-threshold as confident (>=)', () => {
    const d = routeConfidence({
      tool: 'read_file',
      mutating: false,
      risk: 'low',
      confidence: 0.5,
      threshold: 0.5,
    });
    expect(d.route).toBe('proceed');
  });

  it('critical risk counts as high blast radius', () => {
    const d = routeConfidence({
      tool: 'bash',
      mutating: false,
      risk: 'critical',
      confidence: 0,
      threshold: 0.5,
    });
    expect(d.highBlastRadius).toBe(true);
    expect(d.route).toBe('escalate');
  });
});

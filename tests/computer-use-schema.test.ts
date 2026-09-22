import { describe, it, expect } from 'vitest';
import {
  ComputerActionSchema,
  ComputerSessionRequestSchema,
  ComputerTargetSchema,
  ComputerPaidConsentSchema,
  COMPUTER_KEY_COMBOS,
  validateComputerAction,
  type ComputerActionContext,
} from '../src/shared/computer-use';

const target = { hwnd: 31982268, pid: 138772, exe: 'notepad.exe', className: 'Notepad', title: 'Untitled - Notepad' };
const base = { sessionId: 'cu-1', sequence: 2, observationId: 'obs-1' };
const ctx: ComputerActionContext = { sessionId: 'cu-1', expectedSequence: 2, latestObservationId: 'obs-1', width: 800, height: 600, maxActions: 10 };

describe('ComputerTargetSchema', () => {
  it('accepts a full identity and rejects partial or zero identities', () => {
    expect(ComputerTargetSchema.safeParse(target).success).toBe(true);
    expect(ComputerTargetSchema.safeParse({ ...target, hwnd: 0 }).success).toBe(false);
    expect(ComputerTargetSchema.safeParse({ ...target, pid: -1 }).success).toBe(false);
    expect(ComputerTargetSchema.safeParse({ ...target, title: '' }).success).toBe(false);
    expect(ComputerTargetSchema.safeParse({ ...target, extra: 1 }).success).toBe(false);
    const { className: _c, ...missing } = target;
    expect(ComputerTargetSchema.safeParse(missing).success).toBe(false);
  });
});

describe('ComputerActionSchema', () => {
  it('accepts every action type in its valid form', () => {
    const ok = [
      { type: 'observe', sessionId: 'cu-1', sequence: 1 },
      { type: 'observe', ...base },
      { type: 'focus', ...base },
      { type: 'click', ...base, point: { x: 10, y: 20 } },
      { type: 'click', ...base, point: { x: 0, y: 0 }, button: 'right' },
      { type: 'type', ...base, text: 'hello\nworld\t!' },
      { type: 'keypress', ...base, keys: ['ctrl+home'] },
      { type: 'keypress', ...base, keys: ['ctrl+a', 'backspace'] },
      { type: 'scroll', ...base, delta: -3 },
      { type: 'scroll', ...base, delta: 10, point: { x: 5, y: 5 } },
      { type: 'wait', ...base, waitMs: 0 },
      { type: 'wait', ...base, waitMs: 2000 },
      { type: 'finish', ...base },
      { type: 'finish', ...base, summary: 'typed two lines' },
    ];
    for (const a of ok) expect(ComputerActionSchema.safeParse(a).success, JSON.stringify(a)).toBe(true);
  });

  it('defaults click button to left', () => {
    const r = ComputerActionSchema.parse({ type: 'click', ...base, point: { x: 1, y: 1 } });
    expect(r.type === 'click' && r.button).toBe('left');
  });

  it('rejects unknown types, unknown fields, and missing base fields', () => {
    expect(ComputerActionSchema.safeParse({ type: 'drag', ...base }).success).toBe(false);
    expect(ComputerActionSchema.safeParse({ type: 'focus', ...base, hidden: true }).success).toBe(false);
    expect(ComputerActionSchema.safeParse({ type: 'focus', sequence: 2, observationId: 'obs-1' }).success).toBe(false);
    expect(ComputerActionSchema.safeParse({ type: 'focus', sessionId: 'cu-1', sequence: 0, observationId: 'obs-1' }).success).toBe(false);
    expect(ComputerActionSchema.safeParse({ type: 'focus', sessionId: 'cu-1', sequence: 1.5, observationId: 'obs-1' }).success).toBe(false);
  });

  it('requires observationId for everything except the first observe, and never accepts an empty one', () => {
    expect(ComputerActionSchema.safeParse({ type: 'observe', sessionId: 'cu-1', sequence: 1 }).success).toBe(true);
    expect(ComputerActionSchema.safeParse({ type: 'observe', sessionId: 'cu-1', sequence: 2 }).success).toBe(false);
    expect(ComputerActionSchema.safeParse({ type: 'focus', sessionId: 'cu-1', sequence: 1 }).success).toBe(false);
    expect(ComputerActionSchema.safeParse({ type: 'focus', sessionId: 'cu-1', sequence: 1, observationId: '' }).success).toBe(false);
    expect(ComputerActionSchema.safeParse({ type: 'observe', sessionId: 'cu-1', sequence: 1, observationId: '' }).success).toBe(false);
  });

  it('bounds click coordinates to non-negative integers', () => {
    expect(ComputerActionSchema.safeParse({ type: 'click', ...base, point: { x: -1, y: 0 } }).success).toBe(false);
    expect(ComputerActionSchema.safeParse({ type: 'click', ...base, point: { x: 1.5, y: 0 } }).success).toBe(false);
    expect(ComputerActionSchema.safeParse({ type: 'click', ...base }).success).toBe(false);
    expect(ComputerActionSchema.safeParse({ type: 'click', ...base, point: { x: 1, y: 1 }, button: 'middle' }).success).toBe(false);
  });

  it('bounds typed text and rejects control characters', () => {
    expect(ComputerActionSchema.safeParse({ type: 'type', ...base, text: '' }).success).toBe(false);
    expect(ComputerActionSchema.safeParse({ type: 'type', ...base, text: 'x'.repeat(2000) }).success).toBe(true);
    expect(ComputerActionSchema.safeParse({ type: 'type', ...base, text: 'x'.repeat(2001) }).success).toBe(false);
    expect(ComputerActionSchema.safeParse({ type: 'type', ...base, text: 'a\x1b[2Jb' }).success).toBe(false);
    expect(ComputerActionSchema.safeParse({ type: 'type', ...base, text: 'a\x00b' }).success).toBe(false);
  });

  it('allows only allowlisted key combos, 1 to 5 per action', () => {
    for (const k of COMPUTER_KEY_COMBOS) expect(ComputerActionSchema.safeParse({ type: 'keypress', ...base, keys: [k] }).success, k).toBe(true);
    expect(ComputerActionSchema.safeParse({ type: 'keypress', ...base, keys: [] }).success).toBe(false);
    expect(ComputerActionSchema.safeParse({ type: 'keypress', ...base, keys: ['ctrl+alt+delete'] }).success).toBe(false);
    expect(ComputerActionSchema.safeParse({ type: 'keypress', ...base, keys: ['win+r'] }).success).toBe(false);
    expect(ComputerActionSchema.safeParse({ type: 'keypress', ...base, keys: ['Enter'] }).success).toBe(false);
    for (const k of ['ctrl+c', 'ctrl+v', 'ctrl+x', 'ctrl+s', 'ctrl+f', 'ctrl+z', 'alt+f4', 'win+d']) {
      expect(ComputerActionSchema.safeParse({ type: 'keypress', ...base, keys: [k] }).success, k).toBe(false);
    }
    expect(ComputerActionSchema.safeParse({ type: 'keypress', ...base, keys: ['tab', 'tab', 'tab', 'tab', 'tab', 'tab'] }).success).toBe(false);
  });

  it('bounds scroll and wait', () => {
    expect(ComputerActionSchema.safeParse({ type: 'scroll', ...base, delta: 0 }).success).toBe(false);
    expect(ComputerActionSchema.safeParse({ type: 'scroll', ...base, delta: 11 }).success).toBe(false);
    expect(ComputerActionSchema.safeParse({ type: 'scroll', ...base, delta: -11 }).success).toBe(false);
    expect(ComputerActionSchema.safeParse({ type: 'scroll', ...base, delta: 2.5 }).success).toBe(false);
    expect(ComputerActionSchema.safeParse({ type: 'wait', ...base, waitMs: -1 }).success).toBe(false);
    expect(ComputerActionSchema.safeParse({ type: 'wait', ...base, waitMs: 2001 }).success).toBe(false);
  });
});

describe('ComputerSessionRequestSchema', () => {
  const sub = { target, objective: 'type two lines in Notepad', executionMode: 'desktop_assist', billingMode: 'subscription_only' };
  const consent = { provider: 'anthropic', model: 'claude-sonnet-5', sessionCapUsd: 2, taskCapUsd: 0.5, projectCapUsd: 25, priceInputPerMillion: 2, priceOutputPerMillion: 10, acknowledgeSeparateBilling: true };

  it('applies defaults and accepts subscription_only', () => {
    const r = ComputerSessionRequestSchema.parse(sub);
    expect(r.maxActions).toBe(10);
    expect(r.maxMinutes).toBe(5);
    expect(r.paidConsent).toBeUndefined();
  });

  it('only accepts desktop_assist and the two billing modes', () => {
    expect(ComputerSessionRequestSchema.safeParse({ ...sub, executionMode: 'desktop_visible' }).success).toBe(false);
    expect(ComputerSessionRequestSchema.safeParse({ ...sub, billingMode: 'paid' }).success).toBe(false);
    expect(ComputerSessionRequestSchema.safeParse({ ...sub, billingMode: 'subscription' }).success).toBe(false);
    expect(ComputerSessionRequestSchema.safeParse({ ...sub, unknown: 1 }).success).toBe(false);
  });

  it('bounds action and time budgets', () => {
    expect(ComputerSessionRequestSchema.safeParse({ ...sub, maxActions: 0 }).success).toBe(false);
    expect(ComputerSessionRequestSchema.safeParse({ ...sub, maxActions: 31 }).success).toBe(false);
    expect(ComputerSessionRequestSchema.safeParse({ ...sub, maxMinutes: 16 }).success).toBe(false);
    expect(ComputerSessionRequestSchema.safeParse({ ...sub, objective: '' }).success).toBe(false);
  });

  it('paid_api is unrepresentable without full explicit consent', () => {
    expect(ComputerSessionRequestSchema.safeParse({ ...sub, billingMode: 'paid_api' }).success).toBe(false);
    expect(ComputerSessionRequestSchema.safeParse({ ...sub, billingMode: 'paid_api', paidConsent: consent }).success).toBe(true);
    expect(ComputerSessionRequestSchema.safeParse({ ...sub, billingMode: 'paid_api', paidConsent: { ...consent, acknowledgeSeparateBilling: false } }).success).toBe(false);
    expect(ComputerSessionRequestSchema.safeParse({ ...sub, billingMode: 'paid_api', paidConsent: { ...consent, acknowledgeSeparateBilling: 'yes' } }).success).toBe(false);
    expect(ComputerSessionRequestSchema.safeParse({ ...sub, billingMode: 'paid_api', paidConsent: { ...consent, provider: 'openai' } }).success).toBe(false);
    const { priceInputPerMillion: _p, ...noPrice } = consent;
    expect(ComputerSessionRequestSchema.safeParse({ ...sub, billingMode: 'paid_api', paidConsent: noPrice }).success).toBe(false);
  });

  it('caps are bounded and ordered', () => {
    expect(ComputerPaidConsentSchema.safeParse({ ...consent, sessionCapUsd: 2.01 }).success).toBe(false);
    expect(ComputerPaidConsentSchema.safeParse({ ...consent, taskCapUsd: 0.51 }).success).toBe(false);
    expect(ComputerPaidConsentSchema.safeParse({ ...consent, projectCapUsd: 25.5 }).success).toBe(false);
    expect(ComputerPaidConsentSchema.safeParse({ ...consent, sessionCapUsd: 0 }).success).toBe(false);
    expect(ComputerSessionRequestSchema.safeParse({ ...sub, billingMode: 'paid_api', paidConsent: { ...consent, taskCapUsd: 0.5, sessionCapUsd: 0.4 } }).success).toBe(false);
    expect(ComputerSessionRequestSchema.safeParse({ ...sub, billingMode: 'paid_api', paidConsent: { ...consent, sessionCapUsd: 2, projectCapUsd: 1 } }).success).toBe(false);
  });

  it('subscription_only must not carry consent (no silent paid upgrade)', () => {
    expect(ComputerSessionRequestSchema.safeParse({ ...sub, paidConsent: consent }).success).toBe(false);
  });
});

describe('validateComputerAction', () => {
  it('accepts a well-formed action bound to the latest observation', () => {
    const r = validateComputerAction({ type: 'click', ...base, point: { x: 799, y: 599 } }, ctx);
    expect(r.ok).toBe(true);
  });

  it('reports schema failures with a path', () => {
    const r = validateComputerAction({ type: 'click', ...base, point: { x: -1, y: 0 } }, ctx);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/^schema: point\.x/);
  });

  it('rejects session, sequence, and budget mismatches', () => {
    expect(validateComputerAction({ type: 'focus', ...base, sessionId: 'other' }, ctx)).toEqual({ ok: false, reason: 'session id mismatch' });
    expect(validateComputerAction({ type: 'focus', ...base, sequence: 3 }, ctx).ok).toBe(false);
    expect(validateComputerAction({ type: 'focus', ...base, sequence: 11 }, { ...ctx, expectedSequence: 11, maxActions: 10 }).ok).toBe(false);
  });

  it('rejects actions bound to a stale or unknown observation', () => {
    const r = validateComputerAction({ type: 'focus', ...base, observationId: 'obs-0' }, ctx);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/stale or unknown observation/);
    const none = validateComputerAction({ type: 'focus', ...base }, { ...ctx, latestObservationId: null });
    expect(none.ok).toBe(false);
  });

  it('allows the first observe without an observation and nothing else', () => {
    const first: ComputerActionContext = { ...ctx, expectedSequence: 1, latestObservationId: null };
    expect(validateComputerAction({ type: 'observe', sessionId: 'cu-1', sequence: 1 }, first).ok).toBe(true);
    expect(validateComputerAction({ type: 'focus', sessionId: 'cu-1', sequence: 1, observationId: 'x' }, first).ok).toBe(false);
  });

  it('rejects points outside the captured window (click and scroll)', () => {
    expect(validateComputerAction({ type: 'click', ...base, point: { x: 800, y: 0 } }, ctx).ok).toBe(false);
    expect(validateComputerAction({ type: 'click', ...base, point: { x: 0, y: 600 } }, ctx).ok).toBe(false);
    expect(validateComputerAction({ type: 'scroll', ...base, delta: 1, point: { x: 900, y: 1 } }, ctx).ok).toBe(false);
    expect(validateComputerAction({ type: 'scroll', ...base, delta: 1 }, ctx).ok).toBe(true);
  });
});

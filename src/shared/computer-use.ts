import { z } from 'zod';

/**
 * Computer-use executor contracts (provider-neutral).
 *
 * Owned by the Claude partner lane (see docs/ecosystem-20260922/computer-use-ownership.md).
 * These are pure schemas + one pure validator. Nothing here performs I/O, spawns a driver,
 * or contacts a model. Window dimensions, observation staleness, grants and approvals are
 * enforced by the daemon controller (lead lane); `validateComputerAction` is a pre-check the
 * controller may call so that a malformed or out-of-scope proposal is rejected before any
 * governance step spends effort on it.
 *
 * Billing: `billingMode` is an explicit enum. `subscription_only` means no model API is ever
 * called for this session. `paid_api` is only representable together with a `paidConsent`
 * object whose `acknowledgeSeparateBilling` is the literal `true`, so a paid session cannot be
 * created by default, by omission, or by a subscription token. Nothing in this file implies a
 * Claude or Claude Code subscription covers API computer use; it does not.
 */

// ---------------------------------------------------------------------------
// Targets and points
// ---------------------------------------------------------------------------

export const ComputerTargetSchema = z
  .object({
    hwnd: z.number().int().positive(),
    pid: z.number().int().positive(),
    exe: z.string().min(1),
    className: z.string().min(1),
    title: z.string().min(1),
  })
  .strict();
export type ComputerTarget = z.infer<typeof ComputerTargetSchema>;

export const ComputerPointSchema = z
  .object({
    x: z.number().int().nonnegative(),
    y: z.number().int().nonnegative(),
  })
  .strict();
export type ComputerPoint = z.infer<typeof ComputerPointSchema>;

// ---------------------------------------------------------------------------
// Actions
// ---------------------------------------------------------------------------

export const COMPUTER_ACTION_TYPES = ['observe', 'focus', 'click', 'type', 'keypress', 'scroll', 'wait', 'finish'] as const;
export type ComputerActionType = (typeof COMPUTER_ACTION_TYPES)[number];

/** Closed allowlist of key combinations the driver may be asked to press. Anything else is rejected. */
/**
 * MVP list per lead clarification: navigation and editing only. Deliberately excluded: clipboard
 * (ctrl+c/v/x), save/find/undo dialogs (ctrl+s/f/z/y), window close (alt+f4), and any win/alt combo.
 */
export const COMPUTER_KEY_COMBOS = [
  'enter', 'tab', 'escape', 'backspace', 'delete', 'home', 'end', 'pageup', 'pagedown',
  'up', 'down', 'left', 'right', 'space',
  'ctrl+a', 'ctrl+home', 'ctrl+end', 'shift+tab',
] as const;
export type ComputerKeyCombo = (typeof COMPUTER_KEY_COMBOS)[number];

export const COMPUTER_TEXT_MAX = 2000;
export const COMPUTER_WAIT_MAX_MS = 2000;
export const COMPUTER_SCROLL_MAX = 10;
export const COMPUTER_MAX_ACTIONS = 30;
export const COMPUTER_MAX_MINUTES = 15;

// Printable text plus newline/tab only: no other control characters may be typed into a window.
const TYPEABLE_TEXT = /^[^\x00-\x08\x0b-\x1f\x7f]*$/;

const base = {
  sessionId: z.string().min(1),
  sequence: z.number().int().positive(),
  /** Id of the observation this action was decided from. Required for every action except the first observe. */
  observationId: z.string().min(1),
};

// observationId is optional only for the very first observe; enforced on the union below
// (zod discriminated unions cannot carry per-member refinements).
const ObserveAction = z.object({ type: z.literal('observe'), ...base, observationId: z.string().min(1).optional() }).strict();
const FocusAction = z.object({ type: z.literal('focus'), ...base }).strict();
const ClickAction = z
  .object({ type: z.literal('click'), ...base, point: ComputerPointSchema, button: z.enum(['left', 'right']).default('left') })
  .strict();
const TypeAction = z
  .object({ type: z.literal('type'), ...base, text: z.string().min(1).max(COMPUTER_TEXT_MAX).regex(TYPEABLE_TEXT, 'text contains control characters') })
  .strict();
const KeypressAction = z
  .object({ type: z.literal('keypress'), ...base, keys: z.array(z.enum(COMPUTER_KEY_COMBOS)).min(1).max(5) })
  .strict();
const ScrollAction = z
  .object({
    type: z.literal('scroll'),
    ...base,
    delta: z.number().int().min(-COMPUTER_SCROLL_MAX).max(COMPUTER_SCROLL_MAX).refine((d) => d !== 0, 'scroll delta must be nonzero'),
    point: ComputerPointSchema.optional(),
  })
  .strict();
const WaitAction = z.object({ type: z.literal('wait'), ...base, waitMs: z.number().int().min(0).max(COMPUTER_WAIT_MAX_MS) }).strict();
const FinishAction = z.object({ type: z.literal('finish'), ...base, summary: z.string().max(500).optional() }).strict();

export const ComputerActionSchema = z
  .discriminatedUnion('type', [ObserveAction, FocusAction, ClickAction, TypeAction, KeypressAction, ScrollAction, WaitAction, FinishAction])
  .superRefine((a, ctx) => {
    if (a.type === 'observe' && a.observationId === undefined && a.sequence !== 1) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['observationId'], message: 'observationId is required after the first observe' });
    }
  });
export type ComputerAction = z.infer<typeof ComputerActionSchema>;

// ---------------------------------------------------------------------------
// Session request + billing consent
// ---------------------------------------------------------------------------

/**
 * Explicit, per-session consent to a metered model API. Every field is required; there is no
 * default consent. Caps are hard upper bounds the controller must enforce in code.
 */
export const ComputerPaidConsentSchema = z
  .object({
    provider: z.literal('anthropic'),
    model: z.string().min(1),
    sessionCapUsd: z.number().positive().max(2),
    taskCapUsd: z.number().positive().max(0.5),
    projectCapUsd: z.number().positive().max(25),
    priceInputPerMillion: z.number().positive(),
    priceOutputPerMillion: z.number().positive(),
    /** The person starting the session acknowledges this is billed separately from any subscription. */
    acknowledgeSeparateBilling: z.literal(true),
  })
  .strict();
export type ComputerPaidConsent = z.infer<typeof ComputerPaidConsentSchema>;

export const COMPUTER_BILLING_MODES = ['subscription_only', 'paid_api'] as const;

export const ComputerSessionRequestSchema = z
  .object({
    target: ComputerTargetSchema,
    objective: z.string().min(1).max(1000),
    maxActions: z.number().int().min(1).max(COMPUTER_MAX_ACTIONS).default(10),
    maxMinutes: z.number().int().min(1).max(COMPUTER_MAX_MINUTES).default(5),
    executionMode: z.literal('desktop_assist'),
    billingMode: z.enum(COMPUTER_BILLING_MODES),
    paidConsent: ComputerPaidConsentSchema.optional(),
  })
  .strict()
  .superRefine((req, ctx) => {
    if (req.billingMode === 'paid_api' && !req.paidConsent) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['paidConsent'], message: 'paid_api requires explicit paidConsent' });
    }
    if (req.billingMode === 'subscription_only' && req.paidConsent) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['paidConsent'], message: 'subscription_only must not carry paidConsent' });
    }
    if (req.paidConsent && req.paidConsent.taskCapUsd > req.paidConsent.sessionCapUsd) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['paidConsent', 'taskCapUsd'], message: 'taskCapUsd cannot exceed sessionCapUsd' });
    }
    if (req.paidConsent && req.paidConsent.sessionCapUsd > req.paidConsent.projectCapUsd) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['paidConsent', 'sessionCapUsd'], message: 'sessionCapUsd cannot exceed projectCapUsd' });
    }
  });
export type ComputerSessionRequest = z.infer<typeof ComputerSessionRequestSchema>;

// ---------------------------------------------------------------------------
// Pure pre-validation against session context
// ---------------------------------------------------------------------------

export interface ComputerActionContext {
  sessionId: string;
  /** The sequence number the controller expects next (1-based, strictly increasing). */
  expectedSequence: number;
  /** Id of the most recent observation, or null before the first observe. */
  latestObservationId: string | null;
  /** Captured window size in pixels (points must lie inside [0,width) x [0,height)). */
  width: number;
  height: number;
  maxActions: number;
}

export type ComputerActionValidation = { ok: true; action: ComputerAction } | { ok: false; reason: string };

/**
 * Validate a proposed action against the session it claims to belong to. Order: schema,
 * session id, sequence, action budget, observation binding, coordinate bounds. Pure.
 */
export function validateComputerAction(input: unknown, ctx: ComputerActionContext): ComputerActionValidation {
  const parsed = ComputerActionSchema.safeParse(input);
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    return { ok: false, reason: `schema: ${first ? `${first.path.join('.') || '(root)'} ${first.message}` : 'invalid'}` };
  }
  const action = parsed.data;
  if (action.sessionId !== ctx.sessionId) return { ok: false, reason: 'session id mismatch' };
  if (action.sequence !== ctx.expectedSequence) {
    return { ok: false, reason: `sequence ${action.sequence} does not match expected ${ctx.expectedSequence}` };
  }
  if (action.sequence > ctx.maxActions) return { ok: false, reason: `action budget of ${ctx.maxActions} exhausted` };
  const firstObserve = action.type === 'observe' && action.sequence === 1;
  if (!firstObserve) {
    if (ctx.latestObservationId === null) return { ok: false, reason: 'no observation captured yet; observe first' };
    if (action.observationId !== ctx.latestObservationId) return { ok: false, reason: 'action is bound to a stale or unknown observation' };
  }
  const point = action.type === 'click' ? action.point : action.type === 'scroll' ? action.point : undefined;
  if (point && (point.x >= ctx.width || point.y >= ctx.height)) {
    return { ok: false, reason: `point (${point.x},${point.y}) is outside the ${ctx.width}x${ctx.height} window` };
  }
  return { ok: true, action };
}

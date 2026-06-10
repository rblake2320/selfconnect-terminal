import { z } from 'zod';

/**
 * Shared contracts: the single source of truth for the identity-stamped event
 * bus, the audit ledger entry shape, and every IPC payload. Both the daemon
 * (Electron main) and the renderer import from here so the wire format cannot
 * drift between the trusted and untrusted sides.
 */

// ---------------------------------------------------------------------------
// Identity — every non-output event must carry these three stamps.
// ---------------------------------------------------------------------------

export const IdentitySchema = z.object({
  sessionId: z.string().min(1),
  runId: z.string().min(1),
  agentId: z.string().min(1),
});
export type Identity = z.infer<typeof IdentitySchema>;

// ---------------------------------------------------------------------------
// Event bus
// ---------------------------------------------------------------------------

/**
 * Event types. `terminal.output` is the ONLY event exempt from identity stamps
 * (it is a raw, high-frequency byte stream from the PTY). Everything else is a
 * material, governed event and must be identity-stamped + ledgered.
 */
export const EventTypeSchema = z.enum([
  'terminal.output',
  'terminal.input',
  'terminal.spawn',
  'terminal.exit',
  'agent.spawn',
  'agent.exit',
  'run.start',
  'run.end',
  'route.decision',
  'cost.update',
  'context.update',
  'approval.requested',
  'approval.resolved',
  'redaction.applied',
  'risk.detected',
  'review.start',
  'review.result',
  'ledger.append',
  'ledger.verify',
  'policy.block',
  // --- v2 ---
  'session.snapshot',
  'session.resumed',
  'command.slash',
  'mcp.call',
  'mcp.result',
  'a2a.sent',
  'a2a.received',
  'a2a.chain_broken',
  'tool.call',
  'tool.result',
  'tool.blocked',
  'checkpoint.created',
  'checkpoint.restored',
  'todo.update',
  'hook.fired',
  'permission.mode',
]);
export type EventType = z.infer<typeof EventTypeSchema>;

/**
 * Base event. Non-output events MUST include identity. We model this with a
 * discriminated refinement: terminal.output may omit identity; all others
 * require it. `superRefine` enforces HARD SECURITY RULE 12.
 */
export const EventSchema = z
  .object({
    id: z.string().min(1),
    ts: z.number().int().nonnegative(),
    type: EventTypeSchema,
    sessionId: z.string().optional(),
    runId: z.string().optional(),
    agentId: z.string().optional(),
    payload: z.unknown().optional(),
  })
  .superRefine((evt, ctx) => {
    if (evt.type === 'terminal.output') return;
    if (!evt.sessionId || !evt.runId || !evt.agentId) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `event ${evt.type} requires sessionId/runId/agentId`,
      });
    }
  });
export type BusEvent = z.infer<typeof EventSchema>;

// ---------------------------------------------------------------------------
// Ledger
// ---------------------------------------------------------------------------

export const LedgerEntrySchema = z.object({
  seq: z.number().int().nonnegative(),
  ts: z.number().int().nonnegative(),
  type: EventTypeSchema,
  sessionId: z.string().optional(),
  runId: z.string().optional(),
  agentId: z.string().optional(),
  payload: z.unknown().optional(),
  prevHash: z.string(),
  hash: z.string(),
});
export type LedgerEntry = z.infer<typeof LedgerEntrySchema>;

export const ChainStatusSchema = z.object({
  ok: z.boolean(),
  entries: z.number().int().nonnegative(),
  lastHash: z.string(),
  brokenAt: z.number().int().nonnegative().nullable(),
});
export type ChainStatus = z.infer<typeof ChainStatusSchema>;

// ---------------------------------------------------------------------------
// Providers / routing
// ---------------------------------------------------------------------------

export const ProviderKindSchema = z.enum(['ollama', 'openai-compatible', 'anthropic']);
export type ProviderKind = z.infer<typeof ProviderKindSchema>;

export const ProviderTierSchema = z.enum(['local', 'cloud', 'premium']);
export type ProviderTier = z.infer<typeof ProviderTierSchema>;

export const RouteDecisionSchema = z.object({
  provider: ProviderKindSchema,
  model: z.string(),
  tier: ProviderTierSchema,
  reason: z.string(),
  requiresApproval: z.boolean(),
  blocked: z.boolean(),
  blockReason: z.string().optional(),
});
export type RouteDecision = z.infer<typeof RouteDecisionSchema>;

export const ProviderLivenessSchema = z.object({
  kind: ProviderKindSchema,
  alive: z.boolean(),
  detail: z.string(),
});
export type ProviderLiveness = z.infer<typeof ProviderLivenessSchema>;

// ---------------------------------------------------------------------------
// Cost kernel
// ---------------------------------------------------------------------------

export const CostEstimateSchema = z.object({
  kind: z.enum(['ESTIMATED', 'VERIFIED']),
  inputTokens: z.number().nonnegative(),
  outputTokens: z.number().nonnegative(),
  costUsd: z.number().nonnegative(),
  avoidedUsd: z.number().nonnegative(),
});
export type CostEstimate = z.infer<typeof CostEstimateSchema>;

export const CostSnapshotSchema = z.object({
  sessionSpendUsd: z.number().nonnegative(),
  avoidedSpendUsd: z.number().nonnegative(),
  perCallCapUsd: z.number().nonnegative(),
  last: CostEstimateSchema.nullable(),
});
export type CostSnapshot = z.infer<typeof CostSnapshotSchema>;

// ---------------------------------------------------------------------------
// Context gauge
// ---------------------------------------------------------------------------

export const ContextLevelSchema = z.enum(['normal', 'warn', 'danger', 'migrate']);
export type ContextLevel = z.infer<typeof ContextLevelSchema>;

export const ContextSnapshotSchema = z.object({
  usedTokens: z.number().nonnegative(),
  maxTokens: z.number().positive(),
  pressure: z.number().min(0).max(100),
  level: ContextLevelSchema,
});
export type ContextSnapshot = z.infer<typeof ContextSnapshotSchema>;

// ---------------------------------------------------------------------------
// Security sentinel
// ---------------------------------------------------------------------------

export const RiskSeveritySchema = z.enum(['low', 'medium', 'high', 'critical']);
export type RiskSeverity = z.infer<typeof RiskSeveritySchema>;

export const RiskFindingSchema = z.object({
  command: z.string(),
  severity: RiskSeveritySchema,
  reason: z.string(),
  pattern: z.string(),
});
export type RiskFinding = z.infer<typeof RiskFindingSchema>;

export const SentinelSnapshotSchema = z.object({
  redactionCount: z.number().int().nonnegative(),
  riskCount: z.number().int().nonnegative(),
  highCount: z.number().int().nonnegative(),
  criticalCount: z.number().int().nonnegative(),
  findings: z.array(RiskFindingSchema),
});
export type SentinelSnapshot = z.infer<typeof SentinelSnapshotSchema>;

// ---------------------------------------------------------------------------
// Approvals
// ---------------------------------------------------------------------------

export const ApprovalKindSchema = z.enum(['cloud-send', 'premium-escalation']);
export type ApprovalKind = z.infer<typeof ApprovalKindSchema>;

export const ApprovalStatusSchema = z.enum(['pending', 'approved', 'denied', 'timeout']);
export type ApprovalStatus = z.infer<typeof ApprovalStatusSchema>;

export const ApprovalRequestSchema = z.object({
  id: z.string(),
  kind: ApprovalKindSchema,
  summary: z.string(),
  provider: ProviderKindSchema,
  model: z.string(),
  estimatedCostUsd: z.number().nonnegative(),
  createdAt: z.number().int().nonnegative(),
  expiresAt: z.number().int().nonnegative(),
  status: ApprovalStatusSchema,
});
export type ApprovalRequest = z.infer<typeof ApprovalRequestSchema>;

// ---------------------------------------------------------------------------
// Agent mesh
// ---------------------------------------------------------------------------

export const AgentRoleSchema = z.enum(['shell', 'review', 'router', 'system']);
export type AgentRole = z.infer<typeof AgentRoleSchema>;

export const AgentStateSchema = z.enum(['idle', 'running', 'blocked-on-approval', 'exited']);
export type AgentState = z.infer<typeof AgentStateSchema>;

export const AgentInfoSchema = z.object({
  agentId: z.string(),
  role: AgentRoleSchema,
  state: AgentStateSchema,
  runId: z.string().nullable(),
  readOnly: z.boolean(),
});
export type AgentInfo = z.infer<typeof AgentInfoSchema>;

// ---------------------------------------------------------------------------
// Review agent
// ---------------------------------------------------------------------------

export const ReviewModeSchema = z.enum([
  'optimize',
  'bugs',
  'architecture',
  'security',
  'next-steps',
  'full',
]);
export type ReviewMode = z.infer<typeof ReviewModeSchema>;

export const ReviewResultSchema = z.object({
  mode: ReviewModeSchema,
  provider: ProviderKindSchema,
  model: z.string(),
  content: z.string(),
  redactionCount: z.number().int().nonnegative(),
  cost: CostEstimateSchema,
});
export type ReviewResult = z.infer<typeof ReviewResultSchema>;

// ---------------------------------------------------------------------------
// IPC payload schemas (renderer -> daemon). Validated with Zod at the boundary.
// ---------------------------------------------------------------------------

export const PtyInputSchema = z.object({ data: z.string() });
export type PtyInput = z.infer<typeof PtyInputSchema>;

export const PtyResizeSchema = z.object({
  cols: z.number().int().positive(),
  rows: z.number().int().positive(),
});
export type PtyResize = z.infer<typeof PtyResizeSchema>;

export const ReviewRequestSchema = z.object({ mode: ReviewModeSchema });
export type ReviewRequest = z.infer<typeof ReviewRequestSchema>;

export const ApprovalDecisionSchema = z.object({
  id: z.string(),
  approve: z.boolean(),
});
export type ApprovalDecision = z.infer<typeof ApprovalDecisionSchema>;

export const LocalOnlyToggleSchema = z.object({ localOnly: z.boolean() });
export type LocalOnlyToggle = z.infer<typeof LocalOnlyToggleSchema>;

export const SlashCommandSchema = z.object({ line: z.string() });
export type SlashCommand = z.infer<typeof SlashCommandSchema>;

export const PermissionModeSetSchema = z.object({ mode: z.enum(['plan', 'ask', 'auto']) });
export type PermissionModeSet = z.infer<typeof PermissionModeSetSchema>;

export const ResumeSessionSchema = z.object({ sessionId: z.string().min(1) });
export type ResumeSession = z.infer<typeof ResumeSessionSchema>;

/** Result of dispatching a slash command (returned over IPC to the renderer). */
export const SlashResultSchema = z.object({
  output: z.string(),
  ok: z.boolean(),
  scrollback: z.array(z.string()).optional(),
  clear: z.boolean().optional(),
});
export type SlashResult = z.infer<typeof SlashResultSchema>;

/** Result of a session resume (restored scrollback for renderer repaint). */
export const ResumeResultSchema = z.object({
  ok: z.boolean(),
  scrollback: z.array(z.string()),
  reason: z.string().optional(),
});
export type ResumeResult = z.infer<typeof ResumeResultSchema>;

// ---------------------------------------------------------------------------
// IPC channel names — single registry shared by preload + main.
// ---------------------------------------------------------------------------

export const IPC = {
  // renderer -> main (invoke)
  ptyInput: 'pty:input',
  ptyResize: 'pty:resize',
  reviewRun: 'review:run',
  approvalDecide: 'approval:decide',
  localOnlySet: 'localonly:set',
  ledgerVerify: 'ledger:verify',
  stateSnapshot: 'state:snapshot',
  // v2 renderer -> main (invoke)
  slashRun: 'slash:run',
  permissionModeSet: 'permission:set',
  sessionsList: 'sessions:list',
  sessionResume: 'session:resume',
  // main -> renderer (send)
  busEvent: 'bus:event',
  ptyData: 'pty:data',
} as const;

export type IpcChannel = (typeof IPC)[keyof typeof IPC];

// ---------------------------------------------------------------------------
// Aggregate UI state pushed to the renderer.
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// v2: Permission modes
// ---------------------------------------------------------------------------

/**
 * Permission mode governs the Tool Layer:
 *  - plan: blocks ALL mutating tools (read-only exploration).
 *  - ask:  mutating/risky tools require human approval.
 *  - auto: non-risky tools run; risky/critical still gated.
 */
export const PermissionModeSchema = z.enum(['plan', 'ask', 'auto']);
export type PermissionMode = z.infer<typeof PermissionModeSchema>;

// ---------------------------------------------------------------------------
// v2: Todos (per-session, persisted in snapshot)
// ---------------------------------------------------------------------------

export const TodoStatusSchema = z.enum(['pending', 'in_progress', 'completed']);
export type TodoStatus = z.infer<typeof TodoStatusSchema>;

export const TodoItemSchema = z.object({
  id: z.string(),
  content: z.string(),
  status: TodoStatusSchema,
});
export type TodoItem = z.infer<typeof TodoItemSchema>;

// ---------------------------------------------------------------------------
// v2: Sessions
// ---------------------------------------------------------------------------

export const SessionSummarySchema = z.object({
  sessionId: z.string(),
  startedAt: z.number().int().nonnegative(),
  lastActiveAt: z.number().int().nonnegative(),
  eventCount: z.number().int().nonnegative(),
  sessionSpendUsd: z.number().nonnegative(),
  chainOk: z.boolean(),
});
export type SessionSummary = z.infer<typeof SessionSummarySchema>;

/** Persisted daemon snapshot (atomic-written to ./data/sessions/<id>.json). */
export const SessionSnapshotSchema = z.object({
  version: z.literal(2),
  sessionId: z.string(),
  startedAt: z.number().int().nonnegative(),
  lastActiveAt: z.number().int().nonnegative(),
  cost: CostSnapshotSchema,
  context: ContextSnapshotSchema,
  sentinel: SentinelSnapshotSchema,
  agents: z.array(AgentInfoSchema),
  localOnly: z.boolean(),
  permissionMode: PermissionModeSchema,
  todos: z.array(TodoItemSchema),
  scrollback: z.array(z.string()),
});
export type SessionSnapshot = z.infer<typeof SessionSnapshotSchema>;

// ---------------------------------------------------------------------------
// v2: A2A — BPC envelopes + peer status
// ---------------------------------------------------------------------------

export const A2aKindSchema = z.enum(['msg', 'ack', 'review', 'handoff']);
export type A2aKind = z.infer<typeof A2aKindSchema>;

export const BpcEnvelopeSchema = z.object({
  bpc: z.literal('1.0'),
  id: z.string(),
  from: IdentitySchema,
  to: z.string(),
  ts: z.number().int().nonnegative(),
  kind: A2aKindSchema,
  payload: z.unknown(),
  prevHash: z.string(),
  hash: z.string(),
});
export type BpcEnvelope = z.infer<typeof BpcEnvelopeSchema>;

export const A2aPeerSchema = z.object({
  peer: z.string(),
  lastSeenAt: z.number().int().nonnegative().nullable(),
  sent: z.number().int().nonnegative(),
  received: z.number().int().nonnegative(),
  chainOk: z.boolean(),
  allowlisted: z.boolean(),
});
export type A2aPeer = z.infer<typeof A2aPeerSchema>;

// ---------------------------------------------------------------------------
// v2: MCP
// ---------------------------------------------------------------------------

export const McpToolSchema = z.object({
  name: z.string(),
  description: z.string(),
  inputSchema: z.unknown(),
});
export type McpTool = z.infer<typeof McpToolSchema>;

// ---------------------------------------------------------------------------
// v2: Tool layer
// ---------------------------------------------------------------------------

export const ToolDescriptorSchema = z.object({
  name: z.string(),
  description: z.string(),
  mutating: z.boolean(),
  readOnly: z.boolean(),
});
export type ToolDescriptor = z.infer<typeof ToolDescriptorSchema>;

export const ToolResultSchema = z.object({
  ok: z.boolean(),
  tool: z.string(),
  output: z.string(),
  error: z.string().optional(),
  blocked: z.boolean().optional(),
  blockReason: z.string().optional(),
});
export type ToolResult = z.infer<typeof ToolResultSchema>;

// ---------------------------------------------------------------------------
// Aggregate UI state pushed to the renderer.
// ---------------------------------------------------------------------------

export const UiStateSchema = z.object({
  identity: IdentitySchema,
  cost: CostSnapshotSchema,
  context: ContextSnapshotSchema,
  route: RouteDecisionSchema.nullable(),
  liveness: z.array(ProviderLivenessSchema),
  localOnly: z.boolean(),
  sentinel: SentinelSnapshotSchema,
  agents: z.array(AgentInfoSchema),
  approvals: z.array(ApprovalRequestSchema),
  ledger: ChainStatusSchema,
  // --- v2 ---
  permissionMode: PermissionModeSchema,
  todos: z.array(TodoItemSchema),
  sessions: z.array(SessionSummarySchema),
  peers: z.array(A2aPeerSchema),
});
export type UiState = z.infer<typeof UiStateSchema>;

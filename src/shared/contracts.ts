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
  // --- v3: context economy ---
  'context.stored',
  'context.dedup',
  'context.distilled',
  'context.compacted',
  'context.migrated',
  'context.pinned',
  'context.unpinned',
  'context.requested',
  // --- v3: agent's own asks ---
  'playbook.crystallized',
  'playbook.loaded',
  'failure.recorded',
  'failure.matched',
  'scratchpad.write',
  'scratchpad.read',
  'introspect.query',
  'limits.loaded',
  // --- v3b: trust layer (B / B2) ---
  'identity.key_created',
  'envelope.signed',
  'signature.verified',
  'signature.invalid',
  'checkpoint.signed',
  'grant.root',
  'delegation.issued',
  'delegation.denied',
  'passport.exported',
  'passport.verified',
  'metering.recorded',
  'evidence.exported',
  'replay.exported',
  // --- v3c: proof layer (D6 / E5 / E6 / E7) ---
  'lab.run',
  'lab.arm',
  'lab.scored',
  'tool.simulated',
  'confidence.reported',
  'confidence.escalated',
  'consult.requested',
  'consult.result',
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
  // --- v3: Context Economy savings accounting ---
  /** Tokens that were NOT resent because their blob was already seen by the model. */
  tokensNotResent: z.number().nonnegative().default(0),
  /** USD saved by prompt-cache hits + dedup (priced at baseline input rate). */
  cacheSavingsUsd: z.number().nonnegative().default(0),
  /** USD saved by running distillation on the local model instead of cloud. */
  distillationSavingsUsd: z.number().nonnegative().default(0),
  /** useful-new-tokens / total-tokens, as a 0..100 percentage. The screenshot number. */
  contextEfficiencyPct: z.number().min(0).max(100).default(100),
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
  // --- v3: tier breakdown (the gauge becomes an actuator) ---
  hotTokens: z.number().nonnegative().default(0),
  warmTokens: z.number().nonnegative().default(0),
  pinnedTokens: z.number().nonnegative().default(0),
  /** Count of dedup hits (blobs sent as ref+digest instead of full bytes). */
  dedupHits: z.number().int().nonnegative().default(0),
  /** Number of auto-compaction events this session. */
  compactions: z.number().int().nonnegative().default(0),
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
// v3c (E5): dry-run simulation preview (defined here so approvals can attach one)
// ---------------------------------------------------------------------------

/**
 * A tool simulation. Mutating tools accept `simulate: true` and return predicted
 * effects WITHOUT executing — a diff preview for writers, the files they would
 * touch, and (for bash/cloud) a command-risk classification + estimated cost. An
 * approval request may attach one so the human approves evidence, not a promise.
 */
export const SimulationPreviewSchema = z.object({
  tool: z.string(),
  /** Whether the tool actually mutates state when really run. */
  mutating: z.boolean(),
  /** One-line human summary of the predicted effect. */
  summary: z.string(),
  /** Files this action would create/modify/delete. */
  filesTouched: z.array(z.string()).default([]),
  /** Unified-ish diff preview for write/edit/patch (truncated). */
  diff: z.string().optional(),
  /** Risk classification (bash/cloud), if any. */
  risk: RiskSeveritySchema.optional(),
  riskReason: z.string().optional(),
  /** Estimated USD cost of really running this (0 for local/free). */
  estimatedCostUsd: z.number().nonnegative().default(0),
});
export type SimulationPreview = z.infer<typeof SimulationPreviewSchema>;

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
  /** v3c (E5): a dry-run simulation preview, so the human approves evidence. */
  preview: SimulationPreviewSchema.optional(),
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

export const ClipboardWriteSchema = z.object({ text: z.string() });
export type ClipboardWrite = z.infer<typeof ClipboardWriteSchema>;

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

export const ReplayEventsSchema = z.object({ sessionId: z.string().optional() });
export type ReplayEvents = z.infer<typeof ReplayEventsSchema>;

/** v3c: read the most recent lab report (renderer LabPanel). */
export const LabLatestSchema = z.object({ sessionId: z.string().optional() });
export type LabLatest = z.infer<typeof LabLatestSchema>;

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
  // v3b renderer -> main (invoke)
  replayEvents: 'replay:events',
  // v3c renderer -> main (invoke)
  labLatest: 'lab:latest',
  // clipboard (invoke) — main owns the OS clipboard; the sandboxed renderer
  // cannot reach navigator.clipboard reliably, so it goes through here.
  clipboardRead: 'clipboard:read',
  clipboardWrite: 'clipboard:write',
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
// v3: Context Economy — content-addressed store, tiered memory, knowledge
// ---------------------------------------------------------------------------

/** Kinds of context artifact tracked by the content-addressed store. */
export const ContextBlobKindSchema = z.enum([
  'file',
  'scrollback',
  'diff',
  'doc',
  'knowledge',
  'other',
]);
export type ContextBlobKind = z.infer<typeof ContextBlobKindSchema>;

/** Metadata for a stored blob (the bytes live in ./data/context-store/<hash>). */
export const ContextBlobRefSchema = z.object({
  hash: z.string(),
  kind: ContextBlobKindSchema,
  /** Human label / source path. */
  source: z.string(),
  bytes: z.number().int().nonnegative(),
  tokens: z.number().int().nonnegative(),
  /** 3-line digest sent in place of full bytes once the model has seen the blob. */
  digest: z.string(),
  /** Ledger event ids that produced this blob (COLD-tier provenance). */
  provenance: z.array(z.string()),
  pinned: z.boolean().default(false),
});
export type ContextBlobRef = z.infer<typeof ContextBlobRefSchema>;

/**
 * Structured incremental session memory (WARM tier). Distilled from each turn
 * by the LOCAL model so it costs $0 and never leaves the machine. Persisted in
 * the session snapshot; loaded instantly on resume (resume re-reads NOTHING).
 */
export const SessionKnowledgeSchema = z.object({
  decisions: z.array(z.string()).default([]),
  facts: z.array(z.string()).default([]),
  /** path -> one-line state summary. */
  fileStates: z.record(z.string()).default({}),
  openQuestions: z.array(z.string()).default([]),
  todos: z.array(z.string()).default([]),
  namedEntities: z.array(z.string()).default([]),
  /** Blob hashes whose facts were distilled here (rehydration provenance). */
  sourceBlobs: z.array(z.string()).default([]),
  updatedAt: z.number().int().nonnegative().default(0),
});
export type SessionKnowledge = z.infer<typeof SessionKnowledgeSchema>;

/** A crystallized, reusable playbook (E1). */
export const PlaybookSchema = z.object({
  hash: z.string(),
  /** Short signature of the situation this playbook applies to. */
  situation: z.string(),
  title: z.string(),
  steps: z.array(z.string()),
  pitfalls: z.array(z.string()).default([]),
  provenance: z.array(z.string()).default([]),
  version: z.number().int().positive().default(1),
  createdAt: z.number().int().nonnegative().default(0),
});
export type Playbook = z.infer<typeof PlaybookSchema>;

/** A ledger-derived anti-pattern (E2). */
export const FailureRecordSchema = z.object({
  hash: z.string(),
  /** Signature used to match a recurring situation. */
  signature: z.string(),
  whatNotToDo: z.string(),
  whatWorkedInstead: z.string(),
  provenance: z.array(z.string()).default([]),
  createdAt: z.number().int().nonnegative().default(0),
});
export type FailureRecord = z.infer<typeof FailureRecordSchema>;

/** Machine-readable manifest of what this harness/model pair CANNOT do (E10). */
export const LimitsManifestSchema = z.object({
  cannot: z.array(z.string()),
  blockedDomains: z.array(z.string()).default([]),
  notes: z.array(z.string()).default([]),
});
export type LimitsManifest = z.infer<typeof LimitsManifestSchema>;

/** Cheap readable resource state the model can feel (E9). */
export const MetabolicStateSchema = z.object({
  contextRemainingPct: z.number().min(0).max(100),
  budgetRemainingUsd: z.number(),
  elapsedMs: z.number().int().nonnegative(),
});
export type MetabolicState = z.infer<typeof MetabolicStateSchema>;

// ---------------------------------------------------------------------------
// v3b: Trust layer — Ed25519 identity keys, delegation, passport, receipts
// ---------------------------------------------------------------------------

/**
 * A public-key record for an agent. The private key NEVER leaves the daemon
 * keystore (./data/keys/) and is never serialized into any contract — only the
 * raw 32-byte Ed25519 public key (hex) crosses a boundary.
 */
export const AgentPublicKeySchema = z.object({
  agentId: z.string().min(1),
  /** Raw Ed25519 public key, hex-encoded (64 hex chars). */
  publicKeyHex: z.string().min(1),
  createdAt: z.number().int().nonnegative(),
});
export type AgentPublicKey = z.infer<typeof AgentPublicKeySchema>;

/** A detached Ed25519 signature over a canonical message, with its signer. */
export const SignatureSchema = z.object({
  /** agentId of the signer (look up its public key to verify). */
  signer: z.string().min(1),
  /** Raw Ed25519 public key of the signer at signing time (hex). */
  publicKeyHex: z.string().min(1),
  /** Detached signature, hex-encoded. */
  sigHex: z.string().min(1),
  /** Signing algorithm tag (forward-compat). */
  alg: z.literal('ed25519').default('ed25519'),
});
export type Signature = z.infer<typeof SignatureSchema>;

/**
 * A signed, hash-chained ledger checkpoint. Periodically the daemon seals the
 * current ledger head (seq + hash) with the system agent's Ed25519 key, turning
 * the SHA-256 chain into a SIGNED chain robust to ledger-file substitution.
 */
export const LedgerCheckpointSchema = z.object({
  /** Sequence number of the ledger entry this checkpoint seals (inclusive). */
  seq: z.number().int().nonnegative(),
  /** Ledger head hash at the checkpoint. */
  hash: z.string().min(1),
  /** Number of entries covered (== seq + 1). */
  entries: z.number().int().nonnegative(),
  ts: z.number().int().nonnegative(),
  signature: SignatureSchema,
});
export type LedgerCheckpoint = z.infer<typeof LedgerCheckpointSchema>;

/** Data classes a delegation may permit a grantee to touch. */
export const DataClassSchema = z.enum([
  'public',
  'internal',
  'secret',
  'cui',
]);
export type DataClass = z.infer<typeof DataClassSchema>;

/**
 * The scoped authority a delegation grants. A chain of certificates must
 * terminate at a human root grant; the daemon REFUSES any tool/A2A action whose
 * effective scope is missing, expired, over-tools, over-budget, or over-class.
 */
export const DelegationScopeSchema = z.object({
  /** Tools the grantee may invoke. '*' means all (only valid on a human root). */
  tools: z.array(z.string()).default(['*']),
  /** Hard spend ceiling (USD) for actions under this grant. */
  spendBudgetUsd: z.number().nonnegative().default(0),
  /** Absolute expiry (epoch ms). 0 means "inherit parent" / no extra limit. */
  expiresAt: z.number().int().nonnegative().default(0),
  /** Data classes the grantee may handle. */
  dataClasses: z.array(DataClassSchema).default(['public']),
});
export type DelegationScope = z.infer<typeof DelegationScopeSchema>;

/**
 * A delegation certificate: a scoped capability grant from `issuer` to
 * `grantee`, signed by the issuer's identity key. `parent` is the hash of the
 * certificate one link up the chain; a root grant has parent === null and is
 * authorized by a human (issuer === 'human').
 */
export const DelegationCertSchema = z.object({
  /** Content hash of the canonical certificate (id + dedupe + chain link). */
  hash: z.string().min(1),
  /** agentId of the granting party, or 'human' for a root grant. */
  issuer: z.string().min(1),
  /** agentId receiving the authority. */
  grantee: z.string().min(1),
  scope: DelegationScopeSchema,
  /** Hash of the parent certificate, or null for a human root grant. */
  parent: z.string().nullable(),
  issuedAt: z.number().int().nonnegative(),
  /** Whether a human approved this grant (true only on the root). */
  humanApproved: z.boolean().default(false),
  signature: SignatureSchema,
});
export type DelegationCert = z.infer<typeof DelegationCertSchema>;

/** Result of verifying a delegation chain back to a human root. */
export const DelegationVerdictSchema = z.object({
  ok: z.boolean(),
  reason: z.string(),
  /** Effective (intersected) scope across the whole chain, if ok. */
  effectiveScope: DelegationScopeSchema.optional(),
  /** Certificate hashes from grantee up to the human root. */
  chain: z.array(z.string()).default([]),
});
export type DelegationVerdict = z.infer<typeof DelegationVerdictSchema>;

/** Per-agent resource accounting (B2.4 inter-agent metering). */
export const MeteringRecordSchema = z.object({
  agentId: z.string().min(1),
  toolCalls: z.number().int().nonnegative().default(0),
  spendUsd: z.number().nonnegative().default(0),
  inputTokens: z.number().int().nonnegative().default(0),
  outputTokens: z.number().int().nonnegative().default(0),
  updatedAt: z.number().int().nonnegative().default(0),
});
export type MeteringRecord = z.infer<typeof MeteringRecordSchema>;

/** A signed metering receipt that may ride on an A2A envelope (B2.4). */
export const MeteringReceiptSchema = z.object({
  record: MeteringRecordSchema,
  signature: SignatureSchema,
});
export type MeteringReceipt = z.infer<typeof MeteringReceiptSchema>;

/**
 * Agent passport (B2.3): an exportable, signed summary of an agent's work
 * history backed by a Merkle hash-tree over its ledger events. The `merkleRoot`
 * is third-party verifiable; subtrees (proofs) can be revealed selectively
 * without exposing event content.
 */
export const PassportSummarySchema = z.object({
  sessions: z.number().int().nonnegative(),
  toolCalls: z.number().int().nonnegative(),
  spendUsd: z.number().nonnegative(),
  riskFindings: z.number().int().nonnegative(),
  approvalsRequested: z.number().int().nonnegative(),
  approvalsResolved: z.number().int().nonnegative(),
  events: z.number().int().nonnegative(),
});
export type PassportSummary = z.infer<typeof PassportSummarySchema>;

export const PassportSchema = z.object({
  version: z.literal(1).default(1),
  agentId: z.string().min(1),
  issuedAt: z.number().int().nonnegative(),
  summary: PassportSummarySchema,
  /** Merkle root over the leaf hashes of the covered ledger events. */
  merkleRoot: z.string().min(1),
  /** Number of leaves (events) in the tree. */
  leafCount: z.number().int().nonnegative(),
  signature: SignatureSchema,
});
export type Passport = z.infer<typeof PassportSchema>;

/** A Merkle inclusion proof for one leaf (selective reveal). */
export const MerkleProofStepSchema = z.object({
  hash: z.string(),
  /** Sibling side: is the sibling on the left of the current node? */
  left: z.boolean(),
});
export type MerkleProofStep = z.infer<typeof MerkleProofStepSchema>;

export const MerkleRevealSchema = z.object({
  /** Leaf index revealed. */
  index: z.number().int().nonnegative(),
  /** The revealed leaf hash (content stays private unless caller adds it). */
  leafHash: z.string(),
  /** Optional revealed leaf content (caller opts in to disclose). */
  content: z.string().optional(),
  proof: z.array(MerkleProofStepSchema),
});
export type MerkleReveal = z.infer<typeof MerkleRevealSchema>;

/**
 * A signed session-replay bundle (.screplay): the ordered ledger events for a
 * session plus the signed checkpoints covering them and the signer's public
 * key, so a third party can verify the chain + signatures and scrub the
 * timeline in a browser. Event payloads were already redaction-gated at record
 * time, so the bundle carries no fresh secrets.
 */
export const ReplayBundleSchema = z.object({
  version: z.literal(1).default(1),
  sessionId: z.string().min(1),
  exportedAt: z.number().int().nonnegative(),
  events: z.array(LedgerEntrySchema),
  checkpoints: z.array(LedgerCheckpointSchema).default([]),
  publicKeys: z.array(AgentPublicKeySchema).default([]),
  signature: SignatureSchema,
});
export type ReplayBundle = z.infer<typeof ReplayBundleSchema>;

/** Verification report embedded in an evidence bundle. */
export const VerificationReportSchema = z.object({
  chainOk: z.boolean(),
  checkpointsOk: z.boolean(),
  entries: z.number().int().nonnegative(),
  checkpoints: z.number().int().nonnegative(),
  brokenAt: z.number().int().nonnegative().nullable(),
  generatedAt: z.number().int().nonnegative(),
});
export type VerificationReport = z.infer<typeof VerificationReportSchema>;

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

/**
 * Persisted daemon snapshot (atomic-written to ./data/sessions/<id>.json).
 * v3 adds the WARM-tier SessionKnowledge + content-addressed blob refs so a
 * resume re-reads NOTHING. `version` accepts 2 or 3 for backward-compatible
 * reads; new fields default when absent (an old v2 file still loads).
 */
export const SessionSnapshotSchema = z.object({
  version: z.union([z.literal(2), z.literal(3)]),
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
  // --- v3 ---
  knowledge: SessionKnowledgeSchema.optional(),
  blobs: z.array(ContextBlobRefSchema).default([]),
  ancestorRunId: z.string().optional(),
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
  /** v3b: detached Ed25519 signature over the envelope hash (additive). */
  signature: SignatureSchema.optional(),
  /** v3b: optional signed metering receipt carried with the envelope (B2.4). */
  receipt: MeteringReceiptSchema.optional(),
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
// v3c: Proof layer — D6 harness lab, E5 dry-run, E6 uncertainty, E7 consult
// ---------------------------------------------------------------------------

/**
 * E6 uncertainty channel: an action may carry the actor's confidence (0..1) and
 * a short rationale. The policy engine routes low-confidence + high-blast-radius
 * actions to automatic verification (dry-run) or approval escalation.
 */
export const ConfidenceSchema = z.object({
  /** 0 (no idea) .. 1 (certain). */
  value: z.number().min(0).max(1),
  rationale: z.string().default(''),
});
export type Confidence = z.infer<typeof ConfidenceSchema>;

export const ConfidenceRouteSchema = z.enum(['proceed', 'verify', 'escalate']);
export type ConfidenceRoute = z.infer<typeof ConfidenceRouteSchema>;

/** Decision of the uncertainty router for a single action (E6). */
export const ConfidenceDecisionSchema = z.object({
  route: ConfidenceRouteSchema,
  confidence: z.number().min(0).max(1),
  threshold: z.number().min(0).max(1),
  /** Whether the action is high-blast-radius (mutating/cloud/risky). */
  highBlastRadius: z.boolean(),
  reason: z.string(),
});
export type ConfidenceDecision = z.infer<typeof ConfidenceDecisionSchema>;

/**
 * E7 second opinion: a different provider/model critiques a proposed risky
 * action before execution. Budgeted via the Cost Kernel, redacted, and
 * approval-gated like any cloud call (free for local models).
 */
export const ConsultResultSchema = z.object({
  ok: z.boolean(),
  provider: ProviderKindSchema,
  model: z.string(),
  /** The critique text (redacted on the way out and in). */
  critique: z.string(),
  /** Consulted model's own confidence in its critique. */
  confidence: z.number().min(0).max(1).default(0),
  cost: CostEstimateSchema,
  redactionCount: z.number().int().nonnegative().default(0),
  blocked: z.boolean().optional(),
  blockReason: z.string().optional(),
});
export type ConsultResult = z.infer<typeof ConsultResultSchema>;

/**
 * D6 harness lab: an "arm" is a named harness configuration evaluated against a
 * task. We vary toolset, context policy (hot-window size / dedup), model/provider
 * choice, and permission mode, then score each arm from its ledger slice.
 */
export const LabArmConfigSchema = z.object({
  name: z.string().min(1),
  /** Scoped toolset for the arm (undefined = full surface). */
  tools: z.array(z.string()).optional(),
  /** Hot-window token budget override (context policy). */
  hotWindowTokens: z.number().int().positive().optional(),
  /** Whether dedup is on for this arm. */
  dedup: z.boolean().optional(),
  /** Provider/model choice. */
  provider: ProviderKindSchema.optional(),
  model: z.string().optional(),
  /** Permission mode for the arm. */
  permissionMode: PermissionModeSchema.optional(),
});
export type LabArmConfig = z.infer<typeof LabArmConfigSchema>;

/** A task definition file for the lab. The verify command's exit code = success. */
export const LabTaskSchema = z.object({
  name: z.string().min(1),
  /** The prompt/goal handed to each arm. */
  prompt: z.string().default(''),
  /** Tool invocations to run per arm (name + input), the "work" of the task. */
  steps: z
    .array(z.object({ tool: z.string(), input: z.unknown().optional() }))
    .default([]),
  /** Shell command whose exit code declares success (0 = pass). */
  verify: z.string().optional(),
  arms: z.array(LabArmConfigSchema).default([]),
});
export type LabTask = z.infer<typeof LabTaskSchema>;

/** The score of one arm, derived purely from its ledger slice. */
export const LabArmScoreSchema = z.object({
  arm: z.string(),
  runId: z.string(),
  turns: z.number().int().nonnegative(),
  totalTokens: z.number().int().nonnegative(),
  cacheHitPct: z.number().min(0).max(100),
  toolErrorRate: z.number().min(0).max(100),
  approvalsTriggered: z.number().int().nonnegative(),
  wallTimeMs: z.number().int().nonnegative(),
  success: z.boolean(),
  /** Exit code of the verify command (null if none declared). */
  verifyExitCode: z.number().int().nullable(),
});
export type LabArmScore = z.infer<typeof LabArmScoreSchema>;

/** The full side-by-side comparison of a lab run. */
export const LabReportSchema = z.object({
  task: z.string(),
  sessionId: z.string(),
  ranAt: z.number().int().nonnegative(),
  scores: z.array(LabArmScoreSchema),
});
export type LabReport = z.infer<typeof LabReportSchema>;

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
  // --- v3 ---
  knowledge: SessionKnowledgeSchema,
  metabolic: MetabolicStateSchema,
  pinned: z.array(ContextBlobRefSchema).default([]),
  // --- v3b: trust layer ---
  metering: z.array(MeteringRecordSchema).default([]),
  grants: z.array(DelegationCertSchema).default([]),
  checkpoints: z.number().int().nonnegative().default(0),
  // --- v3c: proof layer ---
  /** Most recent lab report (D6), if any. */
  lab: LabReportSchema.nullable().default(null),
  /** E6 confidence threshold below which high-blast-radius actions escalate. */
  confidenceThreshold: z.number().min(0).max(1).default(0.5),
});
export type UiState = z.infer<typeof UiStateSchema>;

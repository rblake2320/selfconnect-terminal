import {
  type ConfidenceDecision,
  type DelegationVerdict,
  type Identity,
  type PermissionMode,
  type RiskSeverity,
  type SimulationPreview,
  type ToolDescriptor,
  type ToolResult,
} from '../../shared/contracts';
import { assessCommand } from '../command-risk';
import { BUILTIN_TOOLS } from './builtins';
import { CheckpointStore } from './checkpoint-store';
import { HookEngine } from './hooks';
import { simulateTool } from './simulate';
import type { GovernedTool, ToolContext, ToolServices } from './types';

export interface ToolRegistryDeps {
  checkpoints: CheckpointStore;
  hooks: HookEngine;
  services: ToolServices;
  /**
   * Identity stamp factory for a given logical agent name. An explicit runId
   * may be supplied (D6 lab arms share one runId so their ledger slice is
   * cleanly attributable); otherwise a fresh run is minted per invocation.
   */
  stampFor: (agent: string, runId?: string) => Identity;
  /** Current permission mode. */
  permissionMode: () => PermissionMode;
  /** Audit a governed bus+ledger event. */
  audit: (
    type:
      | 'tool.call'
      | 'tool.result'
      | 'tool.blocked'
      | 'checkpoint.created'
      | 'hook.fired'
      | 'tool.simulated'
      | 'confidence.reported'
      | 'confidence.escalated',
    payload: unknown,
    identity: Identity,
  ) => void;
  /** Request human approval for a gated tool; resolves true if granted. */
  requestApproval: (summary: string, preview?: SimulationPreview) => Promise<boolean>;
  /**
   * Authorize a tool against the caller's delegation chain (B2.2). Optional so
   * standalone registries (tests) keep working without a delegation registry.
   */
  authorizeDelegation?: (agent: string, action: { tool?: string }) => DelegationVerdict;
  /**
   * Baseline cloud pricing (USD/1M tokens) used to estimate simulated costs.
   * Optional so standalone test registries keep working.
   */
  baselineCloudPrice?: { inputPerMillion: number; outputPerMillion: number };
  /**
   * E6 uncertainty router. Given the tool's blast radius + a reported
   * confidence, decide whether to proceed, force a dry-run verify, or escalate
   * to human approval. Optional; absent => always proceed.
   */
  confidenceRouter?: (input: {
    tool: string;
    mutating: boolean;
    risk: RiskSeverity;
    confidence: number;
  }) => ConfidenceDecision;
}

/** Optional governance envelope a caller may attach to a tool invocation. */
export interface InvokeOptions {
  /** E5: do not execute; return predicted effects only. */
  simulate?: boolean;
  /** E6: the actor's confidence in this action (0..1) + rationale. */
  confidence?: { value: number; rationale?: string };
  /** D6: pin the identity stamp to a specific runId (lab arm isolation). */
  runId?: string;
}

const DEFAULT_PRICE = { inputPerMillion: 3, outputPerMillion: 15 };

const RISK_ORDER: Record<RiskSeverity, number> = { low: 0, medium: 1, high: 2, critical: 3 };

/**
 * The daemon-owned ToolRegistry. Every invocation is identity-stamped, permission
 * gated (plan/ask/auto), risk-checked, hook-wrapped, checkpointed (writers),
 * and audited to the ledger via the daemon's record() choke point.
 */
export class ToolRegistry {
  private tools = new Map<string, GovernedTool>();

  constructor(private readonly deps: ToolRegistryDeps) {
    for (const t of BUILTIN_TOOLS) this.tools.set(t.name, t);
  }

  register(tool: GovernedTool): void {
    this.tools.set(tool.name, tool);
  }

  list(): ToolDescriptor[] {
    return [...this.tools.values()].map((t) => ({
      name: t.name,
      description: t.description,
      mutating: t.mutating,
      readOnly: t.readOnly,
    }));
  }

  /** Read-only subset (for the MCP server). */
  readOnlyNames(): string[] {
    return [...this.tools.values()].filter((t) => t.readOnly).map((t) => t.name);
  }

  has(name: string): boolean {
    return this.tools.has(name);
  }

  /**
   * Invoke a tool by name with raw (unvalidated) input. `agent` names the
   * calling actor for the identity stamp; `allowed` optionally scopes which
   * tools may run (sub-agent task allowlist).
   */
  async invoke(
    name: string,
    rawInput: unknown,
    agent = 'tool',
    allowed?: string[],
    options: InvokeOptions = {},
  ): Promise<ToolResult> {
    const tool = this.tools.get(name);
    const identity = this.deps.stampFor(agent, options.runId);
    if (!tool) {
      return this.blocked(name, identity, `unknown tool: ${name}`);
    }
    if (allowed && allowed.length > 0 && !allowed.includes(name)) {
      return this.blocked(name, identity, `tool '${name}' not in scoped allowlist`);
    }

    // Validate input.
    const parsed = tool.inputSchema.safeParse(rawInput ?? {});
    if (!parsed.success) {
      return this.blocked(name, identity, `invalid input: ${parsed.error.issues.map((i) => i.message).join('; ')}`);
    }
    const input = parsed.data;

    const mode = this.deps.permissionMode();

    // Risk escalation: bash inspects the actual command.
    let effectiveRisk: RiskSeverity = tool.risk;
    if (name === 'bash') {
      const finding = assessCommand((input as { command: string }).command);
      if (finding && RISK_ORDER[finding.severity] > RISK_ORDER[effectiveRisk]) {
        effectiveRisk = finding.severity;
      }
    }

    // E5 dry-run: predict effects WITHOUT executing. Audited as tool.simulated;
    // bypasses permission/approval gates because nothing actually happens.
    if (options.simulate) {
      const preview = this.preview(name, input, tool.mutating, effectiveRisk);
      this.deps.audit('tool.simulated', { tool: name, mutating: tool.mutating, risk: effectiveRisk }, identity);
      return { ok: true, tool: name, output: JSON.stringify(preview) };
    }

    // Permission mode: plan blocks all mutating tools.
    if (mode === 'plan' && tool.mutating) {
      return this.blocked(name, identity, `plan mode blocks mutating tool '${name}'`);
    }

    // Delegation gate (B2.2): the caller's authority chain must cover this tool
    // and terminate at a human root grant. A failed chain is a hard refusal.
    if (this.deps.authorizeDelegation) {
      const verdict = this.deps.authorizeDelegation(agent, { tool: name });
      if (!verdict.ok) {
        return this.blocked(name, identity, `delegation refused: ${verdict.reason}`);
      }
    }

    // E6 uncertainty channel: a reported confidence + the action's blast radius
    // route low-confidence risky/mutating actions to forced verification (a
    // dry-run shown for approval) or straight escalation to human approval.
    let escalate = false;
    let escalateReason = '';
    if (options.confidence && this.deps.confidenceRouter) {
      const decision = this.deps.confidenceRouter({
        tool: name,
        mutating: tool.mutating,
        risk: effectiveRisk,
        confidence: options.confidence.value,
      });
      this.deps.audit(
        'confidence.reported',
        { tool: name, confidence: options.confidence.value, rationale: options.confidence.rationale ?? '', route: decision.route },
        identity,
      );
      if (decision.route !== 'proceed') {
        escalate = true;
        escalateReason = decision.reason;
        this.deps.audit('confidence.escalated', { tool: name, ...decision }, identity);
      }
    }

    // Pre-hooks (may block).
    const pre = this.deps.hooks.run('pre', name);
    if (pre.fired) this.deps.audit('hook.fired', { event: 'pre', tool: name, ran: pre.ran, blocked: pre.blocked }, identity);
    if (pre.blocked) {
      return this.blocked(name, identity, pre.reason ?? 'blocked by pre-hook');
    }

    // Approval gate:
    //  - ask mode gates all mutating tools;
    //  - high/critical risk always gated (even in auto);
    //  - E6 low-confidence escalation forces approval too.
    const needsApproval =
      escalate || (mode === 'ask' && tool.mutating) || RISK_ORDER[effectiveRisk] >= RISK_ORDER.high;
    if (needsApproval) {
      // Attach a dry-run preview so the human approves evidence, not a promise.
      const preview = this.preview(name, input, tool.mutating, effectiveRisk);
      const summary = escalate
        ? `tool ${name} (${effectiveRisk}, low-confidence: ${escalateReason}) by ${identity.agentId}`
        : `tool ${name} (${effectiveRisk}) by ${identity.agentId}`;
      const granted = await this.deps.requestApproval(summary, preview);
      if (!granted) {
        return this.blocked(name, identity, `tool '${name}' not approved`);
      }
    }

    // Audit the call.
    this.deps.audit('tool.call', { tool: name, mutating: tool.mutating, risk: effectiveRisk }, identity);

    // Checkpoint writers before mutation.
    if (tool.checkpointPaths) {
      for (const p of tool.checkpointPaths(input)) {
        const ckpt = this.deps.checkpoints.capture(p);
        this.deps.audit('checkpoint.created', { id: ckpt.id, filePath: ckpt.filePath }, identity);
      }
    }

    const ctx: ToolContext = { identity, permissionMode: mode, services: this.deps.services };

    let output: string;
    try {
      output = await tool.run(input, ctx);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.deps.audit('tool.result', { tool: name, ok: false, error: msg }, identity);
      return { ok: false, tool: name, output: '', error: msg };
    }

    // Post-hooks.
    const post = this.deps.hooks.run('post', name);
    if (post.fired) this.deps.audit('hook.fired', { event: 'post', tool: name, ran: post.ran }, identity);

    this.deps.audit('tool.result', { tool: name, ok: true }, identity);
    return { ok: true, tool: name, output };
  }

  /**
   * Dry-run preview for a tool + validated input. Pure: delegates to the
   * side-effect-free planners in simulate.ts. The registry's effective risk
   * (which may be escalated for bash) is merged in when the planner did not
   * already supply one.
   */
  private preview(name: string, input: unknown, mutating: boolean, risk: RiskSeverity): SimulationPreview {
    const p = simulateTool(name, input, mutating, this.deps.baselineCloudPrice ?? DEFAULT_PRICE);
    return p.risk ? p : { ...p, risk };
  }

  private blocked(name: string, identity: Identity, reason: string): ToolResult {
    this.deps.audit('tool.blocked', { tool: name, reason }, identity);
    return { ok: false, tool: name, output: '', blocked: true, blockReason: reason };
  }
}

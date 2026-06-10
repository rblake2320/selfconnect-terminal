import {
  type BusEvent,
  type Identity,
  type PermissionMode,
  type ReviewMode,
  type ReviewResult,
  type SessionSnapshot,
  type SessionSummary,
  type TodoStatus,
  type UiState,
  type ChainStatus,
  type A2aKind,
  type RiskFinding,
  type DelegationScope,
  type DelegationCert,
  type DelegationVerdict,
  type Passport,
  type MerkleReveal,
  type ReplayBundle,
  type DataClass,
} from '../shared/contracts';
import { loadConfig, type DaemonConfig } from './config';
import { EventBus } from './event-bus';
import { IdentityRegistry } from './identity';
import { AuditLedger } from './audit-ledger';
import { PolicyEngine } from './policy-engine';
import { ApprovalManager } from './approvals';
import { SecuritySentinel } from './security-sentinel';
import { ContextGauge } from './context-gauge';
import { AgentMesh } from './agent-mesh';
import { redact } from './redactor';
import { buildSnapshot, snapshotToText } from './context-builder';
import { ProviderRegistry } from '../agent/provider-registry';
import { ModelRouter } from '../agent/model-router';
import { CostKernel, estimateTokens } from '../agent/cost-kernel';
import { ReviewAgent } from '../agent/review-agent';
import { SessionStore } from './session-store';
import { TodoStore } from './todo-store';
import { A2aManager } from './a2a-manager';
import { McpManager } from './mcp-manager';
import { ProjectMemory } from './tools/memory';
import { CheckpointStore } from './tools/checkpoint-store';
import { HookEngine } from './tools/hooks';
import { ToolRegistry } from './tools/registry';
import { AgentKeystore } from './agent-keys';
import { CheckpointStore as LedgerCheckpointStore } from './ledger-checkpoints';
import { DelegationRegistry, HUMAN_ROOT } from './delegation';
import {
  buildPassport,
  revealLeaf,
  verifyPassport,
  verifyReveal,
  type PassportArtifact,
} from './passport';
import { buildEvidenceBundle } from './evidence';
import { buildReplayBundle, verifyReplayBundle } from './replay';
import type { ToolServices } from './tools/types';
import type {
  SlashResult,
  ContextBlobRef,
  LimitsManifest,
  MetabolicState,
  ContextBlobKind,
} from '../shared/contracts';
import { ContextStore } from './context-store';
import { SessionKnowledgeStore } from './session-knowledge';
import { PlaybookStore, FailureStore } from './knowledge-stores';
import { Scratchpad } from './scratchpad';
import { loadLimits } from './limits';

/**
 * SelfConnect daemon (v2): the trusted core. Owns the event bus, ledger, policy,
 * approvals, providers, routing, cost, redaction, identity, the seven+ widgets'
 * state, AND the v2 surfaces: session persistence/resume, slash command
 * dispatch, the governed Tool Layer, A2A transport, and the MCP client manager.
 *
 * Every material action publishes an identity-stamped bus event AND appends to
 * the hash-chained ledger (one bus, one audit path).
 */
export class Daemon {
  readonly cfg: DaemonConfig;
  readonly bus = new EventBus();
  identity: IdentityRegistry;
  readonly ledger: AuditLedger;
  readonly policy: PolicyEngine;
  readonly approvals: ApprovalManager;
  readonly sentinel = new SecuritySentinel();
  readonly contextGauge = new ContextGauge();
  readonly mesh = new AgentMesh();
  readonly registry: ProviderRegistry;
  readonly router: ModelRouter;
  readonly cost: CostKernel;
  readonly review: ReviewAgent;
  // v2
  readonly sessions: SessionStore;
  readonly todos = new TodoStore();
  readonly a2a: A2aManager;
  readonly mcp: McpManager;
  readonly memory: ProjectMemory;
  checkpoints: CheckpointStore;
  readonly hooks: HookEngine;
  readonly tools: ToolRegistry;
  // v3b: Trust layer
  readonly keystore: AgentKeystore;
  readonly ledgerCheckpoints: LedgerCheckpointStore;
  readonly delegation: DelegationRegistry;
  private rootGrant: DelegationCert | null = null;
  private lastPassport: PassportArtifact | null = null;
  // v3: Context Economy + agent's own asks
  readonly contextStore: ContextStore;
  readonly knowledge = new SessionKnowledgeStore();
  readonly playbooks: PlaybookStore;
  readonly failures: FailureStore;
  readonly scratchpad: Scratchpad;
  readonly limits: LimitsManifest;

  private permissionMode: PermissionMode = 'auto';
  private startedAt = Date.now();
  private terminalLines: string[] = [];
  private terminalCwd: string;
  private terminalShell: string;
  private ancestorRunId?: string;

  constructor(cfg: DaemonConfig = loadConfig(), cwd: string = process.cwd()) {
    this.cfg = cfg;
    this.identity = new IdentityRegistry();
    this.ledger = new AuditLedger(cfg.ledgerPath);
    this.policy = new PolicyEngine({
      localOnly: cfg.localOnly,
      maxSpendPerCallUsd: cfg.maxSpendPerCallUsd,
    });
    this.approvals = new ApprovalManager(cfg.approvalTimeoutMs);
    this.registry = new ProviderRegistry(cfg);
    this.router = new ModelRouter(this.registry, this.policy);
    this.cost = new CostKernel({
      perCallCapUsd: cfg.maxSpendPerCallUsd,
      baseline: {
        inputPerMillion: cfg.baselineInputPrice,
        outputPerMillion: cfg.baselineOutputPrice,
      },
    });
    this.review = new ReviewAgent(this.cost);
    this.terminalCwd = cwd;
    this.terminalShell = process.env.SHELL || process.env.COMSPEC || 'shell';

    // v2 subsystems
    this.sessions = new SessionStore(cfg.sessionsDir);
    this.a2a = new A2aManager({
      mode: cfg.a2aMode,
      dir: cfg.a2aDir,
      wsPort: cfg.a2aWsPort,
      allowlist: cfg.a2aAllowlist,
    });
    this.mcp = new McpManager(cfg.mcpConfigPath);
    this.memory = new ProjectMemory(cwd);
    this.checkpoints = new CheckpointStore(cfg.checkpointsDir, this.identity.sessionId);
    this.hooks = new HookEngine(cfg.hooksPath);
    // v3 subsystems
    this.contextStore = new ContextStore(cfg.contextStoreDir);
    this.playbooks = new PlaybookStore(cfg.playbooksPath);
    this.failures = new FailureStore(cfg.failuresPath);
    this.scratchpad = new Scratchpad(cfg.scratchpadPath);
    this.limits = loadLimits(cfg.limitsPath);
    // v3b: trust layer — daemon-only keystore, signed checkpoints, delegation.
    this.keystore = new AgentKeystore(cfg.keysDir);
    this.ledgerCheckpoints = new LedgerCheckpointStore(cfg.checkpointsLedgerPath);
    this.delegation = new DelegationRegistry(cfg.delegationsPath);
    // The A2A manager signs every outbound envelope with the system key.
    this.a2a.setSigner((hash) => this.keystore.sign(this.identity.agent('system'), hash));
    this.tools = new ToolRegistry({
      checkpoints: this.checkpoints,
      hooks: this.hooks,
      services: this.buildToolServices(),
      stampFor: (agent) => this.identity.stamp(agent, this.identity.newRun()),
      permissionMode: () => this.permissionMode,
      audit: (type, payload, identity) => {
        this.bus.publish(type, payload, identity);
        this.ledger.append({ type, payload, identity });
      },
      requestApproval: (summary) => this.gateToolApproval(summary),
      authorizeDelegation: (agent, action) => this.authorizeDelegation(agent, action),
    });

    // Register the core agents in the mesh.
    this.mesh.register(this.identity.agent('shell'), 'shell', false);
    this.mesh.register(this.identity.agent('review'), 'review', true);
    this.mesh.register(this.identity.agent('router'), 'router', true);

    // Mirror approval lifecycle into bus + ledger.
    this.approvals.onChange((req) => {
      const type = req.status === 'pending' ? 'approval.requested' : 'approval.resolved';
      this.record(type, req, 'system');
    });

    this.record('run.start', { startedAt: this.startedAt }, 'system');
    this.record('limits.loaded', { count: this.limits.cannot.length }, 'system');

    // Mint the system identity key + a human-approved root delegation grant for
    // this session. The root authorizes the system agent broadly; sub-agents
    // receive narrower, intersected grants via /delegate. Approval of the root
    // is the human's act of starting the session (ApprovalsPanel at startup).
    this.keystore.ensure(this.identity.agent('system'));
    this.establishRootGrant();
  }

  /**
   * Create (once) the session's human→system root delegation grant. Signed by
   * the system identity at the human's direction; parent === null and
   * humanApproved === true mark it as the chain terminus the daemon trusts.
   */
  private establishRootGrant(): void {
    if (this.rootGrant) return;
    const systemAgent = this.identity.agent('system');
    const scope: DelegationScope = {
      tools: ['*'],
      dataClasses: ['public', 'internal', 'secret', 'cui'],
      expiresAt: 0,
      spendBudgetUsd: 0,
    };
    this.rootGrant = this.delegation.issue({
      issuer: HUMAN_ROOT,
      grantee: systemAgent,
      scope,
      parent: null,
      humanApproved: true,
      sign: (msg) => this.keystore.sign(systemAgent, msg),
    });
    this.record('grant.root', { grantee: systemAgent, hash: this.rootGrant.hash }, 'system');
  }

  /**
   * Publish an identity-stamped event to the bus AND append it to the ledger.
   * Single choke point that satisfies rules 12, 13.
   */
  record(type: BusEvent['type'], payload: unknown, agentName: string): BusEvent {
    const runId = this.identity.newRun();
    const stamp = this.identity.stamp(agentName, runId);
    const evt = this.bus.publish(type, payload, stamp);
    this.ledger.append({ type, payload, identity: stamp });
    return evt;
  }

  // -- Terminal ------------------------------------------------------------

  setTerminalContext(cwd: string, shell: string): void {
    this.terminalCwd = cwd;
    this.terminalShell = shell;
  }

  ingestTerminalOutput(data: string): void {
    this.bus.publish('terminal.output', { data });
    const text = this.terminalLines.length ? this.terminalLines.pop()! + data : data;
    const parts = text.split(/\r?\n/);
    this.terminalLines.push(...parts);
    if (this.terminalLines.length > 1000) {
      this.terminalLines = this.terminalLines.slice(-1000);
    }
  }

  inspectInput(line: string): void {
    const finding = this.sentinel.inspectCommand(line);
    if (finding) {
      this.record('risk.detected', finding, 'system');
    }
  }

  /** True when the line is a slash command (must not reach the PTY). */
  isSlash(line: string): boolean {
    return line.trim().startsWith('/');
  }

  /**
   * Dispatch a slash command line. Audited as `command.slash` (the command name
   * + ok flag, never the raw args, which may contain secrets). Returns the
   * formatted output for the terminal view.
   */
  async dispatchSlash(line: string): Promise<SlashResult> {
    const { dispatchSlash } = await import('./slash-commands');
    const result = await dispatchSlash(this, line);
    const name = line.trim().replace(/^\//, '').split(/\s+/)[0] || 'help';
    this.record('command.slash', { command: name, ok: result.ok }, 'shell');
    return result;
  }

  /** Redaction preview for /redact-test (does not mutate the sentinel count). */
  redactPreview(text: string): string {
    const { redacted, total } = redact(text);
    return `${total} redaction(s)\n${redacted}`;
  }

  /** Restore the most recent checkpoint (optionally for a specific path). */
  rewind(filePath?: string): { id: string; filePath: string } | null {
    const restored = this.checkpoints.rewind(filePath);
    if (!restored) return null;
    this.record('checkpoint.restored', { id: restored.id, filePath: restored.filePath }, 'system');
    return { id: restored.id, filePath: restored.filePath };
  }

  // -- Context Economy (A1-A5) ---------------------------------------------

  /**
   * Ingest a context artifact through the content-addressed store and decide
   * what to actually send the model: full bytes on first sight for a provider,
   * or a stable ref + 3-line digest thereafter. Dedup hits are booked as tokens
   * NOT resent (cache savings) and every decision is a ledger event — the
   * cryptographic evidence chain of what the model was and wasn't shown.
   */
  ingestContext(
    content: string,
    kind: ContextBlobKind,
    source: string,
    provider = 'ollama',
  ): { payload: string; ref: ContextBlobRef; alreadySeen: boolean } {
    const evt = this.record('context.stored', { kind, source }, 'system');
    const prep = this.contextStore.prepareForSend(content, kind, source, provider, [evt.id]);
    this.contextGauge.add(prep.ref.tokens);
    if (prep.alreadySeen) {
      this.contextGauge.recordDedupHit();
      this.cost.recordDedup(prep.tokensSaved);
      this.cost.accountContext(0, prep.ref.tokens);
      this.record(
        'context.dedup',
        { hash: prep.ref.hash, source, tokensSaved: prep.tokensSaved },
        'system',
      );
    } else {
      this.cost.accountContext(prep.ref.tokens, prep.ref.tokens);
    }
    return { payload: prep.payload, ref: prep.ref, alreadySeen: prep.alreadySeen };
  }

  /**
   * Distill a turn into WARM SessionKnowledge using the LOCAL model ($0). The
   * raw turn is stored COLD (content-addressed) with provenance so exact bytes
   * can be rehydrated on demand. Cloud distillation is never used here.
   */
  async distillTurn(turn: string): Promise<void> {
    const evt = this.record('context.stored', { kind: 'knowledge', source: 'turn' }, 'system');
    const blob = this.contextStore.put(turn, 'other', 'turn', [evt.id]);
    const local = this.registry.local();
    const { distilledTokens, usedModel } = await this.knowledge.distill(turn, local, blob.hash);
    this.cost.recordDistillation(distilledTokens);
    this.record(
      'context.distilled',
      { blob: blob.hash, tokens: distilledTokens, engine: usedModel ? 'ollama' : 'heuristic' },
      'system',
    );
  }

  /**
   * Run the actuator for the current pressure: compact (warn), aggressive dedup
   * note (danger), or successor migration (migrate). Returns a short label of
   * what fired. Each decision is audited.
   */
  async actuateContext(): Promise<string> {
    const action = this.contextGauge.recommendedAction();
    switch (action) {
      case 'compact': {
        const moved = this.contextGauge.compactHotToWarm(this.cfg.hotTurnBudgetTokens);
        this.record('context.compacted', { warmTokensAdded: moved, trigger: 'warn' }, 'system');
        return `compacted oldest hot turns to warm (+${moved} warm tokens)`;
      }
      case 'dedup': {
        const moved = this.contextGauge.compactHotToWarm(this.cfg.hotTurnBudgetTokens * 2);
        this.record('context.compacted', { warmTokensAdded: moved, trigger: 'danger' }, 'system');
        return `aggressive dedup/compaction (+${moved} warm tokens)`;
      }
      case 'migrate':
        return this.migrateSuccessor();
      default:
        return 'no action: context pressure normal';
    }
  }

  /**
   * Spawn a successor run (same sessionId, NEW runId) seeded ONLY with the WARM
   * SessionKnowledge + pinned blobs — a clean continuation with full provenance,
   * ledger-linked to its ancestor. No silent quality cliff.
   */
  migrateSuccessor(): string {
    const ancestor = this.identity.newRun();
    this.ancestorRunId = ancestor;
    const pinned = this.contextStore.pinnedList();
    const pinnedTokens = pinned.reduce((n, r) => n + r.tokens, 0);
    // Reset hot context; reseed from knowledge digest + pinned blobs only.
    this.contextGauge.reset();
    const k = this.knowledge.get();
    const seedTokens = estimateTokens(JSON.stringify(k));
    this.contextGauge.addWarm(seedTokens);
    this.contextGauge.setPinnedTokens(pinnedTokens);
    this.record(
      'context.migrated',
      { ancestorRunId: ancestor, seededFrom: 'knowledge+pinned', pinned: pinned.length, seedTokens },
      'system',
    );
    return `migrated to successor run (seeded from ${pinned.length} pinned blob(s) + knowledge, ${seedTokens} tokens)`;
  }

  pinBlob(hash: string): string {
    const ref = this.contextStore.pin(hash);
    if (!ref) return `no blob ${hash}`;
    this.contextGauge.setPinnedTokens(this.contextStore.pinnedList().reduce((n, r) => n + r.tokens, 0));
    this.record('context.pinned', { hash: ref.hash, source: ref.source }, 'system');
    return `pinned ${ref.hash.slice(0, 12)} (${ref.source})`;
  }

  unpinBlob(hash: string): string {
    const ref = this.contextStore.unpin(hash);
    if (!ref) return `no blob ${hash}`;
    this.contextGauge.setPinnedTokens(this.contextStore.pinnedList().reduce((n, r) => n + r.tokens, 0));
    this.record('context.unpinned', { hash: ref.hash, source: ref.source }, 'system');
    return `unpinned ${ref.hash.slice(0, 12)} (${ref.source})`;
  }

  /**
   * Pull-based context (E3): query the store/knowledge/ledger for exactly what
   * is needed instead of guessing a dump. Returns the matching bytes/summary.
   */
  contextRequest(query: string, source: 'store' | 'knowledge' | 'ledger' = 'store'): string {
    this.record('context.requested', { source, query: query.slice(0, 40) }, 'system');
    if (source === 'knowledge') return JSON.stringify(this.knowledge.get());
    if (source === 'ledger') {
      const matches = this.ledger
        .all()
        .filter((e) => e.type.includes(query) || (e.sessionId ?? '').includes(query))
        .slice(-20)
        .map((e) => `#${e.seq} ${e.type} ${e.hash.slice(0, 12)}`);
      return matches.length ? matches.join('\n') : '(no ledger matches)';
    }
    // store: exact hash, then source substring
    const byHash = this.contextStore.read(query);
    if (byHash) return byHash;
    const ref = this.contextStore.list().find((r) => r.source.includes(query));
    if (ref) return this.contextStore.read(ref.hash) ?? ref.digest;
    return '(no context matches)';
  }

  // -- Self-introspection (E8) + metabolic awareness (E9) ------------------

  /** Query the agent's own history: what did I try, where did I loop, cost. */
  introspect(): string {
    this.record('introspect.query', {}, 'system');
    const entries = this.ledger.all().filter((e) => e.sessionId === this.identity.sessionId);
    const byType: Record<string, number> = {};
    for (const e of entries) byType[e.type] = (byType[e.type] ?? 0) + 1;
    const tools = entries.filter((e) => e.type === 'tool.call').length;
    const blocked = entries.filter((e) => e.type === 'tool.blocked').length;
    const cost = this.cost.snapshot();
    return JSON.stringify({
      sessionId: this.identity.sessionId,
      events: entries.length,
      toolCalls: tools,
      blocked,
      byType,
      spendUsd: cost.sessionSpendUsd,
      avoidedUsd: cost.avoidedSpendUsd,
      contextEfficiencyPct: cost.contextEfficiencyPct,
    });
  }

  /** Cheap readable resource state the model can feel (E9). */
  metabolic(): MetabolicState {
    const ctx = this.contextGauge.snapshot();
    return {
      contextRemainingPct: Math.max(0, 100 - ctx.pressure),
      budgetRemainingUsd: Math.max(0, this.cfg.maxSpendPerCallUsd - this.cost.snapshot().sessionSpendUsd),
      elapsedMs: Date.now() - this.startedAt,
    };
  }

  // -- Skill crystallization (E1) + failure memory (E2) --------------------

  crystallizePlaybook(input: {
    situation: string;
    title: string;
    steps: string[];
    pitfalls?: string[];
  }): string {
    const evt = this.record('playbook.crystallized', { title: input.title }, 'system');
    const pb = this.playbooks.crystallize({ ...input, provenance: [evt.id] });
    return `crystallized playbook "${pb.title}" v${pb.version} (${pb.hash.slice(0, 12)})`;
  }

  loadPlaybooks(situation: string): string {
    const matches = this.playbooks.match(situation);
    if (matches.length === 0) return '(no matching playbooks)';
    this.record('playbook.loaded', { situation: situation.slice(0, 40), count: matches.length }, 'system');
    return matches
      .map((p) => `▸ ${p.title} (v${p.version})\n  ${p.steps.join('\n  ')}`)
      .join('\n');
  }

  recordFailure(input: { signature: string; whatNotToDo: string; whatWorkedInstead: string }): string {
    const evt = this.record('failure.recorded', { signature: input.signature.slice(0, 40) }, 'system');
    const rec = this.failures.record({ ...input, provenance: [evt.id] });
    return `recorded anti-pattern (${rec.hash.slice(0, 12)})`;
  }

  /** One-line warning if a similar situation has failed before (E2). */
  failureWarning(situation: string): string | null {
    const warning = this.failures.warn(situation);
    if (warning) this.record('failure.matched', { situation: situation.slice(0, 40) }, 'system');
    return warning;
  }

  // -- Review pipeline -----------------------------------------------------

  async runReview(mode: ReviewMode): Promise<ReviewResult> {
    const reviewAgent = 'review';
    const memoryText = this.memory.read();
    const snapshot = buildSnapshot({
      cwd: this.terminalCwd,
      shell: this.terminalShell,
      terminalLines: this.terminalLines,
    });
    const rawText = (memoryText ? `# SELFCONNECT.md (project memory)\n${memoryText}\n\n` : '') +
      snapshotToText(snapshot);

    const { redacted, total } = redact(rawText);
    this.sentinel.addRedactions(total);
    if (total > 0) {
      this.record('redaction.applied', { count: total }, reviewAgent);
    }

    const inputTokens = estimateTokens(redacted);
    const outputTokens = 600;
    this.contextGauge.add(inputTokens);

    const provider0 = this.registry.local();
    const estimate = this.cost.estimate(
      provider0.tier,
      inputTokens,
      outputTokens,
      provider0.price(),
    );
    const decision = this.router.route({ estimatedCostUsd: estimate.costUsd });
    this.record('route.decision', decision, 'router');

    if (decision.blocked) {
      this.record('policy.block', { reason: decision.blockReason, mode }, 'router');
      throw new Error(decision.blockReason || 'Routing blocked by policy');
    }

    if (decision.requiresApproval) {
      this.mesh.setState(this.identity.agent(reviewAgent), 'blocked-on-approval');
      const { promise } = this.approvals.request({
        kind: decision.tier === 'premium' ? 'premium-escalation' : 'cloud-send',
        summary: `Review (${mode}) via ${decision.provider}/${decision.model}`,
        provider: decision.provider,
        model: decision.model,
        estimatedCostUsd: estimate.costUsd,
      });
      const status = await promise;
      this.mesh.setState(this.identity.agent(reviewAgent), 'running');
      if (!ApprovalManager.isGranted(status)) {
        this.record('policy.block', { reason: `approval ${status}`, mode }, 'router');
        throw new Error(`Cloud call not approved (${status})`);
      }
    }

    const provider = this.registry.get(decision.provider);
    this.mesh.setState(this.identity.agent(reviewAgent), 'running');
    this.record('review.start', { mode, provider: decision.provider }, reviewAgent);

    const result = await this.review.run(mode, rawText, provider);
    this.contextGauge.add(result.cost.outputTokens);
    this.cost.setLast(result.cost);
    this.mesh.setState(this.identity.agent(reviewAgent), 'idle');
    this.record(
      'review.result',
      { mode, provider: result.provider, costUsd: result.cost.costUsd },
      reviewAgent,
    );
    this.record('cost.update', this.cost.snapshot(), 'system');
    this.persistSnapshot();
    return result;
  }

  // -- Approvals -----------------------------------------------------------

  decideApproval(id: string, approve: boolean): void {
    this.approvals.decide(id, approve);
  }

  private async gateToolApproval(summary: string): Promise<boolean> {
    const { promise } = this.approvals.request({
      kind: 'cloud-send',
      summary,
      provider: 'ollama',
      model: 'tool',
      estimatedCostUsd: 0,
    });
    const status = await promise;
    return ApprovalManager.isGranted(status);
  }

  // -- Local-only toggle ---------------------------------------------------

  setLocalOnly(localOnly: boolean): UiState {
    this.policy.setLocalOnly(localOnly);
    this.record('route.decision', { localOnlyChanged: localOnly }, 'router');
    return this.snapshot();
  }

  // -- Permission mode -----------------------------------------------------

  setPermissionMode(mode: PermissionMode): void {
    this.permissionMode = mode;
    this.record('permission.mode', { mode }, 'system');
  }

  getPermissionMode(): PermissionMode {
    return this.permissionMode;
  }

  // -- Ledger --------------------------------------------------------------

  verifyLedger(): ChainStatus {
    const status = this.ledger.verifyChain();
    this.record('ledger.verify', status, 'system');
    return status;
  }

  // -- Sessions ------------------------------------------------------------

  listSessions(): SessionSummary[] {
    return this.sessions.list();
  }

  /** Build the persistable snapshot of current daemon state. */
  buildSessionSnapshot(): SessionSnapshot {
    return {
      version: 3,
      sessionId: this.identity.sessionId,
      startedAt: this.startedAt,
      lastActiveAt: Date.now(),
      cost: this.cost.snapshot(),
      context: this.contextGauge.snapshot(),
      sentinel: this.sentinel.snapshot(),
      agents: this.mesh.snapshot(),
      localOnly: this.policy.localOnly,
      permissionMode: this.permissionMode,
      todos: this.todos.list(),
      scrollback: this.terminalLines.slice(-300),
      knowledge: this.knowledge.get(),
      blobs: this.contextStore.list(),
      ancestorRunId: this.ancestorRunId,
    };
  }

  persistSnapshot(): void {
    try {
      this.sessions.save(this.buildSessionSnapshot());
      this.record('session.snapshot', { sessionId: this.identity.sessionId }, 'system');
    } catch {
      // best-effort persistence
    }
  }

  /**
   * Resume a past session: load its snapshot, replay ledger events for that
   * sessionId to reconcile, and continue under the SAME sessionId with a NEW
   * runId. Returns the restored scrollback so the renderer can repaint xterm.
   */
  resumeSession(sessionId: string): { ok: boolean; scrollback: string[]; reason?: string } {
    const snap = this.sessions.load(sessionId);
    if (!snap) return { ok: false, scrollback: [], reason: `no snapshot for ${sessionId}` };

    // Continue the SAME sessionId, fresh agent ids minted under it.
    this.identity = new IdentityRegistry(sessionId);
    this.startedAt = snap.startedAt;

    // Restore stateful subsystems from the snapshot. Resume re-reads NOTHING:
    // the WARM SessionKnowledge + content-addressed blob refs come straight off
    // the snapshot; bytes stay on disk for on-demand rehydration only.
    this.cost.restore(snap.cost);
    this.contextGauge.restore(snap.context.usedTokens);
    this.contextGauge.restoreBreakdown(snap.context);
    this.sentinel.restore(snap.sentinel);
    this.policy.setLocalOnly(snap.localOnly);
    this.permissionMode = snap.permissionMode;
    this.todos.restore(snap.todos);
    this.terminalLines = snap.scrollback.slice();
    this.checkpoints = new CheckpointStore(this.cfg.checkpointsDir, sessionId);
    this.knowledge.restore(snap.knowledge);
    this.contextStore.restore(snap.blobs ?? []);
    this.ancestorRunId = snap.ancestorRunId;

    // Reconcile via ledger replay: count this session's prior events.
    const replayed = this.ledger.all().filter((e) => e.sessionId === sessionId).length;

    // Re-register agents under the resumed identity.
    this.mesh.register(this.identity.agent('shell'), 'shell', false);
    this.mesh.register(this.identity.agent('review'), 'review', true);
    this.mesh.register(this.identity.agent('router'), 'router', true);

    this.record('session.resumed', { sessionId, replayed }, 'system');
    return { ok: true, scrollback: this.terminalLines.slice() };
  }

  // -- Todos ---------------------------------------------------------------

  writeTodos(items: { content: string; status: TodoStatus }[]): void {
    this.todos.set(items);
    this.knowledge.setTodos(this.todos.list().map((t) => `[${t.status}] ${t.content}`));
    this.record('todo.update', { todos: this.todos.list() }, 'system');
    this.persistSnapshot();
  }

  // -- A2A -----------------------------------------------------------------

  async a2aStart(): Promise<void> {
    await this.a2a.start();
  }

  async a2aSend(peer: string, message: string, kind: A2aKind = 'msg'): Promise<string> {
    if (this.a2a.requiresApproval(peer, kind)) {
      const granted = await this.gateToolApproval(`A2A ${kind} to ${peer}`);
      if (!granted) {
        this.record('policy.block', { reason: 'a2a not approved', peer, kind }, 'system');
        return `blocked: A2A ${kind} to ${peer} not approved`;
      }
    }
    const from = this.identity.stamp('shell', this.identity.newRun());
    const { envelope, redactions } = await this.a2a.send(from, peer, kind, message);
    if (redactions > 0) {
      this.sentinel.addRedactions(redactions);
      this.record('redaction.applied', { count: redactions }, 'system');
    }
    this.record('a2a.sent', { peer, kind, id: envelope.id, redactions }, 'system');
    return `sent ${kind} to ${peer} (id ${envelope.id}, ${redactions} redaction(s))`;
  }

  async a2aPoll(): Promise<void> {
    const { received, findings } = await this.a2a.poll();
    for (const env of received) {
      this.record('a2a.received', { from: env.from.agentId, kind: env.kind, id: env.id }, 'system');
    }
    for (const f of findings) {
      this.sentinel.addFinding(f);
      this.record('a2a.chain_broken', f, 'system');
      this.record('risk.detected', f, 'system');
    }
  }

  // -- MCP -----------------------------------------------------------------

  async mcpCall(server: string, tool: string, args: unknown): Promise<string> {
    this.record('mcp.call', { server, tool }, 'system');
    const { result, redactions } = await this.mcp.callTool(server, tool, args);
    if (redactions > 0) {
      this.sentinel.addRedactions(redactions);
      this.record('redaction.applied', { count: redactions }, 'system');
    }
    this.record('mcp.result', { server, tool, redactions }, 'system');
    return result;
  }

  // -- Tool services -------------------------------------------------------

  private buildToolServices(): ToolServices {
    return {
      cwd: this.terminalCwd,
      runBash: async (command) => {
        const finding = this.sentinel.inspectCommand(command);
        if (finding) this.record('risk.detected', finding, 'shell');
        // Headless tool path does not own a live PTY; record intent + echo.
        this.record('terminal.input', { line: command }, 'shell');
        return `[bash queued] ${command}`;
      },
      webFetch: async (url) => {
        const { total } = redact(url);
        if (total > 0) this.sentinel.addRedactions(total);
        try {
          const res = await fetch(url);
          const text = await res.text();
          return redact(text).redacted.slice(0, 4000);
        } catch (err) {
          return `web_fetch error: ${err instanceof Error ? err.message : String(err)}`;
        }
      },
      webSearch: async (query) => {
        if (this.policy.localOnly) return 'blocked: web_search is cloud and LOCAL_ONLY is active';
        if (!this.cfg.searchApiUrl) return 'web_search: no SEARCH_API_URL configured';
        try {
          const url = `${this.cfg.searchApiUrl}?q=${encodeURIComponent(query)}`;
          const res = await fetch(url, {
            headers: this.cfg.searchApiKey ? { authorization: `Bearer ${this.cfg.searchApiKey}` } : {},
          });
          return redact(await res.text()).redacted.slice(0, 4000);
        } catch (err) {
          return `web_search error: ${err instanceof Error ? err.message : String(err)}`;
        }
      },
      spawnTask: async (prompt, allowedTools) => {
        const taskAgent = this.identity.agent(`task_${Math.random().toString(36).slice(2, 6)}`);
        this.mesh.register(taskAgent, 'system', true);
        this.mesh.setState(taskAgent, 'running');
        this.record('agent.spawn', { agentId: taskAgent, allowedTools }, 'system');
        const result = `sub-agent handled: ${prompt.slice(0, 80)}`;
        this.mesh.setState(taskAgent, 'exited');
        this.record('agent.exit', { agentId: taskAgent }, 'system');
        return result;
      },
      askUser: async (question) => {
        const granted = await this.gateToolApproval(`ask_user: ${question}`);
        return granted ? 'user: approved' : 'user: denied/timeout';
      },
      ledgerVerify: () => JSON.stringify(this.ledger.verifyChain()),
      ledgerQuery: (opts) => {
        let entries = this.ledger.all().slice();
        if (opts.sessionId) entries = entries.filter((e) => e.sessionId === opts.sessionId);
        if (opts.type) entries = entries.filter((e) => e.type === opts.type);
        const limit = opts.limit ?? 20;
        return entries
          .slice(-limit)
          .map((e) => `#${e.seq} ${e.type} ${e.hash.slice(0, 12)}`)
          .join('\n');
      },
      costReport: () => JSON.stringify(this.cost.snapshot()),
      redactText: (text) => {
        const { redacted, total } = redact(text);
        this.sentinel.addRedactions(total);
        return `${total} redaction(s)\n${redacted}`;
      },
      reviewRequest: async (mode) => {
        const r = await this.runReview(mode as ReviewMode);
        return r.content;
      },
      a2aSend: (peer, message) => this.a2aSend(peer, message),
      a2aPeers: () => JSON.stringify(this.a2a.peerList()),
      sessionList: () => JSON.stringify(this.listSessions()),
      sessionResume: (sessionId) => JSON.stringify(this.resumeSession(sessionId)),
      mcpCall: (server, tool, args) => this.mcpCall(server, tool, args),
      todoWrite: (items) => {
        this.writeTodos(items.map((t) => ({ content: t.content, status: t.status as TodoStatus })));
        return `wrote ${items.length} todo(s)`;
      },
      todoRead: () => JSON.stringify(this.todos.list()),
      memoryRead: () => this.memory.read() || '(SELFCONNECT.md empty)',
      memoryWrite: (content) => {
        this.memory.write(content);
        return `wrote ${content.length} bytes to ${this.memory.path}`;
      },
      // v3
      contextRequest: (query, source) => this.contextRequest(query, source),
      scratchpadWrite: (key, value) => {
        const n = this.scratchpad.write(key, value);
        this.record('scratchpad.write', { key, bytes: n }, 'system');
        return `wrote ${n} bytes to scratchpad[${key}]`;
      },
      scratchpadRead: (query) => {
        this.record('scratchpad.read', { query: query.slice(0, 40) }, 'system');
        const direct = this.scratchpad.read(query);
        if (direct !== null) return direct;
        const keys = this.scratchpad.query(query);
        return keys.length ? `keys: ${keys.join(', ')}` : '(scratchpad empty/no match)';
      },
      introspect: () => this.introspect(),
      metabolic: () => JSON.stringify(this.metabolic()),
      limits: () => JSON.stringify(this.limits),
      crystallizePlaybook: (input) => this.crystallizePlaybook(input),
      loadPlaybooks: (situation) => this.loadPlaybooks(situation),
      recordFailure: (input) => this.recordFailure(input),
    };
  }

  // -- Aggregate state -----------------------------------------------------

  async snapshotAsync(): Promise<UiState> {
    const liveness = await this.registry.liveness();
    return this.composeState(liveness);
  }

  get terminalContext(): { cwd: string; shell: string } {
    return { cwd: this.terminalCwd, shell: this.terminalShell };
  }

  snapshot(): UiState {
    return this.composeState(
      this.registry.all().map((p) => ({ kind: p.kind, alive: false, detail: 'unprobed' })),
    );
  }

  private composeState(liveness: UiState['liveness']): UiState {
    const route = this.router.route({ estimatedCostUsd: 0 });
    return {
      identity: this.identity.stamp('system', this.identity.newRun()),
      cost: this.cost.snapshot(),
      context: this.contextGauge.snapshot(),
      route,
      liveness,
      localOnly: this.policy.localOnly,
      sentinel: this.sentinel.snapshot(),
      agents: this.mesh.snapshot(),
      approvals: this.approvals.list(),
      ledger: this.ledger.status(),
      permissionMode: this.permissionMode,
      todos: this.todos.list(),
      sessions: this.listSessions(),
      peers: this.a2a.peerList(),
      knowledge: this.knowledge.get(),
      metabolic: this.metabolic(),
      pinned: this.contextStore.pinnedList(),
      metering: this.cost.meteringList(),
      grants: this.delegation.all(),
      checkpoints: this.ledgerCheckpoints.count(),
    };
  }

  // -- Trust layer (B2.1–B2.4, B) ------------------------------------------

  /**
   * Authorize an agent action against its delegation chain (B2.2). Agents
   * without an explicit grant fall back to the system agent's root authority;
   * any other agent must hold a chain terminating at the human root. A denial
   * is recorded as `delegation.denied` and surfaces its reason as steering.
   */
  authorizeDelegation(
    agent: string,
    action: { tool?: string; spendUsd?: number; dataClass?: DataClass },
  ): DelegationVerdict {
    const systemAgent = this.identity.agent('system');
    const agentId = agent === 'system' || agent === 'tool' || agent === 'shell' ? systemAgent : agent;
    // The system agent rides the session root grant directly.
    const grantee = this.delegation.latestFor(agentId) ? agentId : systemAgent;
    const verdict = this.delegation.authorize(grantee, action);
    if (!verdict.ok) {
      this.record('delegation.denied', { agent: agentId, action, reason: verdict.reason }, 'system');
    }
    return verdict;
  }

  /**
   * Issue a scoped sub-grant from an issuing agent to a grantee (/delegate).
   * The issuer must already hold authority; the child scope is recorded as-is
   * and intersected with its parents at verification time.
   */
  delegate(input: {
    issuer?: string;
    grantee: string;
    tools?: string[];
    spendBudgetUsd?: number;
    expiresInMs?: number;
    dataClasses?: DataClass[];
  }): DelegationCert {
    const systemAgent = this.identity.agent('system');
    const issuerId = input.issuer ?? systemAgent;
    this.keystore.ensure(issuerId);
    const parent = this.delegation.latestFor(issuerId) ?? this.rootGrant;
    const scope: DelegationScope = {
      tools: input.tools && input.tools.length ? input.tools : ['*'],
      dataClasses: input.dataClasses && input.dataClasses.length ? input.dataClasses : ['public'],
      expiresAt: input.expiresInMs && input.expiresInMs > 0 ? Date.now() + input.expiresInMs : 0,
      spendBudgetUsd: input.spendBudgetUsd ?? 0,
    };
    const cert = this.delegation.issue({
      issuer: issuerId,
      grantee: input.grantee,
      scope,
      parent: parent ? parent.hash : null,
      humanApproved: false,
      sign: (msg) => this.keystore.sign(issuerId, msg),
    });
    this.record('delegation.issued', { issuer: issuerId, grantee: input.grantee, hash: cert.hash, scope }, 'system');
    return cert;
  }

  listGrants(): DelegationCert[] {
    return this.delegation.all();
  }

  /** Verify a delegation chain by its head hash (for /grants detail + CLI). */
  verifyGrant(hash: string): DelegationVerdict {
    return this.delegation.verifyChain(hash);
  }

  /** Seal the current ledger head as a signed checkpoint (B). */
  sealCheckpoint(): { seq: number; hash: string; entries: number } {
    const status = this.ledger.status();
    const entries = this.ledger.all();
    const head = entries[entries.length - 1];
    const seq = head ? head.seq : 0;
    const hash = head ? head.hash : status.lastHash;
    const cp = this.ledgerCheckpoints.seal(
      { seq, hash, entries: status.entries },
      (msg) => this.keystore.sign(this.identity.agent('system'), msg),
    );
    this.record('checkpoint.signed', { seq: cp.seq, hash: cp.hash, entries: cp.entries }, 'system');
    return { seq: cp.seq, hash: cp.hash, entries: cp.entries };
  }

  /** Build + sign an exportable passport over this session's ledger (B2.3). */
  exportPassport(sessionId?: string): Passport {
    const sid = sessionId && sessionId.length ? sessionId : this.identity.sessionId;
    const events = this.ledger.all().filter((e) => !e.sessionId || e.sessionId === sid);
    const agentId = this.identity.agent('system');
    this.keystore.ensure(agentId);
    const artifact = buildPassport(agentId, [...events], (msg) => this.keystore.sign(agentId, msg));
    this.lastPassport = artifact;
    this.record('passport.exported', { agentId, leafCount: artifact.passport.leafCount, root: artifact.passport.merkleRoot }, 'system');
    return artifact.passport;
  }

  /** Verify a passport's signature (B2.3). */
  verifyPassportSig(passport: Passport): { ok: boolean; reason: string } {
    const v = verifyPassport(passport);
    this.record('passport.verified', { agentId: passport.agentId, ok: v.ok }, 'system');
    return { ok: v.ok, reason: v.reason };
  }

  /** Produce a selective reveal of one leaf from the last exported passport. */
  revealPassportLeaf(index: number, content?: string): MerkleReveal | null {
    if (!this.lastPassport) return null;
    if (index < 0 || index >= this.lastPassport.leaves.length) return null;
    return revealLeaf(this.lastPassport, index, content);
  }

  /** Verify a selective reveal against a passport root (B2.3). */
  verifyPassportReveal(passport: Passport, reveal: MerkleReveal): boolean {
    return verifyReveal(passport, reveal);
  }

  /** Build a signed session replay bundle (.screplay) (B flight recorder). */
  exportReplay(sessionId?: string): ReplayBundle {
    const sid = sessionId && sessionId.length ? sessionId : this.identity.sessionId;
    const events = this.ledger.all().filter((e) => !e.sessionId || e.sessionId === sid);
    const seqs = new Set(events.map((e) => e.seq));
    const checkpoints = this.ledgerCheckpoints.all().filter((c) => seqs.has(c.seq));
    const agentId = this.identity.agent('system');
    const bundle = buildReplayBundle({
      sessionId: sid,
      events: [...events],
      checkpoints: [...checkpoints],
      publicKeys: this.keystore.allPublicKeys(),
      sign: (msg) => this.keystore.sign(agentId, msg),
    });
    this.record('replay.exported', { sessionId: sid, events: bundle.events.length }, 'system');
    return bundle;
  }

  /** Verify a replay bundle end-to-end (B). */
  verifyReplay(bundle: ReplayBundle): ReturnType<typeof verifyReplayBundle> {
    return verifyReplayBundle(bundle);
  }

  /** Build a compliance evidence bundle for a session (B). */
  exportEvidence(sessionId?: string): ReturnType<typeof buildEvidenceBundle> {
    const sid = sessionId && sessionId.length ? sessionId : this.identity.sessionId;
    const events = this.ledger.all().filter((e) => !e.sessionId || e.sessionId === sid);
    const seqs = new Set(events.map((e) => e.seq));
    const checkpoints = this.ledgerCheckpoints.all().filter((c) => seqs.has(c.seq));
    const chain = this.ledger.status();
    const cpVerify = this.ledgerCheckpoints.verify(this.ledger.all());
    const bundle = buildEvidenceBundle({
      sessionId: sid,
      events: [...events],
      checkpoints: [...checkpoints],
      publicKeys: this.keystore.allPublicKeys(),
      chainOk: chain.ok,
      checkpointsOk: cpVerify.ok,
      brokenAt: chain.brokenAt,
    });
    this.record('evidence.exported', { sessionId: sid, entries: bundle.events.length }, 'system');
    return bundle;
  }

  /** Full ledger verification: hash chain AND every checkpoint signature (B). */
  verifyLedgerFull(): { chainOk: boolean; checkpointsOk: boolean; entries: number; checkpoints: number; brokenAt: number | null; reason?: string } {
    const chain = this.ledger.status();
    const cp = this.ledgerCheckpoints.verify(this.ledger.all());
    return {
      chainOk: chain.ok,
      checkpointsOk: cp.ok,
      entries: chain.entries,
      checkpoints: cp.checkpoints,
      brokenAt: chain.brokenAt,
      reason: cp.reason,
    };
  }

  /** Record a per-agent metering delta + signed receipt path (B2.4). */
  meterAgent(agentId: string, delta: { toolCalls?: number; spendUsd?: number; inputTokens?: number; outputTokens?: number }): void {
    const rec = this.cost.meter(agentId, delta);
    this.record('metering.recorded', rec, 'system');
  }

  /** Identity helper for callers that need a stamp (CLI/SDK). */
  stamp(agent: string): Identity {
    return this.identity.stamp(agent, this.identity.newRun());
  }

  /** Record an externally-derived sentinel finding (e.g. test/A2A). */
  recordFinding(finding: RiskFinding): void {
    this.sentinel.addFinding(finding);
    this.record('risk.detected', finding, 'system');
  }
}

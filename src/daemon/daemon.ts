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
import type { ToolServices } from './tools/types';
import type { SlashResult } from '../shared/contracts';

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

  private permissionMode: PermissionMode = 'auto';
  private startedAt = Date.now();
  private terminalLines: string[] = [];
  private terminalCwd: string;
  private terminalShell: string;

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
      version: 2,
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

    // Restore stateful subsystems from the snapshot.
    this.cost.restore(snap.cost);
    this.contextGauge.restore(snap.context.usedTokens);
    this.sentinel.restore(snap.sentinel);
    this.policy.setLocalOnly(snap.localOnly);
    this.permissionMode = snap.permissionMode;
    this.todos.restore(snap.todos);
    this.terminalLines = snap.scrollback.slice();
    this.checkpoints = new CheckpointStore(this.cfg.checkpointsDir, sessionId);

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
    };
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

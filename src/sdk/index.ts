/**
 * SelfConnect typed SDK.
 *
 * A thin, fully-typed wrapper over the trusted Daemon core for headless and
 * embedding use. Everything still flows through the SAME governed path:
 * identity-stamped event bus -> policy -> approvals -> redaction ->
 * hash-chained ledger. Provider keys stay daemon-only; the SDK never sees them.
 */
import { Daemon } from '../daemon/daemon';
import { loadConfig, type DaemonConfig } from '../daemon/config';
import type {
  BusEvent,
  ChainStatus,
  PermissionMode,
  ReviewMode,
  ReviewResult,
  SessionSummary,
  TodoItem,
  TodoStatus,
  ToolDescriptor,
  ToolResult,
  UiState,
  A2aKind,
  A2aPeer,
  SlashResult,
  LabTask,
  LabReport,
  ConsultResult,
} from '../shared/contracts';
import type { InvokeOptions } from '../daemon/tools/registry';

export interface SelfConnectClientOptions {
  /** Override env-sourced config (mainly for tests). */
  config?: Partial<DaemonConfig>;
  /** Working directory for terminal context + project memory. */
  cwd?: string;
}

/**
 * Programmatic client. Owns a Daemon instance and exposes the governed
 * operations as typed async methods.
 */
export class SelfConnectClient {
  readonly daemon: Daemon;

  constructor(opts: SelfConnectClientOptions = {}) {
    const cfg = { ...loadConfig(), ...(opts.config ?? {}) };
    this.daemon = new Daemon(cfg, opts.cwd ?? process.cwd());
  }

  /** Subscribe to the identity-stamped event bus. Returns an unsubscribe fn. */
  onEvent(handler: (evt: BusEvent) => void): () => void {
    return this.daemon.bus.on(handler);
  }

  /** Aggregate UI/state snapshot (no live provider probing). */
  state(): UiState {
    return this.daemon.snapshot();
  }

  /** Aggregate snapshot WITH live provider liveness probing. */
  stateAsync(): Promise<UiState> {
    return this.daemon.snapshotAsync();
  }

  // -- Slash + review ------------------------------------------------------

  slash(line: string): Promise<SlashResult> {
    return this.daemon.dispatchSlash(line);
  }

  review(mode: ReviewMode): Promise<ReviewResult> {
    return this.daemon.runReview(mode);
  }

  // -- Policy / permissions ------------------------------------------------

  setLocalOnly(localOnly: boolean): UiState {
    return this.daemon.setLocalOnly(localOnly);
  }

  setPermissionMode(mode: PermissionMode): void {
    this.daemon.setPermissionMode(mode);
  }

  getPermissionMode(): PermissionMode {
    return this.daemon.getPermissionMode();
  }

  // -- Ledger --------------------------------------------------------------

  verifyLedger(): ChainStatus {
    return this.daemon.verifyLedger();
  }

  // -- Sessions ------------------------------------------------------------

  listSessions(): SessionSummary[] {
    return this.daemon.listSessions();
  }

  resume(sessionId: string): { ok: boolean; scrollback: string[]; reason?: string } {
    return this.daemon.resumeSession(sessionId);
  }

  // -- Todos ---------------------------------------------------------------

  todos(): TodoItem[] {
    return this.daemon.todos.list();
  }

  writeTodos(items: { content: string; status: TodoStatus }[]): void {
    this.daemon.writeTodos(items);
  }

  // -- Tools ---------------------------------------------------------------

  listTools(): ToolDescriptor[] {
    return this.daemon.tools.list();
  }

  invokeTool(
    name: string,
    input: unknown,
    agent = 'tool',
    options?: InvokeOptions,
  ): Promise<ToolResult> {
    return this.daemon.tools.invoke(name, input, agent, undefined, options);
  }

  /** E5: dry-run a tool — predicted effects only, nothing executes. */
  simulateTool(name: string, input: unknown, agent = 'tool'): Promise<ToolResult> {
    return this.daemon.tools.invoke(name, input, agent, undefined, { simulate: true });
  }

  // -- D6 harness lab ------------------------------------------------------

  runLab(task: LabTask): Promise<LabReport> {
    return this.daemon.runLab(task);
  }

  reportLab(sessionId: string, taskName?: string): LabReport {
    return this.daemon.reportLab(sessionId, taskName);
  }

  renderLab(report: LabReport): string {
    return this.daemon.renderLab(report);
  }

  // -- E7 consult (second opinion) -----------------------------------------

  consult(input: {
    question: string;
    contextRefs?: string[];
    provider?: 'ollama' | 'openai-compatible' | 'anthropic';
    budgetUsd?: number;
  }): Promise<ConsultResult> {
    return this.daemon.consult(input);
  }

  // -- A2A -----------------------------------------------------------------

  a2aStart(): Promise<void> {
    return this.daemon.a2aStart();
  }

  a2aSend(peer: string, message: string, kind: A2aKind = 'msg'): Promise<string> {
    return this.daemon.a2aSend(peer, message, kind);
  }

  a2aPeers(): A2aPeer[] {
    return this.daemon.a2a.peerList();
  }

  // -- MCP -----------------------------------------------------------------

  mcpServers(): string[] {
    return this.daemon.mcp.serverNames();
  }

  mcpCall(server: string, tool: string, args: unknown): Promise<string> {
    return this.daemon.mcpCall(server, tool, args);
  }

  // -- Approvals -----------------------------------------------------------

  decideApproval(id: string, approve: boolean): void {
    this.daemon.decideApproval(id, approve);
  }
}

export type { DaemonConfig } from '../daemon/config';
export * from '../shared/contracts';
export * from '../daemon/local-model-worker';

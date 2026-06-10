import type { z } from 'zod';
import type { Identity, PermissionMode, RiskSeverity } from '../../shared/contracts';

/**
 * A governed tool. Every tool declares whether it mutates state and/or is
 * read-only, its risk level, and a Zod input schema. The ToolRegistry stamps
 * identity, applies the permission mode, runs hooks, snapshots checkpoints for
 * writers, redacts outbound text, and audits call+result to the ledger.
 */
export interface GovernedTool<I = unknown> {
  name: string;
  description: string;
  /** Mutating tools are blocked in `plan` mode and gated in `ask` mode. */
  mutating: boolean;
  /** Read-only tools are exposed to the MCP server subset. */
  readOnly: boolean;
  /** Baseline risk; bash may escalate per-command. */
  risk: RiskSeverity;
  /** Writers whose paths should be checkpointed before mutation. */
  checkpointPaths?: (input: I) => string[];
  inputSchema: z.ZodType<I>;
  run(input: I, ctx: ToolContext): Promise<string> | string;
}

export interface ToolContext {
  identity: Identity;
  permissionMode: PermissionMode;
  /** Daemon-provided services the tools may use (kept narrow). */
  services: ToolServices;
}

/** Narrow service surface tools may call. Injected by the daemon. */
export interface ToolServices {
  cwd: string;
  /** Run a shell command through the governed PTY path; returns combined output. */
  runBash(command: string, background: boolean): Promise<string>;
  /** Web fetch (outbound text redacted by caller). */
  webFetch(url: string): Promise<string>;
  /** Web search (cloud — gated by policy/local-only). */
  webSearch(query: string): Promise<string>;
  /** Spawn a scoped sub-agent task in the mesh; returns its result text. */
  spawnTask(prompt: string, allowedTools: string[]): Promise<string>;
  /** Ask the human a question via the approvals panel; resolves to the answer. */
  askUser(question: string): Promise<string>;
  /** SelfConnect-only operations exposed as tools. */
  ledgerVerify(): string;
  ledgerQuery(opts: { sessionId?: string; type?: string; limit?: number }): string;
  costReport(): string;
  redactText(text: string): string;
  reviewRequest(mode: string): Promise<string>;
  a2aSend(peer: string, message: string): Promise<string>;
  a2aPeers(): string;
  sessionList(): string;
  sessionResume(sessionId: string): string;
  mcpCall(server: string, tool: string, args: unknown): Promise<string>;
  todoWrite(items: { content: string; status: string }[]): string;
  todoRead(): string;
  memoryRead(): string;
  memoryWrite(content: string): string;
  // --- v3: Context Economy + agent's own asks ---
  /** Pull exactly the context needed from store/knowledge/ledger (E3). */
  contextRequest(query: string, source: 'store' | 'knowledge' | 'ledger'): string;
  /** External working memory NOT carried in the prompt (E4). */
  scratchpadWrite(key: string, value: string): string;
  scratchpadRead(query: string): string;
  /** Query the agent's own session history/costs (E8). */
  introspect(): string;
  /** Cheap readable resource state: context %, budget, elapsed (E9). */
  metabolic(): string;
  /** Machine-readable manifest of what this harness/model CANNOT do (E10). */
  limits(): string;
  /** Crystallize a reusable playbook from a solved procedure (E1). */
  crystallizePlaybook(input: { situation: string; title: string; steps: string[]; pitfalls?: string[] }): string;
  /** Load playbooks matching a situation (E1). */
  loadPlaybooks(situation: string): string;
  /** Record an anti-pattern (E2). */
  recordFailure(input: { signature: string; whatNotToDo: string; whatWorkedInstead: string }): string;
}

export interface ToolInvocationResult {
  ok: boolean;
  tool: string;
  output: string;
  error?: string;
  blocked?: boolean;
  blockReason?: string;
}

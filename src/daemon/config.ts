/**
 * Daemon configuration, sourced exclusively from environment variables.
 * HARD SECURITY RULE 1: provider keys live here (in the daemon), never in the
 * renderer. The renderer receives only derived, non-secret state.
 */

export interface DaemonConfig {
  localOnly: boolean;
  ledgerPath: string;
  maxSpendPerCallUsd: number;
  approvalTimeoutMs: number;
  ollamaUrl: string;
  ollamaModel: string;
  openaiCompatUrl: string;
  openaiCompatApiKey: string;
  openaiCompatModel: string;
  anthropicApiKey: string;
  anthropicModel: string;
  anthropicInputPrice: number;
  anthropicOutputPrice: number;
  baselineInputPrice: number;
  baselineOutputPrice: number;
  // --- v2 ---
  sessionsDir: string;
  a2aMode: 'file' | 'ws' | 'off';
  a2aDir: string;
  a2aWsPort: number;
  a2aAllowlist: string[];
  mcpConfigPath: string;
  checkpointsDir: string;
  hooksPath: string;
  searchApiUrl: string;
  searchApiKey: string;
  // --- v3: Context Economy + agent's own asks ---
  contextStoreDir: string;
  scratchpadPath: string;
  playbooksPath: string;
  failuresPath: string;
  limitsPath: string;
  hotTurnBudgetTokens: number;
  // --- v3b: Trust layer ---
  keysDir: string;
  checkpointsLedgerPath: string;
  delegationsPath: string;
  // --- v3c: Proof layer ---
  confidenceThreshold: number;
}

function num(value: string | undefined, fallback: number): number {
  if (value === undefined || value.trim() === '') return fallback;
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function bool(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined) return fallback;
  return /^(1|true|yes|on)$/i.test(value.trim());
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): DaemonConfig {
  return {
    localOnly: bool(env.SELFCONNECT_LOCAL_ONLY, true),
    ledgerPath: env.SELFCONNECT_LEDGER_PATH || './data/selfconnect-ledger.jsonl',
    maxSpendPerCallUsd: num(env.SELFCONNECT_MAX_SPEND_PER_CALL, 0.25),
    approvalTimeoutMs: num(env.SELFCONNECT_APPROVAL_TIMEOUT_MS, 120000),
    ollamaUrl: env.OLLAMA_URL || 'http://localhost:11434',
    ollamaModel: env.OLLAMA_MODEL || 'gemma3',
    openaiCompatUrl: env.OPENAI_COMPAT_URL || '',
    openaiCompatApiKey: env.OPENAI_COMPAT_API_KEY || '',
    openaiCompatModel: env.OPENAI_COMPAT_MODEL || '',
    anthropicApiKey: env.ANTHROPIC_API_KEY || '',
    anthropicModel: env.ANTHROPIC_MODEL || 'claude-sonnet-4-5',
    anthropicInputPrice: num(env.ANTHROPIC_INPUT_PRICE, 0),
    anthropicOutputPrice: num(env.ANTHROPIC_OUTPUT_PRICE, 0),
    baselineInputPrice: num(env.COST_BASELINE_INPUT_PRICE, 3),
    baselineOutputPrice: num(env.COST_BASELINE_OUTPUT_PRICE, 15),
    sessionsDir: env.SELFCONNECT_SESSIONS_DIR || './data/sessions',
    a2aMode: a2aMode(env.SELFCONNECT_A2A_MODE),
    a2aDir: env.SELFCONNECT_A2A_DIR || './data/a2a',
    a2aWsPort: num(env.SELFCONNECT_A2A_WS_PORT, 8787),
    a2aAllowlist: (env.SELFCONNECT_A2A_ALLOWLIST || '')
      .split(',')
      .map((s) => s.trim())
      .filter((s) => s.length > 0),
    mcpConfigPath: env.SELFCONNECT_MCP_CONFIG || './mcp-servers.json',
    checkpointsDir: env.SELFCONNECT_CHECKPOINTS_DIR || './data/checkpoints',
    hooksPath: env.SELFCONNECT_HOOKS_CONFIG || './hooks.json',
    searchApiUrl: env.SEARCH_API_URL || '',
    searchApiKey: env.SEARCH_API_KEY || '',
    contextStoreDir: env.SELFCONNECT_CONTEXT_STORE_DIR || './data/context-store',
    scratchpadPath: env.SELFCONNECT_SCRATCHPAD_PATH || './data/scratchpad.json',
    playbooksPath: env.SELFCONNECT_PLAYBOOKS_PATH || './data/playbooks.jsonl',
    failuresPath: env.SELFCONNECT_FAILURES_PATH || './data/failures.jsonl',
    limitsPath: env.SELFCONNECT_LIMITS_PATH || './limits.json',
    hotTurnBudgetTokens: num(env.SELFCONNECT_HOT_TURN_BUDGET, 8000),
    keysDir: env.SELFCONNECT_KEYS_DIR || './data/keys',
    checkpointsLedgerPath: env.SELFCONNECT_CHECKPOINTS_LEDGER || './data/ledger-checkpoints.jsonl',
    delegationsPath: env.SELFCONNECT_DELEGATIONS_PATH || './data/delegations.jsonl',
    confidenceThreshold: Math.min(1, Math.max(0, num(env.SELFCONNECT_CONFIDENCE_THRESHOLD, 0.5))),
  };
}

function a2aMode(value: string | undefined): 'file' | 'ws' | 'off' {
  if (value === 'ws' || value === 'off') return value;
  return 'file';
}

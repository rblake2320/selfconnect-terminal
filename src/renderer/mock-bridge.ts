import type {
  AgentInfo,
  ApprovalRequest,
  BusEvent,
  ChainStatus,
  ContextSnapshot,
  CostEstimate,
  CostSnapshot,
  EventType,
  ProviderLiveness,
  ReviewMode,
  ReviewResult,
  RiskFinding,
  RouteDecision,
  SentinelSnapshot,
  PermissionMode,
  TodoItem,
  SessionSummary,
  A2aPeer,
  SlashResult,
  ResumeResult,
  UiState,
  SessionKnowledge,
  ContextBlobRef,
  MetabolicState,
  MeteringRecord,
  DelegationCert,
  LedgerEntry,
} from '../shared/contracts';
import type { SelfConnectApi } from './selfconnect.d';

/**
 * Browser preview mock bridge.
 *
 * When the app runs OUTSIDE Electron (no real preload), there is no
 * `window.selfconnect`. This module installs a fully simulated bridge that
 * makes the whole UI feel alive: a scripted xterm shell, streaming bus events
 * that animate all seven widgets, a delayed approval request, and a fake
 * snapshot -> redact -> route -> review flow.
 *
 * It is a pure renderer-side simulation — it never touches Node, fs, or any
 * real provider. It is only loaded when the real bridge is absent, so the
 * Electron build is unaffected.
 */

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

let evtSeq = 0;
const rid = () => `run_${(evtSeq++).toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
const SESSION_ID = `sess_preview_${Math.random().toString(36).slice(2, 10)}`;
const AGENT_SHELL = 'agent_shell_preview';
const AGENT_REVIEW = 'agent_review_preview';
const AGENT_ROUTER = 'agent_router_preview';

function fakeHash(seed: number): string {
  // Deterministic-ish 64 hex chars so the ledger tail looks real.
  let h = (seed * 2654435761) >>> 0;
  let out = '';
  while (out.length < 64) {
    h = (h * 1664525 + 1013904223) >>> 0;
    out += h.toString(16).padStart(8, '0');
  }
  return out.slice(0, 64);
}

const CRITICAL_FINDING: RiskFinding = {
  command: 'rm -rf /',
  severity: 'critical',
  reason: 'Recursive force delete targeting root, home, or cwd',
  pattern: 'rm\\s+-rf',
};

// ---------------------------------------------------------------------------
// Mutable simulation state
// ---------------------------------------------------------------------------

interface SimState {
  localOnly: boolean;
  ledgerEntries: number;
  ledgerOk: boolean;
  sessionSpendUsd: number;
  avoidedSpendUsd: number;
  lastCost: CostEstimate | null;
  usedTokens: number;
  maxTokens: number;
  redactionCount: number;
  findings: RiskFinding[];
  agents: AgentInfo[];
  approvals: ApprovalRequest[];
  liveness: ProviderLiveness[];
  permissionMode: PermissionMode;
  todos: TodoItem[];
  sessions: SessionSummary[];
  peers: A2aPeer[];
  // --- v3: Context Economy ---
  hotTokens: number;
  warmTokens: number;
  pinnedTokens: number;
  dedupHits: number;
  compactions: number;
  tokensNotResent: number;
  cacheSavingsUsd: number;
  distillationSavingsUsd: number;
  freshInputTokens: number;
  totalInputTokens: number;
  knowledge: SessionKnowledge;
  pinned: ContextBlobRef[];
  metering: MeteringRecord[];
  grants: DelegationCert[];
  checkpoints: number;
  startedAtMs: number;
}

const sim: SimState = {
  localOnly: true,
  ledgerEntries: 1,
  ledgerOk: true,
  sessionSpendUsd: 0,
  avoidedSpendUsd: 0,
  lastCost: null,
  usedTokens: 1800,
  maxTokens: 200_000,
  redactionCount: 0,
  findings: [],
  agents: [
    { agentId: AGENT_SHELL, role: 'shell', state: 'running', runId: rid(), readOnly: false },
    { agentId: AGENT_REVIEW, role: 'review', state: 'idle', runId: null, readOnly: true },
    { agentId: AGENT_ROUTER, role: 'router', state: 'idle', runId: null, readOnly: true },
  ],
  approvals: [],
  liveness: [
    { kind: 'ollama', alive: true, detail: 'ollama reachable · gemma3' },
    { kind: 'openai-compatible', alive: false, detail: 'not configured' },
    { kind: 'anthropic', alive: false, detail: 'no API key (preview)' },
  ],
  permissionMode: 'auto',
  todos: [
    { id: 'todo_1', content: 'Wire up SessionsPanel', status: 'completed' },
    { id: 'todo_2', content: 'Demo A2A peers', status: 'in_progress' },
    { id: 'todo_3', content: 'Verify ledger chain', status: 'pending' },
  ],
  sessions: [
    {
      sessionId: 'sess_preview_yesterday',
      startedAt: Date.now() - 86_400_000,
      lastActiveAt: Date.now() - 82_800_000,
      eventCount: 142,
      sessionSpendUsd: 0.0123,
      chainOk: true,
    },
    {
      sessionId: 'sess_preview_earlier',
      startedAt: Date.now() - 43_200_000,
      lastActiveAt: Date.now() - 39_600_000,
      eventCount: 58,
      sessionSpendUsd: 0,
      chainOk: true,
    },
  ],
  peers: [
    { peer: 'researcher', lastSeenAt: Date.now() - 5_000, sent: 3, received: 4, chainOk: true, allowlisted: true },
    { peer: 'planner', lastSeenAt: Date.now() - 12_000, sent: 1, received: 1, chainOk: true, allowlisted: true },
  ],
  hotTokens: 1800,
  warmTokens: 0,
  pinnedTokens: 0,
  dedupHits: 0,
  compactions: 0,
  tokensNotResent: 0,
  cacheSavingsUsd: 0,
  distillationSavingsUsd: 0,
  freshInputTokens: 1800,
  totalInputTokens: 1800,
  knowledge: {
    decisions: ['Routed all distillation to the local Ollama model ($0)'],
    facts: ['Ledger hash-chain verified intact at boot'],
    fileStates: { 'src/daemon/daemon.ts': 'Context Economy engine wired (v3)' },
    openQuestions: [],
    todos: ['Demo A2A peers'],
    namedEntities: ['gemma3', 'claude-sonnet-4-5'],
    sourceBlobs: [],
    updatedAt: Date.now(),
  },
  pinned: [],
  metering: [
    { agentId: AGENT_SHELL, toolCalls: 7, spendUsd: 0, inputTokens: 4200, outputTokens: 1800, updatedAt: Date.now() - 3_000 },
    { agentId: AGENT_REVIEW, toolCalls: 2, spendUsd: 0, inputTokens: 900, outputTokens: 300, updatedAt: Date.now() - 8_000 },
  ],
  grants: [
    {
      hash: 'a'.repeat(64),
      issuer: 'human',
      grantee: 'agent_system_preview',
      scope: { tools: ['*'], dataClasses: ['public', 'internal', 'secret', 'cui'], expiresAt: 0, spendBudgetUsd: 0 },
      parent: null,
      issuedAt: Date.now() - 90_000,
      humanApproved: true,
      signature: { signer: 'agent_system_preview', publicKeyHex: 'ab'.repeat(16), sigHex: 'cd'.repeat(32), alg: 'ed25519' },
    },
    {
      hash: 'b'.repeat(64),
      issuer: 'agent_system_preview',
      grantee: AGENT_REVIEW,
      scope: { tools: ['read_file', 'grep'], dataClasses: ['public'], expiresAt: Date.now() + 3_600_000, spendBudgetUsd: 0.05 },
      parent: 'a'.repeat(64),
      issuedAt: Date.now() - 60_000,
      humanApproved: false,
      signature: { signer: 'agent_system_preview', publicKeyHex: 'ab'.repeat(16), sigHex: 'ef'.repeat(32), alg: 'ed25519' },
    },
  ],
  checkpoints: 3,
  startedAtMs: Date.now(),
};

const busHandlers = new Set<(evt: BusEvent) => void>();
const ptyHandlers = new Set<(data: string) => void>();

function emit(type: EventType, payload: unknown, agentId = 'agent_system_preview'): void {
  if (type !== 'terminal.output') sim.ledgerEntries += 1;
  const evt: BusEvent = {
    id: `evt_${(evtSeq++).toString(36)}`,
    ts: Date.now(),
    type,
    sessionId: SESSION_ID,
    runId: rid(),
    agentId,
    payload,
  };
  for (const h of busHandlers) h(evt);
}

function writePty(data: string): void {
  for (const h of ptyHandlers) h(data);
}

// ---------------------------------------------------------------------------
// State composition (matches UiState contract exactly)
// ---------------------------------------------------------------------------

function contextSnapshot(): ContextSnapshot {
  const pressure = Math.min(100, (sim.usedTokens / sim.maxTokens) * 100);
  const level =
    pressure >= 90 ? 'migrate' : pressure >= 80 ? 'danger' : pressure >= 60 ? 'warn' : 'normal';
  return {
    usedTokens: sim.usedTokens,
    maxTokens: sim.maxTokens,
    pressure,
    level,
    hotTokens: sim.hotTokens,
    warmTokens: sim.warmTokens,
    pinnedTokens: sim.pinnedTokens,
    dedupHits: sim.dedupHits,
    compactions: sim.compactions,
  };
}

function contextEfficiencyPct(): number {
  if (sim.totalInputTokens <= 0) return 100;
  return (sim.freshInputTokens / sim.totalInputTokens) * 100;
}

function costSnapshot(): CostSnapshot {
  return {
    sessionSpendUsd: sim.sessionSpendUsd,
    avoidedSpendUsd: sim.avoidedSpendUsd,
    perCallCapUsd: 0.25,
    last: sim.lastCost,
    tokensNotResent: sim.tokensNotResent,
    cacheSavingsUsd: sim.cacheSavingsUsd,
    distillationSavingsUsd: sim.distillationSavingsUsd,
    contextEfficiencyPct: contextEfficiencyPct(),
  };
}

function metabolicSnapshot(): MetabolicState {
  const pressure = Math.min(100, (sim.usedTokens / sim.maxTokens) * 100);
  return {
    contextRemainingPct: Math.max(0, 100 - pressure),
    budgetRemainingUsd: Math.max(0, 0.25 - sim.sessionSpendUsd),
    elapsedMs: Date.now() - sim.startedAtMs,
  };
}

function sentinelSnapshot(): SentinelSnapshot {
  return {
    redactionCount: sim.redactionCount,
    riskCount: sim.findings.length,
    highCount: sim.findings.filter((f) => f.severity === 'high').length,
    criticalCount: sim.findings.filter((f) => f.severity === 'critical').length,
    findings: sim.findings.slice(-50),
  };
}

function route(): RouteDecision {
  if (sim.localOnly) {
    return {
      provider: 'ollama',
      model: 'gemma3',
      tier: 'local',
      reason: 'LOCAL_ONLY active — routed to local provider',
      requiresApproval: false,
      blocked: false,
    };
  }
  return {
    provider: 'anthropic',
    model: 'claude-sonnet-4-5',
    tier: 'cloud',
    reason: 'cloud routing enabled — requires approval',
    requiresApproval: true,
    blocked: false,
  };
}

function ledgerStatus(): ChainStatus {
  return {
    ok: sim.ledgerOk,
    entries: sim.ledgerEntries,
    lastHash: fakeHash(sim.ledgerEntries),
    brokenAt: null,
  };
}

/**
 * A scripted, chain-linked timeline for the flight-recorder replay panel.
 * Each entry mirrors the LedgerEntry contract; prevHash/hash form a fake but
 * consistent chain so the panel can scrub a realistic session.
 */
function mockReplayEvents(): LedgerEntry[] {
  const t0 = sim.startedAtMs;
  const script: { type: EventType; agentId: string; payload: unknown }[] = [
    { type: 'run.start', agentId: 'agent_system_preview', payload: { cwd: '~/workspace' } },
    { type: 'grant.root', agentId: 'human', payload: { grantee: 'agent_system_preview', humanApproved: true } },
    { type: 'terminal.input', agentId: AGENT_SHELL, payload: { line: 'npm test' } },
    { type: 'tool.call', agentId: AGENT_SHELL, payload: { tool: 'bash', command: 'npm test' } },
    { type: 'route.decision', agentId: AGENT_ROUTER, payload: { provider: 'ollama', tier: 'local' } },
    { type: 'tool.result', agentId: AGENT_SHELL, payload: { ok: true, summary: '49 passed' } },
    { type: 'risk.detected', agentId: AGENT_SHELL, payload: CRITICAL_FINDING },
    { type: 'approval.requested', agentId: AGENT_SHELL, payload: { kind: 'cloud-send' } },
    { type: 'approval.resolved', agentId: AGENT_SHELL, payload: { approved: false } },
    { type: 'delegation.issued', agentId: 'agent_system_preview', payload: { grantee: AGENT_REVIEW, tools: ['read_file', 'grep'] } },
    { type: 'checkpoint.signed', agentId: 'agent_system_preview', payload: { seq: 9, entries: 10 } },
    { type: 'run.end', agentId: 'agent_system_preview', payload: { ok: true } },
  ];
  let prevHash = '0'.repeat(64);
  return script.map((s, i) => {
    const hash = fakeHash(i + 1);
    const entry: LedgerEntry = {
      seq: i,
      ts: t0 + i * 1200,
      type: s.type,
      sessionId: SESSION_ID,
      runId: rid(),
      agentId: s.agentId,
      payload: s.payload,
      prevHash,
      hash,
    };
    prevHash = hash;
    return entry;
  });
}

function snapshot(): UiState {
  return {
    identity: { sessionId: SESSION_ID, runId: rid(), agentId: 'agent_system_preview' },
    cost: costSnapshot(),
    context: contextSnapshot(),
    route: route(),
    liveness: sim.liveness,
    localOnly: sim.localOnly,
    sentinel: sentinelSnapshot(),
    agents: sim.agents,
    approvals: sim.approvals,
    ledger: ledgerStatus(),
    permissionMode: sim.permissionMode,
    todos: sim.todos,
    sessions: sim.sessions,
    peers: sim.peers,
    knowledge: sim.knowledge,
    metabolic: metabolicSnapshot(),
    pinned: sim.pinned,
    metering: sim.metering,
    grants: sim.grants,
    checkpoints: sim.checkpoints,
  };
}

// ---------------------------------------------------------------------------
// Simulated shell
// ---------------------------------------------------------------------------

const PROMPT = '\x1b[36mselfconnect\x1b[0m:\x1b[34m~/workspace\x1b[0m$ ';
let lineBuffer = '';

function banner(): void {
  const lines = [
    '',
    '\x1b[1;36m  ╔══════════════════════════════════════════════════════╗\x1b[0m',
    '\x1b[1;36m  ║   SelfConnect Terminal — BROWSER PREVIEW (simulated) ║\x1b[0m',
    '\x1b[1;36m  ╚══════════════════════════════════════════════════════╝\x1b[0m',
    '',
    '  \x1b[2mGoverned agent execution surface. This is a static preview:\x1b[0m',
    '  \x1b[2mthe shell + widgets are simulated (no real PTY / providers).\x1b[0m',
    '',
    '  Try shell: \x1b[33mls\x1b[0m, \x1b[33mgit status\x1b[0m, \x1b[33mnpm test\x1b[0m, \x1b[33mclear\x1b[0m',
    '  Try \x1b[1;33mv2 slash commands\x1b[0m (never reach the shell):',
    '    \x1b[33m/help\x1b[0m \x1b[33m/sessions\x1b[0m \x1b[33m/resume <id>\x1b[0m \x1b[33m/cost\x1b[0m \x1b[33m/verify\x1b[0m',
    '    \x1b[33m/mcp list\x1b[0m \x1b[33m/a2a peers\x1b[0m \x1b[33m/tools\x1b[0m \x1b[33m/todo list\x1b[0m \x1b[33m/agent-mode plan\x1b[0m',
    '  Click the \x1b[35mSC\x1b[0m mascot (bottom-right) to run a review.',
    '',
  ];
  writePty(lines.join('\r\n') + '\r\n');
  writePty(PROMPT);
}

function runCommand(cmd: string): void {
  const trimmed = cmd.trim();
  const [base] = trimmed.split(/\s+/);

  // Surface risky commands through the Security Sentinel, just like the daemon.
  if (/\brm\s+-[a-z]*r[a-z]*f|\brm\s+-[a-z]*f[a-z]*r/.test(trimmed) && /\s\/(\s|$)/.test(trimmed + ' ')) {
    sim.findings.push(CRITICAL_FINDING);
    emit('risk.detected', CRITICAL_FINDING);
  }

  const out: string[] = [];
  switch (base) {
    case '':
      break;
    case 'help':
      out.push(
        'Simulated commands:',
        '  ls            list demo files',
        '  cd <dir>      change directory (cosmetic)',
        '  git status    show a demo working tree',
        '  npm test      run the (simulated) Vitest suite',
        '  clear         clear the screen',
        '  whoami        print the session identity',
        '  echo <text>   echo text back',
      );
      break;
    case 'ls':
      out.push(
        '\x1b[34melectron\x1b[0m   \x1b[34msrc\x1b[0m       \x1b[34mtests\x1b[0m     \x1b[34mscripts\x1b[0m',
        'package.json   README.md   vite.config.ts   electron-builder.yml',
      );
      break;
    case 'cd':
      // cosmetic only
      break;
    case 'pwd':
      out.push('/home/user/workspace/selfconnect-terminal');
      break;
    case 'whoami':
      out.push(`session ${SESSION_ID}`, `agent ${AGENT_SHELL} (shell, read-write)`);
      break;
    case 'echo':
      out.push(trimmed.slice(4).trim());
      break;
    case 'git':
      if (trimmed.includes('status')) {
        out.push(
          'On branch \x1b[32mmain\x1b[0m',
          'Changes not staged for commit:',
          '  \x1b[31mmodified:   src/renderer/App.tsx\x1b[0m',
          '  \x1b[31mmodified:   src/daemon/daemon.ts\x1b[0m',
          'Untracked files:',
          '  \x1b[31msrc/renderer/mock-bridge.ts\x1b[0m',
        );
      } else if (trimmed.includes('log')) {
        out.push(
          '\x1b[33mc0ffee0\x1b[0m feat: hash-chained audit ledger',
          '\x1b[33mdeadbee\x1b[0m feat: seven live widgets + approvals',
        );
      } else {
        out.push(`git: '${trimmed.slice(4)}' simulated — try 'git status'.`);
      }
      break;
    case 'npm':
      if (trimmed.includes('test')) {
        out.push(
          '\x1b[2m> vitest run\x1b[0m',
          ' \x1b[32m✓\x1b[0m tests/redactor.test.ts (6)',
          ' \x1b[32m✓\x1b[0m tests/ledger.test.ts (5)',
          ' \x1b[32m✓\x1b[0m tests/router.test.ts (5)',
          ' \x1b[32m✓\x1b[0m tests/cost-kernel.test.ts (6)',
          ' \x1b[32m✓\x1b[0m tests/policy.test.ts (7)',
          ' \x1b[32m✓\x1b[0m tests/command-risk.test.ts (9)',
          ' \x1b[32m✓\x1b[0m tests/approvals.test.ts (6)',
          ' \x1b[32m✓\x1b[0m tests/schema.test.ts (5)',
          '',
          ' \x1b[32mTest Files  8 passed (8)\x1b[0m',
          ' \x1b[32m     Tests  49 passed (49)\x1b[0m',
        );
      } else {
        out.push(`npm: '${trimmed.slice(4)}' simulated — try 'npm test'.`);
      }
      break;
    case 'clear':
      writePty('\x1b[2J\x1b[3J\x1b[H');
      writePty(PROMPT);
      return;
    default:
      out.push(`\x1b[31m${base}: command not found\x1b[0m (simulated shell — try 'help')`);
  }

  if (out.length) writePty(out.join('\r\n') + '\r\n');
  writePty(PROMPT);

  if (trimmed) {
    sim.usedTokens += 120 + Math.floor(Math.random() * 200);
    emit('terminal.input', { line: trimmed }, AGENT_SHELL);
  }
}

// ---------------------------------------------------------------------------
// Simulated slash-command dispatch (mirrors the daemon's slash router output).
// ---------------------------------------------------------------------------

const SLASH_HELP = [
  'SelfConnect slash commands:',
  '  /help                 list all slash commands',
  '  /sessions             list resumable sessions',
  '  /resume <sessionId>   resume a past session',
  '  /review <mode>        run the review agent',
  '  /verify               verify the audit ledger hash chain',
  '  /cost                 show cost + savings',
  '  /agents               show the agent mesh',
  '  /mcp list             list MCP servers',
  '  /a2a peers            list A2A peers',
  '  /tools                list governed tools',
  '  /todo list            manage the todo list',
  '  /agent-mode <mode>    set permission mode (plan|ask|auto)',
  '  /context              show context economy breakdown (hot/warm/pinned/dedup)',
  '  /compact              force context compaction (hot -> warm)',
  '  /knowledge            show distilled session knowledge (WARM tier)',
  '  /playbooks <sit>      load matching playbooks',
  '  /limits               what this harness/model cannot do',
  '  /delegate <agent>     issue a scoped, signed delegation grant',
  '  /grants               list delegation grants + chain status',
  '  /passport             export a signed Merkle work-history passport',
  '  /replay               flight-recorder timeline of this session',
  '  /clear                clear the terminal view',
].join('\n');

const MOCK_TOOLS = [
  'read', 'write', 'edit', 'glob', 'grep', 'bash', 'web_fetch', 'web_search',
  'task', 'todo', 'apply_patch', 'ask_user', 'ledger_verify', 'ledger_query',
  'cost_report', 'redact_text', 'review_request', 'a2a_send', 'mcp_call',
  'session_list', 'memory_read', 'memory_write', 'context_request',
  'scratchpad_write', 'scratchpad_read', 'introspect', 'metabolic', 'limits',
  'crystallize_playbook', 'load_playbooks', 'record_failure',
  'delegate_grant', 'grants_list', 'passport_export', 'evidence_export',
];

const MOCK_PLAYBOOKS: { situation: string; title: string; steps: string[] }[] = [
  {
    situation: 'typecheck fails after schema change',
    title: 'Propagate Zod schema fields to all literals',
    steps: [
      'Add the field to the schema with a sane .default()',
      'Update every hand-built object literal (z.infer keeps defaulted fields required)',
      'Re-run tsc -p each tsconfig until clean',
    ],
  },
];

const MOCK_FAILURES: { signature: string; whatNotToDo: string; whatWorkedInstead: string }[] = [
  {
    signature: 'distillation needs network',
    whatNotToDo: 'Assume Ollama is always reachable before distilling a turn',
    whatWorkedInstead: 'Fall back to the deterministic $0 heuristic extractor',
  },
];

const LIMITS_CANNOT = [
  'open a GUI window or use a display server',
  'use a GPU for inference',
  'make cloud calls while LOCAL_ONLY is ON',
  'run bash that mutates state without an approval in ask mode',
  'read provider API keys (they live only in the daemon)',
  'persist files outside the ./data directory',
];

function mockSlash(line: string): SlashResult {
  const trimmed = line.trim().replace(/^\//, '');
  const [name, ...args] = trimmed.split(/\s+/);
  const rest = args.join(' ');
  emit('command.slash', { command: name || 'help', ok: true }, AGENT_SHELL);

  switch ((name || 'help').toLowerCase()) {
    case 'help':
    case '':
      return { ok: true, output: SLASH_HELP };
    case 'sessions':
      return {
        ok: true,
        output: [
          'Sessions (newest first):',
          ...sim.sessions.map(
            (s) => `  ${s.sessionId}  events=${s.eventCount}  spend=$${s.sessionSpendUsd.toFixed(4)}  chain=OK`,
          ),
        ].join('\n'),
      };
    case 'resume': {
      const sess = sim.sessions.find((s) => s.sessionId === rest);
      if (!sess) return { ok: false, output: `resume failed: no snapshot for ${rest}` };
      emit('session.resumed', { sessionId: rest, replayed: sess.eventCount });
      return {
        ok: true,
        output: `resumed session ${rest}`,
        scrollback: [
          `\x1b[2m── resumed ${rest} (${sess.eventCount} events replayed) ──\x1b[0m`,
          ' \x1b[32mTest Files  8 passed (8)\x1b[0m',
        ],
      };
    }
    case 'verify': {
      emit('ledger.verify', ledgerStatus());
      return { ok: true, output: `ledger: INTACT  entries=${sim.ledgerEntries}  head=${fakeHash(sim.ledgerEntries).slice(0, 16)}` };
    }
    case 'cost':
      return {
        ok: true,
        output: `spend=$${sim.sessionSpendUsd.toFixed(4)}  avoided=$${sim.avoidedSpendUsd.toFixed(4)}  cap=$0.25/call`,
      };
    case 'agents':
      return {
        ok: true,
        output: ['Agent mesh:', ...sim.agents.map((a) => `  ${a.agentId}  role=${a.role}  state=${a.state}`)].join('\n'),
      };
    case 'mcp': {
      const sub = (args[0] || 'list').toLowerCase();
      if (sub === 'call') {
        emit('mcp.call', { server: args[1] || 'selfconnect', tool: args[2] || 'ledger_verify' });
        emit('mcp.result', { server: args[1] || 'selfconnect', tool: args[2] || 'ledger_verify', redactions: 0 });
        return { ok: true, output: `{"ok":true,"entries":${sim.ledgerEntries}}` };
      }
      return { ok: true, output: 'MCP servers: filesystem, selfconnect' };
    }
    case 'a2a': {
      const sub = (args[0] || 'peers').toLowerCase();
      if (sub === 'send') {
        emit('a2a.sent', { peer: args[1] || 'researcher', kind: 'msg', id: rid(), redactions: 1 });
        return { ok: true, output: `sent msg to ${args[1] || 'researcher'} (1 redaction(s))` };
      }
      return {
        ok: true,
        output: [
          'A2A peers:',
          ...sim.peers.map(
            (p) => `  ${p.peer}  sent=${p.sent}  recv=${p.received}  chain=OK  ${p.allowlisted ? 'allowlisted' : 'untrusted'}`,
          ),
        ].join('\n'),
      };
    }
    case 'tools':
      return {
        ok: true,
        output: [`Governed tools (${MOCK_TOOLS.length}):`, ...MOCK_TOOLS.map((t) => `  ${t}`)].join('\n'),
      };
    case 'todo':
      return {
        ok: true,
        output: sim.todos
          .map((t, i) => `  ${i + 1}. ${t.status === 'completed' ? '[x]' : t.status === 'in_progress' ? '[~]' : '[ ]'} ${t.content}`)
          .join('\n'),
      };
    case 'agent-mode': {
      const mode = (args[0] || '').toLowerCase();
      if (['plan', 'ask', 'auto'].includes(mode)) {
        sim.permissionMode = mode as PermissionMode;
        emit('permission.mode', { mode });
        return { ok: true, output: `permission mode set to ${mode}` };
      }
      return { ok: true, output: `permission mode is ${sim.permissionMode}` };
    }
    case 'context': {
      const c = contextSnapshot();
      const cost = costSnapshot();
      return {
        ok: true,
        output: [
          `Context economy (${c.pressure.toFixed(1)}% / ${c.level}):`,
          `  hot=${c.hotTokens}  warm=${c.warmTokens}  pinned=${c.pinnedTokens}  total=${c.usedTokens}/${c.maxTokens}`,
          `  dedup hits=${c.dedupHits}  compactions=${c.compactions}`,
          `  tokens NOT resent=${cost.tokensNotResent}  cache savings=$${cost.cacheSavingsUsd.toFixed(4)}  distill savings=$${cost.distillationSavingsUsd.toFixed(4)}`,
          `  Context Efficiency=${cost.contextEfficiencyPct.toFixed(1)}%`,
        ].join('\n'),
      };
    }
    case 'compact': {
      const moved = Math.max(0, sim.hotTokens - 1200);
      const warmAdded = Math.round(moved * 0.15);
      sim.hotTokens -= moved;
      sim.warmTokens += warmAdded;
      sim.usedTokens = sim.hotTokens + sim.warmTokens + sim.pinnedTokens;
      sim.compactions += 1;
      sim.tokensNotResent += moved - warmAdded;
      sim.distillationSavingsUsd += ((moved - warmAdded) / 1_000_000) * 3;
      emit('context.compacted', { movedTokens: moved, warmAdded, reason: 'manual /compact' });
      emit('context.update', contextSnapshot());
      emit('cost.update', costSnapshot());
      return {
        ok: true,
        output: `compacted hot -> warm: moved ${moved} tokens (kept ${warmAdded} distilled), ${moved - warmAdded} tokens will not be resent`,
      };
    }
    case 'pin': {
      if (!rest) return { ok: false, output: 'usage: /pin <hash>' };
      return { ok: true, output: `pinned ${rest} (survives migration)` };
    }
    case 'unpin': {
      if (!rest) return { ok: false, output: 'usage: /unpin <hash>' };
      return { ok: true, output: `unpinned ${rest}` };
    }
    case 'knowledge': {
      const k = sim.knowledge;
      return {
        ok: true,
        output: [
          'Session knowledge (WARM):',
          `  decisions: ${k.decisions.length}  facts: ${k.facts.length}  files: ${Object.keys(k.fileStates).length}`,
          `  open questions: ${k.openQuestions.length}  todos: ${k.todos.length}  entities: ${k.namedEntities.length}`,
        ].join('\n'),
      };
    }
    case 'playbooks': {
      if (!rest) return { ok: false, output: 'usage: /playbooks <situation>' };
      emit('playbook.loaded', { situation: rest, matched: MOCK_PLAYBOOKS.length });
      const rows = MOCK_PLAYBOOKS.flatMap((p) => [
        `  ▸ ${p.title}`,
        ...p.steps.map((s) => `      - ${s}`),
      ]);
      const warn = MOCK_FAILURES[0];
      return {
        ok: true,
        output: [
          `Playbooks matching "${rest}":`,
          ...rows,
          `⚠ seen before: ${warn.whatNotToDo} — instead: ${warn.whatWorkedInstead}`,
        ].join('\n'),
      };
    }
    case 'limits':
      return { ok: true, output: ['This harness/model CANNOT:', ...LIMITS_CANNOT.map((l) => `  - ${l}`)].join('\n') };
    case 'delegate': {
      const grantee = args[0] || 'agent_worker';
      emit('delegation.issued', { issuer: 'agent_system_preview', grantee, hash: fakeHash(sim.ledgerEntries) });
      sim.grants.push({
        hash: fakeHash(sim.ledgerEntries),
        issuer: 'agent_system_preview',
        grantee,
        scope: { tools: ['read_file', 'grep'], dataClasses: ['public'], expiresAt: Date.now() + 3_600_000, spendBudgetUsd: 0.05 },
        parent: 'a'.repeat(64),
        issuedAt: Date.now(),
        humanApproved: false,
        signature: { signer: 'agent_system_preview', publicKeyHex: 'ab'.repeat(16), sigHex: 'ef'.repeat(32), alg: 'ed25519' },
      });
      return { ok: true, output: `delegated to ${grantee}: tools=[read_file,grep] budget=$0.05 ttl=1h\n  chain → human root: VERIFIED` };
    }
    case 'grants':
      return {
        ok: true,
        output: [
          'Delegation grants:',
          ...sim.grants.map(
            (g) => `  ${g.hash.slice(0, 12)}  ${g.issuer} → ${g.grantee}  tools=[${g.scope.tools.join(',')}]  ${g.parent === null ? '(human root)' : 'VERIFIED'}`,
          ),
        ].join('\n'),
      };
    case 'passport': {
      emit('checkpoint.signed', { seq: sim.ledgerEntries, entries: sim.ledgerEntries + 1 });
      emit('passport.exported', { agentId: 'agent_system_preview', leafCount: sim.ledgerEntries, root: fakeHash(sim.ledgerEntries) });
      return {
        ok: true,
        output: [
          'Agent passport (signed, Merkle-rooted):',
          `  agent=agent_system_preview  events=${sim.ledgerEntries}  toolCalls=12  spend=$${sim.sessionSpendUsd.toFixed(4)}`,
          `  riskFindings=1  approvals: 1 requested / 1 resolved`,
          `  merkleRoot=${fakeHash(sim.ledgerEntries).slice(0, 24)}…`,
          '  signature: VALID — third-party verifiable via `selfconnect passport verify`',
        ].join('\n'),
      };
    }
    case 'replay': {
      emit('replay.exported', { sessionId: SESSION_ID, events: sim.ledgerEntries });
      return {
        ok: true,
        output: [
          `Flight recorder: ${sim.ledgerEntries} events in ${SESSION_ID}`,
          '  open the Flight Recorder panel to scrub the timeline,',
          '  or export a signed .screplay via `selfconnect replay export`.',
        ].join('\n'),
      };
    }
    case 'clear':
      return { ok: true, output: '', clear: true };
    default:
      return { ok: false, output: `unknown command: /${name}\n  run /help for the list of commands` };
  }
}

function handlePtyInput(data: string): void {
  for (const ch of data) {
    if (ch === '\r' || ch === '\n') {
      writePty('\r\n');
      const cmd = lineBuffer;
      lineBuffer = '';
      runCommand(cmd);
    } else if (ch === '\x7f' || ch === '\b') {
      if (lineBuffer.length > 0) {
        lineBuffer = lineBuffer.slice(0, -1);
        writePty('\b \b');
      }
    } else if (ch >= ' ') {
      lineBuffer += ch;
      writePty(ch); // local echo
    }
  }
}

// ---------------------------------------------------------------------------
// Streaming demo: animate every widget over time
// ---------------------------------------------------------------------------

function startStreaming(): void {
  // Context pressure climbs through normal -> warn -> danger; at danger the
  // gauge actuates an auto-compaction (hot -> warm), then the demo loops.
  setInterval(() => {
    const grew = 2600 + Math.floor(Math.random() * 1800);
    sim.hotTokens += grew;
    sim.freshInputTokens += grew;
    sim.totalInputTokens += grew;
    sim.usedTokens = sim.hotTokens + sim.warmTokens + sim.pinnedTokens;

    // Roughly 1 in 3 turns re-references an already-seen blob: dedup it.
    if (Math.random() < 0.33) {
      const saved = 600 + Math.floor(Math.random() * 1400);
      sim.dedupHits += 1;
      sim.tokensNotResent += saved;
      sim.cacheSavingsUsd += (saved / 1_000_000) * 3;
      sim.totalInputTokens += saved; // counted as total, but not fresh
      emit('context.dedup', { hash: fakeHash(sim.dedupHits).slice(0, 16), tokensSaved: saved });
      emit('cost.update', costSnapshot());
    }

    const pressure = (sim.usedTokens / sim.maxTokens) * 100;
    if (pressure >= 80) {
      // Auto-compact oldest hot -> warm (15% distilled retention).
      const moved = Math.max(0, sim.hotTokens - 1200);
      const warmAdded = Math.round(moved * 0.15);
      sim.hotTokens -= moved;
      sim.warmTokens += warmAdded;
      sim.compactions += 1;
      sim.tokensNotResent += moved - warmAdded;
      sim.distillationSavingsUsd += ((moved - warmAdded) / 1_000_000) * 3;
      sim.usedTokens = sim.hotTokens + sim.warmTokens + sim.pinnedTokens;
      sim.knowledge = { ...sim.knowledge, updatedAt: Date.now() };
      emit('context.compacted', { movedTokens: moved, warmAdded, reason: 'auto: danger threshold' });
      emit('context.distilled', { distilledTokens: warmAdded, usedModel: 'gemma3' });
      emit('cost.update', costSnapshot());
    }
    if (sim.usedTokens > sim.maxTokens * 0.97) {
      // Loop the demo from a fresh hot window.
      sim.hotTokens = 1800;
      sim.warmTokens = 0;
      sim.usedTokens = 1800;
    }
    emit('context.update', contextSnapshot());
  }, 1600);

  // Local "review-ish" calls: cost stays 0, avoided spend climbs, badges flip.
  setInterval(() => {
    const inTok = 800 + Math.floor(Math.random() * 2500);
    const outTok = 200 + Math.floor(Math.random() * 700);
    const avoided = (inTok / 1_000_000) * 3 + (outTok / 1_000_000) * 15;
    sim.avoidedSpendUsd += avoided;
    sim.lastCost = {
      kind: Math.random() > 0.5 ? 'VERIFIED' : 'ESTIMATED',
      inputTokens: inTok,
      outputTokens: outTok,
      costUsd: 0,
      avoidedUsd: avoided,
    };
    emit('cost.update', costSnapshot());
  }, 2300);

  // Redactions tick up periodically (Security Sentinel).
  setInterval(() => {
    sim.redactionCount += 1 + Math.floor(Math.random() * 2);
    emit('redaction.applied', { count: sim.redactionCount });
  }, 3100);

  // Periodic route decisions keep the Model Router + ledger lively.
  setInterval(() => emit('route.decision', route(), AGENT_ROUTER), 4200);

  // A pending cloud approval appears ~5s in so the ApprovalsPanel demo works.
  setTimeout(() => requestDemoApproval(), 5000);

  // v2: simulate live A2A traffic so the Agent Mesh peers stay lively + an MCP
  // call surfaces in the event feed.
  setInterval(() => {
    const peer = sim.peers[Math.floor(Math.random() * sim.peers.length)];
    if (!peer) return;
    if (Math.random() > 0.5) {
      peer.received += 1;
      emit('a2a.received', { from: peer.peer, kind: 'msg', id: rid() });
    } else {
      peer.sent += 1;
      emit('a2a.sent', { peer: peer.peer, kind: 'msg', id: rid(), redactions: 0 });
    }
    peer.lastSeenAt = Date.now();
  }, 5200);

  setInterval(() => {
    emit('mcp.call', { server: 'selfconnect', tool: 'ledger_verify' });
    emit('mcp.result', { server: 'selfconnect', tool: 'ledger_verify', redactions: 0 });
  }, 9000);
}

function requestDemoApproval(): void {
  const now = Date.now();
  const req: ApprovalRequest = {
    id: `appr_preview_${Math.random().toString(36).slice(2, 8)}`,
    kind: 'cloud-send',
    summary: 'Review (security) via anthropic/claude-sonnet-4-5',
    provider: 'anthropic',
    model: 'claude-sonnet-4-5',
    estimatedCostUsd: 0.0123,
    createdAt: now,
    expiresAt: now + 120_000, // 2-minute window (timeout = denied)
    status: 'pending',
  };
  sim.approvals = [req];
  const reviewAgent = sim.agents.find((a) => a.role === 'review');
  if (reviewAgent) reviewAgent.state = 'blocked-on-approval';
  emit('approval.requested', req);
}

// ---------------------------------------------------------------------------
// Review flow: snapshot -> redact -> route -> review
// ---------------------------------------------------------------------------

const REVIEW_TEXT: Record<ReviewMode, string> = {
  optimize:
    'Optimization findings:\n• App.tsx polls getState() every 1.5s AND on every bus event — debounce to avoid redundant refreshes.\n• Memoize widget props; CostKernelWidget re-renders on unrelated state changes.\n• Batch ledger appends if event volume grows.',
  bugs:
    'Potential bugs:\n• Terminal resize handler may fire before the PTY is ready on first paint.\n• Approval countdown uses client clock; clock skew could show negative seconds (clamped, OK).\n• Feed list is capped at 200 — fine, but verify keys are stable across reorders.',
  architecture:
    'Architecture review:\n• Clean trust boundary: renderer ↔ daemon via a single narrow bridge. Good.\n• Single record() choke point guarantees bus+ledger stay in lockstep.\n• Consider extracting widget state selectors to decouple polling cadence from render.',
  security:
    'Security review:\n• Redaction runs before any cloud routing — confirmed.\n• Local-only HARD-blocks cloud regardless of keys.\n• rm -rf / correctly flagged CRITICAL by the sentinel.\n• contextIsolation/sandbox on; no Node in renderer. No secrets reached this snapshot.',
  'next-steps':
    'Suggested next steps:\n1. Wire BPC/TSK adapters to a real transport.\n2. Add per-provider rate limiting in the router.\n3. Persist the context gauge across sessions.\n4. Add an export button to the Sentinel widget.',
  full:
    'Full review (security + bugs + architecture + optimization):\nThe governance model is sound — one bus, one ledger, identity on every event. Redaction and local-only enforcement are correct. Minor: debounce renderer polling, memoize widgets, and guard the first-paint resize. No secrets were present in the (redacted) snapshot.',
};

async function runReview(modeStr: string): Promise<ReviewResult> {
  const mode = modeStr as ReviewMode;
  const reviewAgent = sim.agents.find((a) => a.role === 'review');

  emit('review.start', { mode, provider: 'ollama' }, AGENT_REVIEW);
  if (reviewAgent) reviewAgent.state = 'running';

  // Simulated snapshot -> redact step.
  const redactions = 2 + Math.floor(Math.random() * 3);
  sim.redactionCount += redactions;
  emit('redaction.applied', { count: redactions }, AGENT_REVIEW);

  // Simulated routing + local "call".
  emit('route.decision', route(), AGENT_ROUTER);
  await new Promise((r) => setTimeout(r, 650));

  const inTok = 3200;
  const outTok = 540;
  const avoided = (inTok / 1_000_000) * 3 + (outTok / 1_000_000) * 15;
  const cost: CostEstimate = {
    kind: 'VERIFIED',
    inputTokens: inTok,
    outputTokens: outTok,
    costUsd: 0,
    avoidedUsd: avoided,
  };
  sim.avoidedSpendUsd += avoided;
  sim.lastCost = cost;
  sim.usedTokens += inTok + outTok;
  if (reviewAgent) reviewAgent.state = 'idle';

  emit('review.result', { mode, provider: 'ollama', costUsd: 0 }, AGENT_REVIEW);
  emit('cost.update', costSnapshot());

  return {
    mode,
    provider: 'ollama',
    model: 'gemma3',
    content: REVIEW_TEXT[mode] ?? REVIEW_TEXT.full,
    redactionCount: redactions,
    cost,
  };
}

// ---------------------------------------------------------------------------
// The mock bridge object (implements SelfConnectApi)
// ---------------------------------------------------------------------------

export function createMockBridge(): SelfConnectApi {
  return {
    ptyInput(data: string): void {
      handlePtyInput(data);
    },
    ptyResize(): void {
      /* no-op in preview */
    },
    async runReview(mode: string): Promise<ReviewResult> {
      return runReview(mode);
    },
    async decideApproval(id: string, approve: boolean): Promise<void> {
      const req = sim.approvals.find((a) => a.id === id);
      if (req) {
        req.status = approve ? 'approved' : 'denied';
        sim.approvals = sim.approvals.filter((a) => a.id !== id);
        const reviewAgent = sim.agents.find((a) => a.role === 'review');
        if (reviewAgent) reviewAgent.state = 'idle';
        emit('approval.resolved', req);
        if (approve) {
          writePty(
            `\r\n\x1b[32m[approval]\x1b[0m cloud send approved — routing to anthropic/claude-sonnet-4-5\r\n`,
          );
          writePty(PROMPT);
        }
      }
    },
    async setLocalOnly(localOnly: boolean): Promise<UiState> {
      sim.localOnly = localOnly;
      // Liveness reflects whether cloud is reachable in this mode.
      sim.liveness = sim.liveness.map((l) =>
        l.kind === 'ollama'
          ? l
          : { ...l, detail: localOnly ? 'blocked by LOCAL_ONLY' : 'configured (preview)' },
      );
      emit('route.decision', route(), AGENT_ROUTER);
      return snapshot();
    },
    async verifyLedger(): Promise<ChainStatus> {
      const status = ledgerStatus();
      emit('ledger.verify', status);
      return status;
    },
    async getState(): Promise<UiState> {
      return snapshot();
    },
    async slashRun(line: string): Promise<SlashResult> {
      return mockSlash(line);
    },
    async setPermissionMode(mode: PermissionMode): Promise<UiState> {
      sim.permissionMode = mode;
      emit('permission.mode', { mode });
      return snapshot();
    },
    async listSessions(): Promise<SessionSummary[]> {
      return sim.sessions;
    },
    async resumeSession(sessionId: string): Promise<ResumeResult> {
      const sess = sim.sessions.find((s) => s.sessionId === sessionId);
      const scrollback = sess
        ? [
            `\x1b[2m── resumed ${sessionId} (${sess.eventCount} events replayed) ──\x1b[0m`,
            'last command: npm test',
            ' \x1b[32mTest Files  8 passed (8)\x1b[0m',
            ' \x1b[32m     Tests  49 passed (49)\x1b[0m',
          ]
        : [];
      emit('session.resumed', { sessionId, replayed: sess?.eventCount ?? 0 });
      return { ok: !!sess, scrollback, reason: sess ? undefined : `no snapshot for ${sessionId}` };
    },
    async replayEvents(_sessionId?: string): Promise<LedgerEntry[]> {
      return mockReplayEvents();
    },
    onPtyData(handler: (data: string) => void): () => void {
      ptyHandlers.add(handler);
      // Print the intro banner once the terminal subscribes.
      setTimeout(() => banner(), 60);
      return () => ptyHandlers.delete(handler);
    },
    onBusEvent(handler: (evt: BusEvent) => void): () => void {
      busHandlers.add(handler);
      return () => busHandlers.delete(handler);
    },
  };
}

/**
 * Install the mock bridge if (and only if) the real Electron bridge is absent.
 * Returns true when the mock was installed (i.e. we are in browser preview).
 */
export function installMockBridgeIfNeeded(): boolean {
  if (typeof window === 'undefined') return false;
  if (window.selfconnect) return false;
  window.selfconnect = createMockBridge();
  startStreaming();
  return true;
}

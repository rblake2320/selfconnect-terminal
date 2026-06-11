import type { Daemon } from './daemon';
import type { PermissionMode, ReviewMode, SlashResult } from '../shared/contracts';
import { LabTaskSchema } from '../shared/contracts';

const REVIEW_MODES: ReviewMode[] = ['optimize', 'bugs', 'architecture', 'security', 'next-steps', 'full'];

/**
 * Daemon-side slash command interceptor. Terminal input lines starting with '/'
 * NEVER reach the PTY: they are parsed here, dispatched to daemon methods, and
 * answered with formatted text that the renderer prints into the terminal view.
 *
 * Every dispatch is audited by the daemon as a `command.slash` event (the daemon
 * records it around the call to keep this module pure/formatting-only). Unknown
 * commands return an error string plus a hint to run /help.
 */

interface CommandSpec {
  name: string;
  usage: string;
  summary: string;
}

const COMMANDS: CommandSpec[] = [
  { name: 'help', usage: '/help', summary: 'list all slash commands' },
  { name: 'sessions', usage: '/sessions', summary: 'list resumable sessions' },
  { name: 'resume', usage: '/resume <sessionId>', summary: 'resume a past session' },
  { name: 'review', usage: '/review [optimize|bugs|architecture|security|next-steps|full]', summary: 'run the review agent' },
  { name: 'local-only', usage: '/local-only [on|off]', summary: 'toggle local-only policy' },
  { name: 'verify', usage: '/verify', summary: 'verify the audit ledger hash chain' },
  { name: 'approvals', usage: '/approvals', summary: 'list pending approvals' },
  { name: 'approve', usage: '/approve <id>', summary: 'approve a pending request' },
  { name: 'deny', usage: '/deny <id>', summary: 'deny a pending request' },
  { name: 'cost', usage: '/cost', summary: 'show cost + savings' },
  { name: 'agents', usage: '/agents', summary: 'show the agent mesh' },
  { name: 'mcp', usage: '/mcp [list|tools <server>|call <server> <tool> <json>]', summary: 'MCP client' },
  { name: 'a2a', usage: '/a2a [peers|send <peer> <msg>|poll]', summary: 'agent-to-agent transport' },
  { name: 'redact-test', usage: '/redact-test <text>', summary: 'preview redaction' },
  { name: 'clear', usage: '/clear', summary: 'clear the terminal view' },
  { name: 'tools', usage: '/tools', summary: 'list governed tools' },
  { name: 'todo', usage: '/todo [list|add <text>|done <n>]', summary: 'manage the todo list' },
  { name: 'memory', usage: '/memory [show|write <text>]', summary: 'project memory (SELFCONNECT.md)' },
  { name: 'rewind', usage: '/rewind [path]', summary: 'restore last checkpoint' },
  { name: 'agent-mode', usage: '/agent-mode [plan|ask|auto]', summary: 'set permission mode' },
  { name: 'context', usage: '/context', summary: 'show context economy breakdown (hot/warm/pinned/dedup)' },
  { name: 'pin', usage: '/pin <hash>', summary: 'pin a context blob (survives migration)' },
  { name: 'unpin', usage: '/unpin <hash>', summary: 'unpin a context blob' },
  { name: 'compact', usage: '/compact', summary: 'force context compaction (hot → warm)' },
  { name: 'limits', usage: '/limits', summary: 'what this harness/model cannot do' },
  { name: 'knowledge', usage: '/knowledge', summary: 'show distilled session knowledge (WARM tier)' },
  { name: 'playbooks', usage: '/playbooks <situation>', summary: 'load matching playbooks' },
  { name: 'delegate', usage: '/delegate <grantee> [tools=a,b] [budget=0.05] [ttl=3600] [class=public,internal]', summary: 'issue a scoped delegation grant' },
  { name: 'grants', usage: '/grants [hash]', summary: 'list delegation grants (or verify one chain)' },
  { name: 'passport', usage: '/passport [verify]', summary: 'export (or verify) a signed work-history passport' },
  { name: 'lab', usage: '/lab run <task-file> [arms=a,b] | /lab report <sessionId>', summary: 'D6: evaluate a task under harness arms; score from the ledger' },
  { name: 'simulate', usage: '/simulate <tool> <json-input>', summary: 'E5: dry-run a tool — predicted effects only, nothing executes' },
  { name: 'consult', usage: '/consult <question> [budget=0.05] [provider=ollama]', summary: 'E7: a different model critiques a proposed action' },
];

function helpText(): string {
  const width = Math.max(...COMMANDS.map((c) => c.usage.length));
  const lines = COMMANDS.map((c) => `  ${c.usage.padEnd(width)}  ${c.summary}`);
  return ['SelfConnect slash commands:', ...lines].join('\n');
}

function unknown(name: string): SlashResult {
  return {
    ok: false,
    output: `unknown command: /${name}\n  run /help for the list of commands`,
  };
}

/**
 * Split a slash line into the command name and the remaining argument string.
 *
 * Only the leading command token is lowercased — that is the part matched
 * case-insensitively against the command table / subcommand names. The argument
 * remainder is returned with its ORIGINAL case intact so that case-sensitive
 * payloads (JSON values, tool names, file paths, base64, hashes) are never
 * corrupted. Splitting on the first whitespace run keeps the remainder whole, so
 * JSON containing spaces is preserved verbatim.
 */
function parse(line: string): { name: string; rest: string } {
  const trimmed = line.trim().replace(/^\//, '');
  const match = trimmed.match(/^(\S+)\s+([\s\S]*)$/);
  if (!match) return { name: trimmed.toLowerCase(), rest: '' };
  return { name: match[1].toLowerCase(), rest: match[2].trim() };
}

/**
 * Like {@link parse} but the leading token's case is PRESERVED. Used where the
 * first token is itself a case-sensitive argument (e.g. a tool name) rather than
 * a command keyword to be matched case-insensitively.
 */
function splitFirst(rest: string): { head: string; tail: string } {
  const trimmed = rest.trim();
  const match = trimmed.match(/^(\S+)\s+([\s\S]*)$/);
  if (!match) return { head: trimmed, tail: '' };
  return { head: match[1], tail: match[2].trim() };
}

/**
 * Execute a slash command against the daemon. The daemon is responsible for
 * recording the `command.slash` audit event; this returns only formatted text.
 */
export async function dispatchSlash(daemon: Daemon, line: string): Promise<SlashResult> {
  const { name, rest } = parse(line);
  switch (name) {
    case 'help':
    case '':
      return { ok: true, output: helpText() };

    case 'sessions': {
      const sessions = daemon.listSessions();
      if (sessions.length === 0) return { ok: true, output: 'no saved sessions' };
      const rows = sessions.map(
        (s) =>
          `  ${s.sessionId}  events=${s.eventCount}  spend=$${s.sessionSpendUsd.toFixed(4)}  chain=${
            s.chainOk ? 'OK' : 'BROKEN'
          }`,
      );
      return { ok: true, output: ['Sessions (newest first):', ...rows].join('\n') };
    }

    case 'resume': {
      if (!rest) return { ok: false, output: 'usage: /resume <sessionId>' };
      const res = daemon.resumeSession(rest);
      if (!res.ok) return { ok: false, output: `resume failed: ${res.reason}` };
      return {
        ok: true,
        output: `resumed session ${rest} (${res.scrollback.length} scrollback line(s))`,
        scrollback: res.scrollback,
      };
    }

    case 'review': {
      const mode = (rest || 'full') as ReviewMode;
      if (!REVIEW_MODES.includes(mode)) {
        return { ok: false, output: `usage: /review [${REVIEW_MODES.join('|')}]` };
      }
      try {
        const r = await daemon.runReview(mode);
        return { ok: true, output: `Review (${mode}) via ${r.provider}:\n${r.content}` };
      } catch (err) {
        return { ok: false, output: `review blocked: ${err instanceof Error ? err.message : String(err)}` };
      }
    }

    case 'local-only': {
      const arg = rest.toLowerCase();
      if (arg === 'on' || arg === 'off') {
        const state = daemon.setLocalOnly(arg === 'on');
        return { ok: true, output: `local-only is now ${state.localOnly ? 'ON' : 'OFF'}` };
      }
      return { ok: true, output: `local-only is ${daemon.snapshot().localOnly ? 'ON' : 'OFF'}` };
    }

    case 'verify': {
      const status = daemon.verifyLedger();
      return {
        ok: true,
        output: `ledger: ${status.ok ? 'INTACT' : 'TAMPERED'}  entries=${status.entries}  head=${status.lastHash.slice(
          0,
          16,
        )}${status.brokenAt !== null ? `  brokenAt=${status.brokenAt}` : ''}`,
      };
    }

    case 'approvals': {
      const pending = daemon.approvals.list().filter((a) => a.status === 'pending');
      if (pending.length === 0) return { ok: true, output: 'no pending approvals' };
      const rows = pending.map((a) => `  ${a.id}  ${a.kind}  ${a.summary}`);
      return { ok: true, output: ['Pending approvals:', ...rows].join('\n') };
    }

    case 'approve':
    case 'deny': {
      if (!rest) return { ok: false, output: `usage: /${name} <id>` };
      daemon.decideApproval(rest, name === 'approve');
      return { ok: true, output: `${name === 'approve' ? 'approved' : 'denied'} ${rest}` };
    }

    case 'cost': {
      const c = daemon.snapshot().cost;
      return {
        ok: true,
        output: `spend=$${c.sessionSpendUsd.toFixed(4)}  avoided=$${c.avoidedSpendUsd.toFixed(
          4,
        )}  cap=$${c.perCallCapUsd.toFixed(2)}/call`,
      };
    }

    case 'agents': {
      const agents = daemon.snapshot().agents;
      const rows = agents.map(
        (a) => `  ${a.agentId}  role=${a.role}  state=${a.state}  ${a.readOnly ? 'ro' : 'rw'}`,
      );
      return { ok: true, output: ['Agent mesh:', ...rows].join('\n') };
    }

    case 'mcp':
      return mcp(daemon, rest);

    case 'a2a':
      return a2a(daemon, rest);

    case 'redact-test': {
      if (!rest) return { ok: false, output: 'usage: /redact-test <text>' };
      const out = daemon.tools; // ensure registry exists; redaction via services
      void out;
      const redacted = daemon.redactPreview(rest);
      return { ok: true, output: redacted };
    }

    case 'clear':
      return { ok: true, output: '', clear: true };

    case 'tools': {
      const tools = daemon.tools.list();
      const width = Math.max(...tools.map((t) => t.name.length));
      const rows = tools.map(
        (t) => `  ${t.name.padEnd(width)}  ${t.readOnly ? 'ro' : 'rw'}  ${t.description}`,
      );
      return { ok: true, output: [`Governed tools (${tools.length}):`, ...rows].join('\n') };
    }

    case 'todo':
      return todo(daemon, rest);

    case 'memory': {
      const sub = parse(rest === '' ? 'show' : rest);
      if (sub.name === 'write') {
        if (!sub.rest) return { ok: false, output: 'usage: /memory write <text>' };
        daemon.memory.write(sub.rest);
        return { ok: true, output: `wrote ${sub.rest.length} bytes to ${daemon.memory.path}` };
      }
      const content = daemon.memory.read();
      return { ok: true, output: content ? content : '(SELFCONNECT.md empty)' };
    }

    case 'rewind': {
      const restored = daemon.rewind(rest || undefined);
      if (!restored) return { ok: true, output: 'no checkpoint to rewind' };
      return { ok: true, output: `rewound ${restored.filePath} (checkpoint ${restored.id})` };
    }

    case 'agent-mode': {
      const mode = rest.toLowerCase() as PermissionMode;
      if (!['plan', 'ask', 'auto'].includes(mode)) {
        return { ok: true, output: `permission mode is ${daemon.getPermissionMode()}` };
      }
      daemon.setPermissionMode(mode);
      return { ok: true, output: `permission mode set to ${mode}` };
    }

    case 'context': {
      const c = daemon.snapshot().context;
      const cost = daemon.snapshot().cost;
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

    case 'pin': {
      if (!rest) return { ok: false, output: 'usage: /pin <hash>' };
      return { ok: true, output: daemon.pinBlob(rest) };
    }

    case 'unpin': {
      if (!rest) return { ok: false, output: 'usage: /unpin <hash>' };
      return { ok: true, output: daemon.unpinBlob(rest) };
    }

    case 'compact': {
      const out = await daemon.actuateContext();
      return { ok: true, output: out };
    }

    case 'limits': {
      const l = daemon.limits;
      const rows = l.cannot.map((c) => `  - ${c}`);
      return { ok: true, output: ['This harness/model CANNOT:', ...rows].join('\n') };
    }

    case 'knowledge': {
      const k = daemon.knowledge.get();
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
      return { ok: true, output: daemon.loadPlaybooks(rest) };
    }

    case 'delegate':
      return delegate(daemon, rest);

    case 'grants':
      return grants(daemon, rest);

    case 'passport':
      return passport(daemon, rest);

    case 'lab':
      return lab(daemon, rest);

    case 'simulate':
      return simulate(daemon, rest);

    case 'consult':
      return consult(daemon, rest);

    default:
      return unknown(name);
  }
}

/**
 * D6: run a harness-lab task file. Usage: /lab run <task-file> [arms=a,b],
 * /lab report <sessionId>. `/lab demo` is intentionally NOT handled here — the
 * mock preview bridge owns the scripted demo.
 */
async function lab(daemon: Daemon, rest: string): Promise<SlashResult> {
  const { positionals, flags } = parseFlags(rest);
  const sub = (positionals[0] ?? '').toLowerCase();
  if (sub === 'run') {
    const file = positionals[1];
    if (!file) return { ok: false, output: 'usage: /lab run <task-file> [arms=a,b]' };
    let task;
    try {
      const { readFileSync } = await import('node:fs');
      task = LabTaskSchema.parse(JSON.parse(readFileSync(file, 'utf8')));
    } catch (err) {
      return { ok: false, output: `lab: cannot load task file — ${err instanceof Error ? err.message : String(err)}` };
    }
    const armNames = flags.arms ? flags.arms.split(',').map((s) => s.trim()).filter(Boolean) : undefined;
    const selected = armNames ? { ...task, arms: task.arms.filter((a) => armNames.includes(a.name)) } : task;
    if (selected.arms.length === 0) return { ok: false, output: 'lab: no arms selected' };
    const report = await daemon.runLab(selected);
    return { ok: true, output: daemon.renderLab(report) };
  }
  if (sub === 'report') {
    const sessionId = positionals[1];
    if (!sessionId) return { ok: false, output: 'usage: /lab report <sessionId>' };
    const report = daemon.reportLab(sessionId);
    return { ok: true, output: daemon.renderLab(report) };
  }
  return { ok: false, output: 'usage: /lab run <task-file> [arms=a,b] | /lab report <sessionId>' };
}

/**
 * E5: dry-run a single tool. Usage: /simulate <tool> <json-input>.
 *
 * The first token is the tool name (case preserved — tool names are matched
 * exactly). Everything after it is treated as a single raw JSON string: it is
 * NOT split on spaces, so payloads like {"path": "A B", "v": "MixedCase"} parse
 * intact with their original case.
 */
async function simulate(daemon: Daemon, rest: string): Promise<SlashResult> {
  const { head: tool, tail: args } = splitFirst(rest);
  if (!tool) return { ok: false, output: 'usage: /simulate <tool> <json-input>' };
  let input: unknown = {};
  if (args) {
    try {
      input = JSON.parse(args);
    } catch {
      return { ok: false, output: 'usage: /simulate <tool> <json-input> — <json-input> must be valid JSON' };
    }
  }
  const result = await daemon.tools.invoke(tool, input, 'tool', undefined, { simulate: true });
  if (!result.ok) return { ok: false, output: result.blockReason ?? result.error ?? 'simulate failed' };
  try {
    const preview = JSON.parse(result.output);
    const lines = [
      `dry-run: ${preview.summary}`,
      `  mutating=${preview.mutating}  files=[${(preview.filesTouched ?? []).join(', ')}]`,
    ];
    if (preview.risk) lines.push(`  risk=${preview.risk}${preview.riskReason ? ` (${preview.riskReason})` : ''}`);
    if (preview.estimatedCostUsd) lines.push(`  est. cost=$${preview.estimatedCostUsd.toFixed(4)}`);
    if (preview.diff) lines.push('  diff:', preview.diff.split('\n').map((l: string) => `    ${l}`).join('\n'));
    return { ok: true, output: lines.join('\n') };
  } catch {
    return { ok: true, output: result.output };
  }
}

/** E7: ask a different model for a second opinion. Usage: /consult <question>. */
async function consult(daemon: Daemon, rest: string): Promise<SlashResult> {
  const { positionals, flags } = parseFlags(rest);
  const question = positionals.join(' ').trim() || flags.q;
  if (!question) return { ok: false, output: 'usage: /consult <question> [budget=0.05] [provider=ollama]' };
  const budgetUsd = flags.budget !== undefined ? Number(flags.budget) : undefined;
  const provider = flags.provider as 'ollama' | 'openai-compatible' | 'anthropic' | undefined;
  const r = await daemon.consult({ question, budgetUsd, provider });
  if (!r.ok) return { ok: false, output: `consult blocked: ${r.blockReason ?? 'unknown'}` };
  return {
    ok: true,
    output: [
      `second opinion via ${r.provider}/${r.model} (confidence ${(r.confidence * 100).toFixed(0)}%, $${r.cost.costUsd.toFixed(4)}, ${r.redactionCount} redactions):`,
      r.critique,
    ].join('\n'),
  };
}

async function mcp(daemon: Daemon, rest: string): Promise<SlashResult> {
  const { name: sub, rest: args } = parse(rest === '' ? 'list' : rest);
  if (sub === 'list') {
    const servers = daemon.mcp.serverNames();
    return {
      ok: true,
      output: servers.length ? `MCP servers: ${servers.join(', ')}` : 'no MCP servers configured',
    };
  }
  if (sub === 'tools') {
    if (!args) return { ok: false, output: 'usage: /mcp tools <server>' };
    try {
      const tools = await daemon.mcp.listTools(args);
      return { ok: true, output: tools.map((t) => `  ${t.name}  ${t.description}`).join('\n') };
    } catch (err) {
      return { ok: false, output: `mcp tools error: ${err instanceof Error ? err.message : String(err)}` };
    }
  }
  if (sub === 'call') {
    const callParts = parse(args);
    const toolAndJson = parse(callParts.rest);
    const server = callParts.name;
    const tool = toolAndJson.name;
    if (!server || !tool) return { ok: false, output: 'usage: /mcp call <server> <tool> <json>' };
    let parsed: unknown = {};
    if (toolAndJson.rest) {
      try {
        parsed = JSON.parse(toolAndJson.rest);
      } catch {
        return { ok: false, output: 'mcp call: args must be valid JSON' };
      }
    }
    try {
      const result = await daemon.mcpCall(server, tool, parsed);
      return { ok: true, output: result };
    } catch (err) {
      return { ok: false, output: `mcp call error: ${err instanceof Error ? err.message : String(err)}` };
    }
  }
  return { ok: false, output: 'usage: /mcp [list|tools <server>|call <server> <tool> <json>]' };
}

async function a2a(daemon: Daemon, rest: string): Promise<SlashResult> {
  const { name: sub, rest: args } = parse(rest === '' ? 'peers' : rest);
  if (sub === 'peers') {
    const peers = daemon.a2a.peerList();
    if (peers.length === 0) return { ok: true, output: 'no A2A peers seen yet' };
    const rows = peers.map(
      (p) =>
        `  ${p.peer}  sent=${p.sent}  recv=${p.received}  chain=${p.chainOk ? 'OK' : 'BROKEN'}  ${
          p.allowlisted ? 'allowlisted' : 'untrusted'
        }`,
    );
    return { ok: true, output: ['A2A peers:', ...rows].join('\n') };
  }
  if (sub === 'send') {
    const parts = parse(args);
    if (!parts.name || !parts.rest) return { ok: false, output: 'usage: /a2a send <peer> <msg>' };
    const out = await daemon.a2aSend(parts.name, parts.rest);
    return { ok: true, output: out };
  }
  if (sub === 'poll') {
    await daemon.a2aPoll();
    return { ok: true, output: 'a2a poll complete' };
  }
  return { ok: false, output: 'usage: /a2a [peers|send <peer> <msg>|poll]' };
}

function todo(daemon: Daemon, rest: string): SlashResult {
  const { name: sub, rest: args } = parse(rest === '' ? 'list' : rest);
  if (sub === 'list') {
    const items = daemon.todos.list();
    if (items.length === 0) return { ok: true, output: 'no todos' };
    const mark = { pending: '[ ]', in_progress: '[~]', completed: '[x]' } as const;
    return {
      ok: true,
      output: items.map((t, i) => `  ${i + 1}. ${mark[t.status]} ${t.content}`).join('\n'),
    };
  }
  if (sub === 'add') {
    if (!args) return { ok: false, output: 'usage: /todo add <text>' };
    const items = daemon.todos.list().map((t) => ({ content: t.content, status: t.status }));
    items.push({ content: args, status: 'pending' });
    daemon.writeTodos(items);
    return { ok: true, output: `added todo: ${args}` };
  }
  if (sub === 'done') {
    const n = Number(args);
    const items = daemon.todos.list().map((t) => ({ content: t.content, status: t.status }));
    if (!Number.isInteger(n) || n < 1 || n > items.length) {
      return { ok: false, output: `usage: /todo done <1..${items.length}>` };
    }
    items[n - 1].status = 'completed';
    daemon.writeTodos(items);
    return { ok: true, output: `marked todo ${n} done` };
  }
  return { ok: false, output: 'usage: /todo [list|add <text>|done <n>]' };
}

const DATA_CLASSES = ['public', 'internal', 'secret', 'cui'] as const;
type DataClassName = (typeof DATA_CLASSES)[number];

/** Parse `key=value` flags out of an argument string, leaving positionals. */
function parseFlags(rest: string): { positionals: string[]; flags: Record<string, string> } {
  const tokens = rest.split(/\s+/).filter((t) => t.length > 0);
  const positionals: string[] = [];
  const flags: Record<string, string> = {};
  for (const t of tokens) {
    const eq = t.indexOf('=');
    if (eq > 0) flags[t.slice(0, eq).toLowerCase()] = t.slice(eq + 1);
    else positionals.push(t);
  }
  return { positionals, flags };
}

function delegate(daemon: Daemon, rest: string): SlashResult {
  const { positionals, flags } = parseFlags(rest);
  const grantee = positionals[0];
  if (!grantee) {
    return { ok: false, output: 'usage: /delegate <grantee> [tools=a,b] [budget=0.05] [ttl=<seconds>] [class=public,internal]' };
  }
  const tools = flags.tools ? flags.tools.split(',').map((s) => s.trim()).filter(Boolean) : undefined;
  const budget = flags.budget !== undefined ? Number(flags.budget) : undefined;
  const ttlSec = flags.ttl !== undefined ? Number(flags.ttl) : undefined;
  const dataClasses = flags.class
    ? (flags.class.split(',').map((s) => s.trim()).filter((s): s is DataClassName => (DATA_CLASSES as readonly string[]).includes(s)))
    : undefined;
  const cert = daemon.delegate({
    grantee,
    tools,
    spendBudgetUsd: budget !== undefined && Number.isFinite(budget) ? budget : undefined,
    expiresInMs: ttlSec !== undefined && Number.isFinite(ttlSec) ? ttlSec * 1000 : undefined,
    dataClasses,
  });
  const verdict = daemon.verifyGrant(cert.hash);
  return {
    ok: true,
    output: [
      `issued grant ${cert.hash.slice(0, 16)} → ${grantee}`,
      `  tools=[${cert.scope.tools.join(', ')}]  budget=$${cert.scope.spendBudgetUsd.toFixed(4)}  classes=[${cert.scope.dataClasses.join(', ')}]`,
      `  expires=${cert.scope.expiresAt ? new Date(cert.scope.expiresAt).toISOString() : 'never'}`,
      `  chain: ${verdict.ok ? 'VERIFIED to human root' : `INVALID — ${verdict.reason}`}`,
    ].join('\n'),
  };
}

function grants(daemon: Daemon, rest: string): SlashResult {
  if (rest) {
    const verdict = daemon.verifyGrant(rest);
    return {
      ok: true,
      output: verdict.ok
        ? `grant ${rest.slice(0, 16)}: VERIFIED to human root (chain length ${verdict.chain.length})`
        : `grant ${rest.slice(0, 16)}: INVALID — ${verdict.reason}`,
    };
  }
  const all = daemon.listGrants();
  if (all.length === 0) return { ok: true, output: 'no delegation grants' };
  const rows = all.map((c) => {
    const root = c.parent === null && c.issuer === 'human' ? ' [human root]' : '';
    return `  ${c.hash.slice(0, 16)}  ${c.issuer.slice(0, 18)} → ${c.grantee.slice(0, 18)}  tools=[${c.scope.tools.join(',')}]${root}`;
  });
  return { ok: true, output: ['Delegation grants:', ...rows].join('\n') };
}

function passport(daemon: Daemon, rest: string): SlashResult {
  if (rest.trim().toLowerCase() === 'verify') {
    const p = daemon.exportPassport();
    const v = daemon.verifyPassportSig(p);
    return { ok: true, output: `passport for ${p.agentId.slice(0, 18)}: signature ${v.ok ? 'VALID' : 'INVALID'} — ${v.reason}` };
  }
  const p = daemon.exportPassport();
  return {
    ok: true,
    output: [
      `Passport (signed work history) for ${p.agentId}:`,
      `  sessions=${p.summary.sessions}  toolCalls=${p.summary.toolCalls}  spend=$${p.summary.spendUsd.toFixed(4)}`,
      `  riskFindings=${p.summary.riskFindings}  approvals req/res=${p.summary.approvalsRequested}/${p.summary.approvalsResolved}`,
      `  events=${p.summary.events}  merkleRoot=${p.merkleRoot.slice(0, 16)}…  leaves=${p.leafCount}`,
      `  signature: ${p.signature.sigHex.slice(0, 16)}… (ed25519, third-party verifiable)`,
    ].join('\n'),
  };
}

/** Exposed for tests + /help generation. */
export function slashCommandNames(): string[] {
  return COMMANDS.map((c) => c.name);
}

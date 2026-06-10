import type { Daemon } from './daemon';
import type { PermissionMode, ReviewMode, SlashResult } from '../shared/contracts';

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

/** Split a slash line into the command name and the remaining argument string. */
function parse(line: string): { name: string; rest: string } {
  const trimmed = line.trim().replace(/^\//, '');
  const space = trimmed.indexOf(' ');
  if (space < 0) return { name: trimmed.toLowerCase(), rest: '' };
  return { name: trimmed.slice(0, space).toLowerCase(), rest: trimmed.slice(space + 1).trim() };
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

    default:
      return unknown(name);
  }
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

/** Exposed for tests + /help generation. */
export function slashCommandNames(): string[] {
  return COMMANDS.map((c) => c.name);
}

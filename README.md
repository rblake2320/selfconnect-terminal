# SelfConnect Terminal

A **governed agent execution surface** — not a terminal wrapper. SelfConnect
Terminal is an Electron + React + TypeScript application with a real PTY
terminal, seven live instrument widgets, daemon-owned model routing, a cost
kernel, human approval gates, secret redaction, a local-only safety mode, and a
SHA‑256 hash‑chained audit ledger with tamper detection.

> The renderer is untrusted UI. The **daemon** (Electron main process) owns shell
> access, provider keys, model calls, policy, approvals, redaction, identity, and
> audit logging. Widgets are instruments, not brains.

---

## What's new in v2

v2 turns SelfConnect from a single-window instrument panel into a full governed
agent surface — **everything new flows through the same governed path**:
identity-stamped event bus → policy engine → approvals → redaction →
hash-chained ledger. Keys stay daemon-only; the renderer stays untrusted.

- **Session persistence + resume** — daemon snapshots (cost, context, sentinel,
  todos, scrollback) are written atomically per session. Resume continues under
  the **same `sessionId` with a new `runId`**, replays the ledger, and repaints
  terminal scrollback. See the **Sessions** widget.
- **Slash commands** — a daemon-side interceptor handles `/help`, `/sessions`,
  `/resume`, `/review`, `/local-only`, `/verify`, `/approvals`, `/approve`,
  `/deny`, `/cost`, `/agents`, `/mcp`, `/a2a`, `/redact-test`, `/clear`,
  `/tools`, `/todo`, `/memory`, `/rewind`. Unknown commands return an error +
  hint. Every dispatch is audited as `command.slash` (name + ok, **never** raw
  args — which may contain secrets).
- **MCP client + server** — the daemon is an MCP **client** (stdio JSON-RPC 2.0,
  policy-gated, outbound args **always redacted**, audited as `mcp.call` /
  `mcp.result`) and can run as a read-only MCP **server**
  (`selfconnect mcp serve`): `ledger_verify`, `ledger_query`, `session_list`,
  `cost_report`, `redact_text`, `review_request`. The server **never** executes
  shell commands.
- **Headless CLI + typed SDK** — the `selfconnect` bin and `SelfConnectClient`
  drive the *same* governed daemon core headlessly. Exports map: `.` (SDK),
  `./contracts`, `./cli`.
- **Live A2A transport (BPC/TSK)** — per-peer SHA-256 hash-chained envelopes
  (`{bpc,id,from,to,ts,kind,payload,prevHash,hash}`) over a file mailbox or
  WebSocket backend (`SELFCONNECT_A2A_MODE=file|ws|off`). Outbound payloads are
  **always redacted**; sending to a non-allowlisted peer or any `handoff` kind
  requires **approval**. Inbound chain breaks raise a HIGH finding.
- **Governed Tool Layer** — a daemon-owned `ToolRegistry` with Claude Code
  parity (see the parity table below). Every invocation is identity-stamped,
  permission-gated (`plan`/`ask`/`auto`), risk-checked, hook-wrapped,
  checkpointed (for writers, enabling `/rewind`), and audited.

---

## What's new in v3 — Context Economy

v3 makes context a **governed, accounted resource**. The model is shown the
smallest correct slice of context, every byte it was (or wasn't) shown is a
ledger event, and the savings are priced against cloud baselines. As in v2,
**everything new flows through the same identity-stamped bus → ledger**, and
distillation runs on the **local** model at $0 (cloud distillation would require
approval like any cloud call; redaction runs before any warm fact can leave).

- **Content-addressed context store** — every artifact (file, scrollback, diff,
  doc) is SHA‑256 hashed into an immutable blob under `./data/context-store/`.
  The same bytes are never stored or paid for twice. A per-session
  *seen-by-model* index (keyed `provider:hash`) means once the model has seen a
  blob, later turns send a **stable ref + 3-line digest** instead of the full
  bytes — dedup that holds **across turns and across mesh agents** (A2A handoffs
  pass blob refs, not copies). Each store/dedup decision is audited
  (`context.stored`, `context.dedup`).
- **Tiered session memory (HOT / WARM / COLD)** — a HOT verbatim window of recent
  turns; a WARM `SessionKnowledge` object (decisions, facts, file states, open
  questions, todos, named entities) distilled from older turns by the **local**
  model ($0, never leaves the machine; deterministic heuristic fallback when
  Ollama is offline); and COLD = the ledger + blob store with event-id
  provenance for on-demand rehydration. Knowledge is persisted in the session
  snapshot, so **resume re-reads nothing** — it loads the distilled delta.
- **Context Gauge as actuator** — pressure maps to `normal/warn/danger/migrate`
  (60/80/90%). At **warn** it auto-compacts the oldest HOT context to WARM; at
  **danger** it compacts aggressively; at **migrate** it spawns a **successor
  run** (same `sessionId`, new `runId`, ledger-linked to its ancestor) seeded
  **only** from WARM knowledge + pinned blobs — no silent quality cliff. Every
  compaction/migration is a ledger event (`context.compacted`,
  `context.migrated`).
- **Cost Kernel v2 counters** — Tokens **NOT** resent (dedup), cache savings,
  distillation savings, and **Context Efficiency %** (useful-new-tokens /
  total-tokens). Shown live in the Cost Kernel widget.
- **Pull-based + external memory** — `context_request` pulls exactly what's
  needed from store/knowledge/ledger instead of dumping; a `scratchpad` holds
  working memory that does **not** ride in the prompt; `introspect`/`metabolic`
  let the agent feel its own history and remaining context/budget/time; a
  machine-readable `limits.json` states what the harness/model **cannot** do.
- **Cumulative cross-session memory** — **playbooks** crystallize a solved
  procedure (versioned, content-addressed, provenance-stamped) and load back by
  situation match; **failure memory** records anti-patterns
  (`signature → what not to do → what worked instead`) and surfaces a one-line
  warning when a similar situation recurs.
- **New slash commands** — `/context`, `/pin <hash>`, `/unpin <hash>`,
  `/compact`, `/knowledge`, `/playbooks <situation>`, `/limits`.

---

## What's new in v3b — Trust Layer

v3b makes **identity, authority, and provenance** cryptographic. Every agent
gets an Ed25519 keypair; every consequential record can be signed and
independently verified; and the daemon **refuses** any action whose authority
does not chain back to a human grant. As always, **everything flows through the
same identity-stamped bus → hash-chained ledger**, and **private keys never
leave the daemon** (`./data/keys/`, mode `0600`) — only raw public keys (hex)
and detached signatures (hex) ever cross a boundary. The renderer stays
untrusted.

- **Agent identity keys (B2.1)** — an Ed25519 keypair per `agentId`, minted on
  first use in the daemon keystore. Outbound A2A (BPC) envelopes are signed; a
  bad signature on receive is a `risk.detected` (high) and the envelope is
  rejected. The signature is **excluded** from the envelope hash so the chain
  and the signature are independent checks.
- **Signed ledger checkpoints (B)** — the daemon periodically seals the ledger
  head `(seq, hash, entries, ts)` with the system key, turning the SHA‑256 chain
  into a **signed** chain robust to file substitution. `selfconnect ledger
  verify` checks **both** the hash chain and every checkpoint signature.
- **Delegation certificate chains (B2.2)** — scoped capability grants
  `{grantee, tools, spend budget, expiry, data classes}` signed by the parent
  identity, chaining to a **human root grant** (created at session start,
  `humanApproved`). Scope **composes by intersection** down the chain. The Tool
  Layer and A2A path call into the daemon, which **refuses** any action that is
  missing a grant, expired, over-tools, over-budget, or over-class — recording a
  `delegation.denied` event. Surfaced as the `delegate_grant` / `grants_list`
  tools and `/delegate`, `/grants` slash commands.
- **Agent passport (B2.3)** — an exportable, signed work-history summary
  (sessions, tool calls, spend, risk findings, approval compliance) backed by a
  **Merkle hash-tree** over the covered ledger events. The root is third-party
  verifiable without revealing content, and **single leaves can be selectively
  revealed** with an inclusion proof. CLI: `selfconnect passport export|verify`.
- **Metering receipts (B2.4)** — per-agent resource accounting (tool calls,
  spend, tokens) in the Cost Kernel; A2A envelopes may carry a **signed metering
  receipt** alongside the signature.
- **Evidence bundle (B)** — `selfconnect evidence export <sessionId>` writes a
  self-contained **ZIP** (pure-Node store encoder, no dependency) with the ledger
  slice, signed checkpoints, public keys, and a verification report.
- **Flight recorder (B)** — a renderer **Replay panel** scrubs any past
  session's ledger events on a timeline (terminal lines, tool calls, approvals,
  risk, delegation, checkpoints). Export a signed `.screplay` bundle and verify
  it offline with `selfconnect replay verify <file>`.
- **New slash commands** — `/delegate <agent>`, `/grants`, `/passport`,
  `/replay`.

### IETF agent-audit-trail conformance mapping

Behind a conformance flag (`selfconnect ledger export --ietf`), each native
ledger entry maps onto a **draft-sharif-agent-audit-trail-00**-style audit
record. The native shape stays authoritative; the mapping is a non-lossy
projection that preserves hash linkage. (We implement a sensible mapping from
the draft's described structure; we do not vendor the draft text.)

| SelfConnect ledger field | IETF audit-trail field      | Notes                                        |
| ------------------------ | --------------------------- | -------------------------------------------- |
| `seq`                    | `recordId`                  | monotonic index within the trail             |
| `ts` (epoch ms)          | `time` (RFC3339)            | converted to ISO‑8601                        |
| `type`                   | `action` + `eventType`      | coarse category + preserved native type      |
| `agentId`                | `actor.id` / `actor.type`   | `human` / `system` / `agent` inferred        |
| `sessionId`, `runId`     | `context`                   | logical grouping                             |
| `payload`                | `attributes`                | redaction-safe, free-form                    |
| `hash`, `prevHash`       | `hash`, `prevHash`          | tamper-evident linkage carried through       |

Action categories: `invoke` (tool/MCP), `communicate` (A2A), `decide`
(routing/policy), `authorize` (approval/delegation/grant), `attest`
(signing/checkpoint/passport/evidence), `lifecycle` (run/agent/session),
`observe` (telemetry).

---

## What's new in v3c — Proof Layer

v3c turns the ledger into an **evidence substrate** and makes the harness reason
about its own **uncertainty before it acts**. Everything still flows through the
single identity-stamped `record()` choke point → hash-chained ledger, delegation
chains are still enforced on the new tools, and provider keys never leave the
daemon. Four capabilities:

- **Harness Lab (D6)** — the ledger doubles as an eval substrate. Run the *same*
  task under different **arms** (a named harness config: scoped toolset, context
  policy hot-window size / dedup on-off, model/provider choice, permission mode)
  and score each arm **purely from its ledger slice**: turns, total tokens,
  cache/dedup %, tool-error rate, approvals triggered, wall time, and a success
  signal (the task file declares a `verify` command whose exit code = success).
  Arms run sequentially in **isolated `runId`s within one session**, fully
  audited. Output is a side-by-side comparison table (CLI + JSON) and the
  renderer **LabPanel**.

  ```
  selfconnect lab run task.json --arms baseline,dedup        # compare two arms
  selfconnect lab run task.json --json                       # machine-readable
  selfconnect lab report <sessionId>                         # re-score a past run
  ```

  A task file is `{ name, prompt?, steps:[{tool,input}], verify?, arms:[…] }`.
  Scoring is deterministic and works offline with stub/local providers.

- **Dry-run / simulate (E5)** — every mutating tool accepts `simulate: true` and
  returns **predicted effects without executing**: a line diff preview for
  `write_file` / `edit_file` / `apply_patch`, the files touched, and a
  command-risk classification + estimated cost for `bash` / cloud tools. The
  simulate path returns *before* the plan-mode block and the approval gate, so it
  never mutates anything. Approval requests **attach the preview**, so the human
  approves **evidence, not a promise**. Slash: `/simulate <tool> …`.

- **Uncertainty channel (E6)** — a tool invocation may carry a `confidence`
  (0–1) + rationale. A pure router judges it against an env-configurable
  threshold (`SELFCONNECT_CONFIDENCE_THRESHOLD`, default `0.5`) **and** the
  action's blast radius (mutating or `risk >= high`): confident → **proceed**;
  low-confidence + high-blast-radius → **escalate** to human approval;
  low-confidence + low-blast-radius → **verify** (force a dry-run first).
  Confidence is shown as a badge in the Event Feed and recorded in the ledger
  (`confidence.reported` / `confidence.escalated`).

- **Second opinion / consult (E7)** — `consult({question, context_refs, model,
  budget})` asks a **different** provider/model to critique a proposed risky
  action before execution. It is **redacted** on the way out *and* back in,
  **budgeted** via the Cost Kernel (refused if the estimate exceeds the budget),
  and **approval-gated like any cloud send** (free and ungated when the chosen
  model is local). Audited as `consult.requested` / `consult.result` (the raw
  critique never enters the ledger payload). Slash: `/consult <question>`.

- **New slash commands** — `/lab [run|report]`, `/simulate <tool>`,
  `/consult <question>`.

---

## Post-v3c Win32 mesh update

The latest SelfConnect core work adds a hard coordination rule for multi-agent
terminal meshes: replies must travel through SelfConnect transport into the
receiving agent's registered terminal, not by local narration that another
agent has to scrape. Use:

```bash
selfconnect slash "/mesh-protocol"
```

See [Win32 Mesh Updates](docs/WIN32-MESH-UPDATES.md) for the terminal-specific
integration backlog: target guard, `birth_id`, echo-filtered readback, channel
router, and compact handoff.

---

## Architecture

```
┌──────────────────────────── Renderer (untrusted UI) ────────────────────────────┐
│  React + xterm.js   │  7 widgets  │  ApprovalsPanel  │  window.selfconnect (only) │
└───────────────────────────────────▲──────────────────────────────────────────────┘
                                     │  narrow typed contextBridge + Zod-validated IPC
┌───────────────────────────────────┴────────── Daemon (Electron main / trusted) ──┐
│  Daemon orchestrator                                                              │
│   • EventBus  (one identity-stamped bus)      • AuditLedger (SHA-256 hash chain)  │
│   • IdentityRegistry (session/run/agent)      • PolicyEngine (local-only, caps)   │
│   • ApprovalManager (2-min timeout = denied)  • Redactor (pre-cloud, every byte)  │
│   • SecuritySentinel / ContextGauge / AgentMesh                                   │
│   • ModelRouter → ProviderRegistry → {Ollama (local), OpenAI-compat, Anthropic}   │
│   • ReviewAgent (READ-ONLY)                   • PtyManager → node-pty / ConPTY     │
│  Provider keys live ONLY here, in the daemon .env.                                │
└───────────────────────────────────────────────────────────────────────────────────┘
```

**Core loop:** `spawn → tag identity → inject → read → approve → route → audit → repeat`.
Every material action flows through one identity-stamped event bus and is appended
to one hash-chained audit ledger.

### Module map

| Path | Responsibility |
|------|----------------|
| `electron/main.ts` | Window + IPC registration; wires the daemon and PTY. |
| `electron/preload.ts` | Exposes the **only** renderer capability: `window.selfconnect`. |
| `electron/ipc-contract.ts` | Typed contextBridge surface. |
| `src/shared/contracts.ts` | Zod schemas for events, ledger, IPC, and UI state. |
| `src/daemon/daemon.ts` | Trusted orchestrator; single record() choke point. |
| `src/daemon/event-bus.ts` | Identity-enforcing event bus. |
| `src/daemon/audit-ledger.ts` | Append-only JSONL SHA-256 hash chain + `verifyChain`. |
| `src/daemon/policy-engine.ts` | Local-only block, spend cap, approval requirement. |
| `src/daemon/approvals.ts` | Approval gate; 2-minute timeout = denied. |
| `src/daemon/redactor.ts` | Secret redaction over every byte before any cloud call. |
| `src/daemon/command-risk.ts` | Risky-command detection. |
| `src/daemon/context-builder.ts` | Review snapshot (cwd, shell, terminal, git, docs). |
| `src/daemon/pty-manager.ts` | The **only** importer of node-pty (lazy, isolated). |
| `src/daemon/adapters/*` | BPC envelope, TSK transport, Sentinel export (future hooks). |
| `src/agent/model-router.ts` | Provider/model selection + routing reason. |
| `src/agent/provider-registry.ts` | Builds providers from daemon config. |
| `src/agent/cost-kernel.ts` | Estimated vs verified tokens, session/avoided spend. |
| `src/agent/review-agent.ts` | READ-ONLY review agent (never executes/writes). |
| `src/renderer/*` | App shell, terminal, approvals, widgets, styles. |

---

## Security model (enforced in code)

1. **Renderer holds no keys / signing material** — keys live in the daemon `.env`.
2. `contextIsolation: true`
3. `nodeIntegration: false`
4. `sandbox: true`
5. Only a **narrow typed** contextBridge API is exposed: `window.selfconnect`.
6. **Secret redaction** runs over every byte of context *before* any cloud call.
7. **Local-only mode hard-blocks** all cloud providers regardless of keys/routing.
8. Cloud sends and premium escalation require **explicit human approval**.
9. Approval timeout is **2 minutes; timeout = denied** (fail-closed).
10. Per-call spend cap (`SELFCONNECT_MAX_SPEND_PER_CALL`) refuses over-budget cloud calls.
11. The **review agent is read-only**: never executes commands or writes files.
12. Every non-output event includes `sessionId/runId/agentId`.
13. Every material event is appended to a JSONL SHA-256 hash-chain ledger.
14. `ledger.verifyChain()` detects tampering and is covered by tests.

All IPC payloads are validated with **Zod** at the daemon boundary.

In v2 these invariants extend to the new surfaces: **MCP outbound args** and
**A2A outbound payloads** always pass the redactor; A2A `handoff`/unallowlisted
sends and `ask`-mode mutating tools require approval; high/critical-risk tools
(e.g. `bash`) are gated even in `auto`; `plan` mode hard-blocks every mutating
tool; the MCP server is read-only and never runs a shell.

---

## Tool surface vs Claude Code (parity table)

Every tool below is daemon-owned and governed: identity-stamped →
permission-gated (`plan`/`ask`/`auto`) → risk-checked → hook-wrapped →
checkpointed (writers) → audited to the hash-chained ledger.

| Tool | Claude Code | SelfConnect v2 | Mutating | Notes |
|------|:-----------:|:--------------:|:--------:|-------|
| `read_file` | ✅ | ✅ | – | offset/limit, numbered lines |
| `write_file` | ✅ | ✅ | ✔ | checkpointed before write |
| `edit_file` | ✅ | ✅ | ✔ | exact-string, multi-edit, replaceAll; checkpointed |
| `apply_patch` | ✅ | ✅ | ✔ | structured multi-file; checkpointed |
| `glob` | ✅ | ✅ | – | `src/**/*.ts` style |
| `grep` | ✅ | ✅ | – | regex, context lines, files/content modes |
| `bash` | ✅ | ✅ | ✔ | runs through the governed PTY; **always approval-gated** |
| `web_fetch` | ✅ | ✅ | – | outbound text redacted, audited |
| `web_search` | ✅ | ✅ | – | cloud — blocked in local-only |
| `task` | ✅ | ✅ | – | scoped sub-agent (own identity + tool allowlist) |
| `ask_user` | ✅ | ✅ | – | routed through the approvals panel |
| `todo_write` / `todo_read` | ✅ | ✅ | ✔ / – | persisted in the session snapshot |
| memory (`memory_read` / `memory_write`) | ✅ (CLAUDE.md) | ✅ (`SELFCONNECT.md`) | – / ✔ | project memory |
| permission modes (`plan`/`ask`/`auto`) | ✅ | ✅ | — | plan blocks mutating; ask gates mutating; auto gates high/critical |
| hooks (pre/post tool) | ✅ | ✅ | — | `hooks.json`; blocking pre-hook denies the tool |
| checkpoints + rewind | ✅ | ✅ (`/rewind`) | — | auto file snapshots before any write |
| **SelfConnect-only:** `ledger_verify`, `ledger_query`, `cost_report`, `redact_text`, `review_request`, `a2a_send`, `a2a_peers`, `session_list`, `session_resume`, `mcp_call` | — | ✅ | mixed | governance/observability tools with no Claude Code equivalent |

---

## Headless CLI + SDK

```bash
selfconnect help                 # usage
selfconnect state                # aggregate UI state as JSON
selfconnect verify               # verify the audit ledger hash chain
selfconnect sessions             # list resumable sessions
selfconnect review security      # run the read-only review agent
selfconnect tools                # list governed tools
selfconnect slash "/cost"        # run a slash command
selfconnect mcp serve            # run as a read-only MCP server (stdio)

# v3b — Trust Layer
selfconnect ledger verify              # hash chain AND every checkpoint signature
selfconnect ledger export --ietf       # audit trail in IETF conformance shape
selfconnect passport export pass.json  # signed Merkle work-history passport
selfconnect passport verify pass.json  # verify a passport offline
selfconnect evidence export <sid>      # compliance ZIP (ledger + checkpoints + pubkeys + report)
selfconnect replay export <sid>        # signed .screplay session bundle
selfconnect replay verify file.screplay
```

```ts
import { SelfConnectClient } from 'selfconnect-terminal';

const client = new SelfConnectClient();         // owns a governed Daemon
client.onEvent((e) => console.log(e.type));      // identity-stamped bus
await client.slash('/verify');
const res = await client.invokeTool('read_file', { path: 'README.md' }, 'shell');
console.log(client.verifyLedger().ok);
```

The CLI and SDK drive the **same** governed daemon core as the Electron app:
identity-stamped bus → policy → approvals → redaction → hash-chained ledger.
Provider keys are read from the daemon `.env` only and are never printed.

---

## The seven widgets

1. **Review Mascot** (floating) — click a mode (optimize / bugs / architecture /
   security / next-steps / full) to run snapshot → redact → route → review.
2. **Cost Kernel** (dock) — estimated-before vs verified-after tokens, session
   spend, avoided cloud spend on local calls, per-call cap, ESTIMATED/VERIFIED badges.
3. **Context Gauge** (dock) — pressure thresholds: normal `<60`, warn `>=60`,
   danger `>=80`, migrate `>=90`.
4. **Model Router** (dock) — active provider/model, routing reason, provider
   liveness (Ollama / OpenAI-compatible / Anthropic), local-only toggle.
5. **Security Sentinel** (dock) — redaction counts, risky-command findings,
   high/critical totals; emits `risk.detected`.
6. **Agent Mesh** (dock) — spawned agents, runs, blocked-on-approval state;
   future BPC/TSK hooks.
7. **Ledger Status** (status bar) — entry count, last hash tail, OK/BROKEN status,
   and a Verify button.

---

## Setup

### Generic (macOS / Linux)

```bash
npm install
cp .env.example .env          # edit to add provider keys (optional)
npm run rebuild               # electron-rebuild node-pty against the Electron ABI
npm run typecheck && npm test && npm run build
npm start                     # launch the app
```

### Windows 11 (primary target)

Run the provided script in PowerShell:

```powershell
pwsh -File scripts/setup-windows.ps1
```

It runs: `npm install` → copy `.env` → `electron-rebuild -f -w node-pty`
→ `typecheck` → `test` → `build`. node-pty uses **ConPTY** on Windows 10/11.

### npm scripts

| Script | Action |
|--------|--------|
| `npm run dev` | Vite dev server (renderer). |
| `npm start` | Launch Electron. |
| `npm run build` | Build renderer (Vite) + main/preload (tsc) + CLI/SDK (tsc). |
| `npm run build:preview` | Build the static browser preview (`dist-preview/`, relative paths). |
| `npm run build:cli` | Emit the headless CLI + typed SDK to `dist/` with declarations. |
| `npm run typecheck` | Type-check renderer, daemon, and CLI/SDK projects. |
| `npm test` | Run the Vitest suite. |
| `npm run rebuild` | `electron-rebuild -f -w node-pty`. |
| `npm run dist` | Build + package Windows NSIS installer & portable (electron-builder). |

---

## Configuration (`.env`)

| Var | Default | Meaning |
|-----|---------|---------|
| `SELFCONNECT_LOCAL_ONLY` | `true` | Hard-block all cloud providers. |
| `SELFCONNECT_LEDGER_PATH` | `./data/selfconnect-ledger.jsonl` | Audit ledger file. |
| `SELFCONNECT_MAX_SPEND_PER_CALL` | `0.25` | Per-call USD cap for cloud calls. |
| `SELFCONNECT_APPROVAL_TIMEOUT_MS` | `120000` | Approval window (2 min). |
| `OLLAMA_URL` / `OLLAMA_MODEL` | `http://localhost:11434` / `gemma3` | Local provider. |
| `OPENAI_COMPAT_URL/_API_KEY/_MODEL` | — | OpenAI-compatible cloud provider. |
| `ANTHROPIC_API_KEY/_MODEL` | — / `claude-sonnet-4-5` | Anthropic cloud provider. |
| `ANTHROPIC_INPUT_PRICE` / `_OUTPUT_PRICE` | `0` / `0` | Anthropic price per 1M tokens. |
| `COST_BASELINE_INPUT_PRICE` / `_OUTPUT_PRICE` | `3` / `15` | Baseline cloud price for "avoided" spend. |
| `SELFCONNECT_SESSIONS_DIR` | `./data/sessions` | Per-session snapshot store (resume). |
| `SELFCONNECT_A2A_MODE` | `file` | A2A transport: `file` \| `ws` \| `off`. |
| `SELFCONNECT_A2A_DIR` | `./data/a2a` | File-mailbox directory (file mode). |
| `SELFCONNECT_A2A_WS_PORT` | `8787` | WebSocket port (ws mode). |
| `SELFCONNECT_A2A_ALLOWLIST` | — | Comma-separated trusted peers (others need approval). |
| `SELFCONNECT_MCP_CONFIG` | `./mcp-servers.json` | MCP servers config (see `mcp-servers.json.example`). |
| `SELFCONNECT_CHECKPOINTS_DIR` | `./data/checkpoints` | File checkpoints for `/rewind`. |
| `SELFCONNECT_HOOKS_CONFIG` | `./hooks.json` | Pre/post tool-use hooks. |
| `SELFCONNECT_CONFIDENCE_THRESHOLD` | `0.5` | E6: below this, low-confidence actions verify (dry-run) or escalate (approval). |
| `SEARCH_API_URL` / `SEARCH_API_KEY` | — | `web_search` provider (cloud — blocked in local-only). |

---

## Troubleshooting

**node-pty ABI mismatch** (`Error: The module was compiled against a different
Node.js version`): the native addon must match the Electron ABI, not your system
Node. Re-run:

```bash
npm run rebuild        # or: npx electron-rebuild -f -w node-pty
```

**Visual Studio C++ Build Tools (Windows)**: node-pty compiles a native addon.
Install **"Desktop development with C++"** from the Visual Studio Build Tools,
then reopen your shell so the toolchain is on `PATH`.

**PowerShell ExecutionPolicy**: if `setup-windows.ps1` is blocked
(`running scripts is disabled on this system`), run:

```powershell
Set-ExecutionPolicy -Scope Process -ExecutionPolicy Bypass
```

**ConPTY**: node-pty uses Windows ConPTY on Windows 10/11. On older Windows it
falls back to winpty; the modern target here is Windows 11.

**Tests don't need the native binary**: node-pty is imported only in
`pty-manager.ts` (lazily). The Vitest suite never loads it, so tests stay green
even if a native rebuild is unavailable in CI.

---

## License

MIT.

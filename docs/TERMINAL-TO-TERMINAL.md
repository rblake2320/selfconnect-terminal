# Terminal-to-Terminal Communication — Claude Code with SelfConnect

**SelfConnect is not generic agent-to-agent messaging.** Its core, defining
mechanism is **the terminal itself as the communication medium**: one AI injects
keystrokes into another AI's *real* terminal — writes the message text, waits,
then sends **Enter (`\r`) as a separate step** — and reads the reply back from
the screen / PTY output. No human relay, no API handshake between the two AIs.
Everything that crosses that terminal is funneled through a single governance
choke point and written to a SHA-256 hash-chained ledger.

The MCP server and the file-mailbox / WebSocket transports documented later are
**supporting, governed side doors** — useful, but layered on top. They are not
the core. If you read only one section, read **Channel 1**.

> **Verification legend.** `[VERIFIED-FROM-CODE]` = confirmed by reading the
> cited source file in this repo on the default branch (`master`).
> `[VERIFIED-BY-TEST]` = exercised by a passing test in `tests/`.
> `[VERIFIED-LIVE-ON-WINDOWS]` = observed end-to-end on the inventor's Windows 11
> machine on 2026-06-10 (see `docs/INVENTION-DISCLOSURE.md` reduction-to-practice
> log). `[UNVERIFIED-IN-SANDBOX]` = correct per source but not re-executed in this
> Linux sandbox (no Windows host, no real `claude` binary here).

All command/env-var syntax below is taken verbatim from source — file and symbol
citations are inline. Nothing here is guessed.

---

## Channel 1 (CORE) — Terminal-as-medium: keystroke injection + read-back

### What it is

SelfConnect hosts a **real terminal** — on Windows a ConPTY child of `COMSPEC`
(`cmd.exe`); on POSIX the user's `$SHELL`. `[VERIFIED-FROM-CODE:
src/daemon/pty-manager.ts:23-28,48-65]` An interactive agent such as Anthropic's
`claude` (Claude Code) runs **inside** that PTY as an ordinary child process. A
second party (a human, a script, or another AI orchestrator) then **communicates
with that hosted agent by driving the terminal**:

1. **Write the message text** into the PTY input channel (no newline).
2. **Wait** — give the hosted agent's line editor time to receive the text.
3. **Send Enter (`\r`) as a separate write** to submit the line.
4. **Read the reply back** from the PTY's output stream (the screen).

This is genuine AI-to-AI communication over a terminal: the medium is the
keystroke stream and the rendered output, not an API call between the two models.

### Why "Enter as a separate step" matters (and where it lives in code)

The PTY input transport is **`pty.write(data)`** — one atomic write per call
(`src/daemon/pty-manager.ts:67-69` `write(data){ this.pty?.write(data); }`).
`[VERIFIED-FROM-CODE]` The "type text → wait → press Enter" behavior is therefore
a **protocol performed by the injector over this channel**: two separate
`write` calls (the text, then `\r`) with a wait between them — *not* a single
combined send. Sending text and Enter together can race the hosted agent's input
handling; separating them is what makes injection reliable.

The governed entry point for that input is the Electron main-process IPC handler:

```ts
// electron/main.ts:71-77  [VERIFIED-FROM-CODE]
ipcMain.on(IPC.ptyInput, (_e, raw) => {
  const { data } = PtyInputSchema.parse(raw);
  if (data.includes('\r') || data.includes('\n')) {
    daemon?.inspectInput(data.replace(/[\r\n]+$/, ''));  // governance sees the submitted line
  }
  pty?.write(data);                                       // then it reaches the terminal
});
```

So the **Enter write is also the governance trigger**: only a write containing
`\r`/`\n` causes the daemon to inspect (and record) the *submitted line*. A
text-only write (step 1) flows to the PTY; the separate Enter write (step 3) is
what the daemon treats as "a line was submitted." `[VERIFIED-FROM-CODE:
electron/main.ts:71-77; src/daemon/pty-manager.ts:67-69]`

### Proven live

On 2026-06-10 (~18:49 CDT) an interactive `claude` (Claude Code v2.1.156, Claude
Max subscription — **not** the API) was hosted inside a real ConPTY; a message
was injected per this protocol (text → wait → `\r` separately) and a genuine
reply was read back from the screen: *"Received — current working directory is
C:\\Users\\techai."* — zero human relay. Later the same session launched Claude
Code **inside the governed pane** while the on-disk ledger grew 25 → 26 entries.
`[VERIFIED-LIVE-ON-WINDOWS: see docs/INVENTION-DISCLOSURE.md §RTP events 4–5]`

### What is governed here

Every submitted line (the Enter step) is inspected and recorded through the
daemon's single `record()` choke point → policy → approvals → redaction →
SHA-256 hash-chained ledger. `[VERIFIED-FROM-CODE: src/daemon/daemon.ts:254-264;
src/daemon/audit-ledger.ts:42-90]` Slash lines starting with `/` are intercepted
**before** they reach the PTY and never run as shell. `[VERIFIED-FROM-CODE:
src/daemon/slash-commands.ts:7-15]`

**Honest boundary:** the hosted agent's *own model calls* (e.g. Claude Code →
Anthropic) go over its own network connection; SelfConnect does not proxy or
redact those. What SelfConnect governs is the **terminal medium** — the injected
keystrokes, the submitted lines, the commands run in the pane, and the output —
plus anything the agent does through the side-door channels below.

### Confirm it landed

Run `/verify` (chain status) and `selfconnect ledger export` to see the recorded
terminal/command events. `[VERIFIED-FROM-CODE: src/cli/index.ts]`

---

## Channel 2 (side door) — MCP: Claude Code calls SelfConnect's governed tools

> A **supporting** channel. It lets Claude Code *query* SelfConnect's governed
> state directly, but it is read-only and is **not** the terminal medium.

SelfConnect ships a **read-only MCP server** over newline-delimited JSON-RPC on
stdio. It **never executes shell or mutating tools** — only read-only governance
queries. `[VERIFIED-FROM-CODE: src/mcp/server.ts:10-14,51]`

Protocol (from `src/mcp/server.ts`):
- `initialize` → `protocolVersion: "2024-11-05"`,
  `serverInfo: { name: "selfconnect", version: "2.0.0" }`,
  `capabilities: { tools: {} }`. `[VERIFIED-FROM-CODE: server.ts:82-88]`
- `tools/list` → the 6 tools below. `tools/call` → `{ content: [{ type: "text",
  text }] }`. Unknown method → JSON-RPC error `-32601`.
  `[VERIFIED-FROM-CODE: server.ts:89-100]`

**The 6 exposed tools** `[VERIFIED-FROM-CODE: src/mcp/server.ts:25-47]`:

| tool | arguments | description (verbatim) |
|------|-----------|------------------------|
| `ledger_verify` | none | Verify the audit ledger hash chain. |
| `ledger_query` | `sessionId?`, `type?`, `limit?` | Query ledger entries by sessionId/type/limit. |
| `session_list` | none | List past sessions. |
| `cost_report` | none | Report session and avoided spend. |
| `redact_text` | `text` (required) | Redact secrets from text. |
| `review_request` | `mode` (required) | Run a read-only governed review. |

Exercised by `tests/mcp-roundtrip.test.ts`. `[VERIFIED-BY-TEST]`

### Register it in Claude Code (Windows)

The repo's example config (`mcp-servers.json.example`) registers the server as
`selfconnect` / `["mcp","serve"]`: `[VERIFIED-FROM-CODE: mcp-servers.json.example]`

```json
{ "servers": { "selfconnect": { "command": "selfconnect", "args": ["mcp", "serve"] } } }
```

For **Claude Code's** MCP config:

```powershell
# If `selfconnect` is on PATH (e.g. after `npm link`):
claude mcp add selfconnect -- selfconnect mcp serve
# Or by absolute path (no PATH dependency):
claude mcp add selfconnect -- node C:\path\to\selfconnect-terminal\dist\cli\index.js mcp serve
```

Equivalent JSON for Claude Code's `mcp` block:

```json
{
  "mcpServers": {
    "selfconnect": {
      "command": "node",
      "args": ["C:\\path\\to\\selfconnect-terminal\\dist\\cli\\index.js", "mcp", "serve"]
    }
  }
}
```

> `selfconnect mcp serve` and the SelfConnect-side JSON keys are
> `[VERIFIED-FROM-CODE]`. The `claude mcp add` flags belong to Anthropic's CLI
> (not in this repo) — treat that line as `[UNVERIFIED-IN-SANDBOX]` and confirm
> with `claude mcp add --help` on your machine.

### Verify by hand (raw JSON-RPC)

```powershell
'{"jsonrpc":"2.0","id":1,"method":"initialize"}'      | selfconnect mcp serve
'{"jsonrpc":"2.0","id":2,"method":"tools/list"}'      | selfconnect mcp serve
'{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"ledger_verify"}}' | selfconnect mcp serve
```
`[VERIFIED-FROM-CODE: src/mcp/stdio-channel.ts + server.ts]` `[UNVERIFIED-IN-SANDBOX: piped live run]`

(SelfConnect can also act as an MCP *client* via `/mcp [list|tools <server>|call
<server> <tool> <json>]`. `[VERIFIED-FROM-CODE: slash-commands.ts:390-430]`)

---

## Channel 3 (side door) — File-mailbox / WebSocket envelopes (BPC over TSK)

> Also **supporting**, not core. BPC/TSK is a structured, signed, hash-chained
> *file/socket* protocol layered on top of the system — handy when you want
> durable, replayable, signed messages rather than live terminal injection.

### 3.1 Transport selection (env vars) — `src/daemon/config.ts:60-106`  `[VERIFIED-FROM-CODE]`

| env var | default | meaning |
|---------|---------|---------|
| `SELFCONNECT_A2A_MODE` | `file` | `file` \| `ws` \| `off` (anything else → `file`). |
| `SELFCONNECT_A2A_DIR` | `./data/a2a` | mailbox root for `file` mode. |
| `SELFCONNECT_A2A_WS_PORT` | `8787` | listener port for `ws` mode. |
| `SELFCONNECT_A2A_ALLOWLIST` | `` (empty) | comma-separated trusted peer ids. |

### 3.2 The BPC envelope (exact wire format) — `BpcEnvelopeSchema` in `src/shared/contracts.ts`  `[VERIFIED-FROM-CODE]`

```jsonc
{
  "bpc": "1.0",
  "id": "bpc_<uuid>",
  "from": { "sessionId": "…", "runId": "…", "agentId": "claude-code" },
  "to": "system",
  "ts": 1700000000000,
  "kind": "msg",                 // 'msg' | 'ack' | 'review' | 'handoff'
  "payload": "…",                // any JSON; null if absent
  "prevHash": "<64 hex>",        // previous envelope's hash, or 64×'0' genesis
  "hash": "<64 hex>",            // sha256 of the canonical form below
  "signature": { … }             // OPTIONAL Ed25519 (see 3.4)
}
```

Hash is over a fixed key order (`src/daemon/adapters/bpc-envelope.ts:20-35`):
```js
sha256(JSON.stringify({ bpc, id, from, to, ts, kind, payload: payload ?? null, prevHash }))
```
Genesis prevHash = 64 zeros (`BPC_GENESIS`). Each peer is keyed by `from.agentId`
and chain-verified from genesis; a break → HIGH finding `pattern:'bpc-chain'`.
`[VERIFIED-FROM-CODE: a2a-manager.ts:142-160; bpc-envelope.ts:85-95]`
`[VERIFIED-BY-TEST: a2a-manager.test.ts]`

### 3.3 File mailbox paths — `src/daemon/adapters/tsk-transport.ts`  `[VERIFIED-FROM-CODE]`

- **Inbound (you → daemon):** append one JSON line to the **single shared inbox**
  `<SELFCONNECT_A2A_DIR>/inbox.jsonl`. On `start()` pre-existing lines are skipped;
  malformed lines ignored. (`tsk-transport.ts:86-126`)
- **Outbound (daemon → you):** replies go to the **per-peer** outbox
  `<dir>/<peerSanitized>/outbox.jsonl` (`replace(/[^a-zA-Z0-9_.-]/g,'_')`). (`:79-103`)
- Ingested only when the daemon **polls** — trigger with `/a2a poll`.
  (`slash-commands.ts:451-453` → `daemon.a2aPoll()`; `daemon.ts:985-995`)

### 3.4 Trust: signing, allowlist, delegation

- **Unsigned ≠ rejected.** `poll()` chain-verifies every envelope but checks a
  signature **only if present**; a *present-but-invalid* signature is HIGH
  (`pattern:'bpc-signature'`, impersonation). A missing signature is not itself a
  rejection. `[VERIFIED-FROM-CODE: a2a-manager.ts:162-171]`
  `[VERIFIED-BY-TEST: example-a2a-envelope.test.ts]`
- **A signature alone ≠ trust.** Signatures are self-describing (carry their own
  `publicKeyHex`); `verifySignature` proves only key-possession.
  `[VERIFIED-FROM-CODE: src/daemon/agent-keys.ts]`
- **Trust comes from** the **allowlist** (outbound approval gate:
  `requiresApproval` true if not allowlisted OR kind `handoff`) and from
  **delegation certificates rooted at a human** (`issuer==='human' &&
  humanApproved===true`). `[VERIFIED-FROM-CODE: a2a-manager.ts:86-89;
  daemon.ts:967-983; delegation.ts]`

### 3.5 Delegation commands — `src/daemon/slash-commands.ts:51-52,505-553`  `[VERIFIED-FROM-CODE]`

```text
/delegate <grantee> [tools=a,b] [budget=0.05] [ttl=<seconds>] [class=public,internal]
/grants                 # list grants (human-root marked "[human root]")
/grants <hash>          # verify one chain to the human root
```

### 3.6 Runnable example

`examples/a2a-send-to-selfconnect.mjs` (pure Node, zero SelfConnect imports)
builds a valid BPC envelope, appends it to `<dir>/inbox.jsonl`, then polls the
per-peer outbox. Its hashing is cross-checked against the daemon's real
`sealEnvelope`/`verifyEnvelope`/`verifyChain` in
`tests/example-a2a-envelope.test.ts`. `[VERIFIED-BY-TEST: 5 tests pass]`

```powershell
$env:SELFCONNECT_A2A_MODE = "file"
$env:SELFCONNECT_A2A_DIR  = ".\data\a2a"
$env:SELFCONNECT_A2A_ALLOWLIST = "claude-code"
node examples\a2a-send-to-selfconnect.mjs --peer claude-code --text "hello from Claude Code"
#   To sign: set SELFCONNECT_EXAMPLE_PRIVKEY_HEX (and optionally _PUBKEY_HEX).
# In SelfConnect:  /a2a poll  ->  /a2a peers  ->  /a2a send claude-code "hi back"
```
`[VERIFIED-FROM-CODE for paths/commands]` `[VERIFIED-BY-TEST for envelope logic]`
`[UNVERIFIED-IN-SANDBOX: full live daemon round-trip]`

### 3.7 WebSocket mode

`SELFCONNECT_A2A_MODE=ws` starts a **listener** on `SELFCONNECT_A2A_WS_PORT`
(default 8787) via lazy `import('ws')`; frames must be JSON BPC envelopes. The
headless build does **not** dial out — listener-only. `[VERIFIED-FROM-CODE:
tsk-transport.ts:148-196]`

---

## Verification checklist — observable proof per channel

| # | Channel | What to do | Observable proof |
|---|---------|-----------|------------------|
| 1 | **Terminal (core)** | Host `claude` in the pane; inject text, wait, send `\r` separately; read reply | Reply text appears in the pane; the submitted line is recorded; `/verify` chain `INTACT`; ledger grows by one `[VERIFIED-LIVE-ON-WINDOWS; VERIFIED-FROM-CODE: electron/main.ts:71-77]` |
| 2 | MCP | `claude mcp add selfconnect -- selfconnect mcp serve`; call a tool | Claude shows the `selfconnect` server + a `tools/call` result; raw NDJSON returns the 6 tools `[VERIFIED-BY-TEST: mcp-roundtrip]` |
| 3a | Mailbox send | run the example, then `/a2a poll` | Ledger gains `a2a.received {from:'claude-code',kind:'msg',id}` `[VERIFIED-FROM-CODE: daemon.ts:985-989]` |
| 3b | Mailbox peer | `/a2a peers` | row `claude-code recv=1 chain=OK allowlisted` `[VERIFIED-FROM-CODE: slash-commands.ts:432-444]` |
| 3c | Mailbox reply | `/a2a send claude-code "…"` | Ledger gains `a2a.sent`; line appears in `data\a2a\claude-code\outbox.jsonl` `[VERIFIED-FROM-CODE]` |
| 3d | Tamper | edit a 2nd inbox envelope's `prevHash`, `/a2a poll` | HIGH `pattern:'bpc-chain'` → `a2a.chain_broken` + `risk.detected` `[VERIFIED-BY-TEST]` |
| 3e | Delegation | `/delegate claude-code tools=ledger_query budget=0.05 ttl=3600`, `/grants <hash>` | `chain: VERIFIED to human root` `[VERIFIED-FROM-CODE: slash-commands.ts:505-553]` |

---

## Summary

1. **The core is the terminal as the medium** — keystroke injection (text → wait
   → **separate Enter**) + read-back, between two real AIs, with no human relay.
   Proven live on Windows 2026-06-10.
2. The **Enter write is the governance trigger**: only `\r`/`\n` causes the
   daemon to inspect and record the submitted line (`electron/main.ts:71-77`).
3. **MCP** (read-only tool queries) and **BPC/TSK mailbox/WS** (signed,
   hash-chained file/socket envelopes) are **supporting side doors**, not the
   core mechanism.
4. Everything funnels through one `record()` choke point into a SHA-256
   hash-chained ledger; trust for the side doors comes from an allowlist and
   human-rooted delegation certificates.

> Formerly `docs/A2A-CLAUDE-CODE.md` (renamed to reflect that the terminal medium,
> not generic A2A, is the core). See `docs/INVENTION-DISCLOSURE.md` for the
> invention record and reduction-to-practice log.

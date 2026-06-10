# Connecting Claude Code with SelfConnect Terminal

A code-verified walkthrough for making Anthropic's `claude` CLI and **SelfConnect
Terminal** genuinely communicate. There are three real channels, in increasing
order of governance strength:

1. **PTY pane** — run `claude` inside SelfConnect's terminal; everything it does
   flows through SelfConnect's record/policy/ledger governance.
2. **MCP** — register SelfConnect's read-only MCP server in Claude Code so Claude
   can call SelfConnect's governed tools directly.
3. **Native A2A (BPC/TSK)** — exchange signed, hash-chained envelopes through a
   file mailbox or a WebSocket listener.

> **Verification legend.** `[VERIFIED-FROM-CODE]` = confirmed by reading the
> cited source file in this repo at commit on `main`. `[VERIFIED-BY-TEST]` =
> exercised by a test in `tests/` (or the bundled example) that passes here.
> `[UNVERIFIED-ON-WINDOWS]` = correct per source but not executed end-to-end in
> this Linux sandbox (no Windows host, no real `claude` binary here). Where a
> command targets Windows specifically, assume `[UNVERIFIED-ON-WINDOWS]` for the
> live launch and `[VERIFIED-FROM-CODE]` for the syntax.

All command/env-var syntax below is taken verbatim from source — file and symbol
citations are inline. Nothing here is guessed.

---

## 0. Prerequisites & what the CLI actually exposes

The published binary is **`selfconnect`** → `dist/cli/index.js`
(`package.json` `"bin": { "selfconnect": "dist/cli/index.js" }`).
`[VERIFIED-FROM-CODE: package.json]`

The CLI commands (from `src/cli/index.ts`, the `switch (cmd)` in `main()`):
`state`, `verify`, `sessions`, `review <mode>`, `tools`, `slash "<line>"`,
`ledger verify|export [--ietf]`, `passport export|verify`, `evidence export`,
`replay export|verify`, `lab run|report`, and **`mcp serve`**.
`[VERIFIED-FROM-CODE: src/cli/index.ts:86-144,304]`

> **Surprising fact #1 — there is no `selfconnect a2a` CLI command.** A2A lives
> inside the running daemon and is driven by **slash commands** (`/a2a …`) or by
> writing envelopes into the file mailbox directly. The only CLI subcommand that
> touches the network/agent surface is `mcp serve`.
> `[VERIFIED-FROM-CODE: src/cli/index.ts has no 'a2a' case]`

Build first so `dist/cli/index.js` exists, and either `npm link` or call it by
path:

```powershell
npm run build        # build:renderer && build:electron && build:cli  [VERIFIED-FROM-CODE: package.json]
# then either:
npm link             # exposes `selfconnect` on PATH
# or call directly:
node .\dist\cli\index.js mcp serve
```
`[VERIFIED-FROM-CODE: package.json scripts]` `[UNVERIFIED-ON-WINDOWS: live run]`

---

## Channel 1 — Claude Code inside SelfConnect's PTY pane

SelfConnect's terminal pane is a **real ConPTY** child (it spawns your
`COMSPEC`, i.e. `cmd.exe`, on Windows). Typing `claude` there launches Claude
Code exactly as in any terminal — it is a normal child process of the PTY.

What makes this a *channel* rather than just "a terminal": every byte you type
and every command that runs in the pane is recorded by the daemon's `record()`
governance pipeline (identity-stamped event → policy → approvals → redaction →
hash-chained ledger). Slash lines starting with `/` are intercepted by the
daemon **before** they reach the PTY and never run as shell.
`[VERIFIED-FROM-CODE: src/daemon/slash-commands.ts:7-15 "Terminal input lines
starting with '/' NEVER reach the PTY"]`

**How to use it**

1. Launch SelfConnect (the Electron app, or the headless daemon for tests).
2. In the terminal pane, run `claude` (Anthropic's CLI must be on `PATH`).
3. Work normally. Claude Code's own shell commands run inside the ConPTY, so
   they are visible to SelfConnect's recorder.

**Caveat — be honest about the governance boundary:** Claude Code's *model
calls* go straight to Anthropic over its own network connection; SelfConnect
does not proxy or redact those. What SelfConnect governs here is the **terminal
I/O and any commands Claude runs in the pane**, plus anything Claude does via
Channels 2 and 3. `[VERIFIED-FROM-CODE: pane is a COMSPEC ConPTY; daemon records
terminal events]` `[UNVERIFIED-ON-WINDOWS: live `claude` session]`

To confirm activity landed in the ledger: run `/verify` (chain status) and
`selfconnect ledger export` to see the recorded events.

---

## Channel 2 — MCP: Claude Code calls SelfConnect's governed tools

SelfConnect ships a **read-only MCP server** over newline-delimited JSON-RPC on
stdio. It **never executes shell or mutating tools** — only read-only governance
queries. `[VERIFIED-FROM-CODE: src/mcp/server.ts:10-14,51]`

Protocol details (from `src/mcp/server.ts`):
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

These six are also exercised by `tests/mcp-roundtrip.test.ts`.
`[VERIFIED-BY-TEST: mcp-roundtrip.test.ts]`

### Register it in Claude Code (Windows)

The repo's own example config (`mcp-servers.json.example`) registers the server
as `selfconnect` / `["mcp","serve"]`:
`[VERIFIED-FROM-CODE: mcp-servers.json.example]`

```json
{
  "servers": {
    "selfconnect": { "command": "selfconnect", "args": ["mcp", "serve"] }
  }
}
```

For **Claude Code's** MCP config, use its `claude mcp add` form. Two equivalent
options (use the absolute `node` path form if `selfconnect` is not on `PATH`):

```powershell
# If `selfconnect` is on PATH (e.g. after `npm link`):
claude mcp add selfconnect -- selfconnect mcp serve

# Or call the built CLI by absolute path (no PATH dependency):
claude mcp add selfconnect -- node C:\path\to\selfconnect-terminal\dist\cli\index.js mcp serve
```

Equivalent JSON for Claude Code's `mcp` config block:

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

> **Note on `claude mcp add` syntax:** `selfconnect mcp serve` and the JSON keys
> for SelfConnect's side are `[VERIFIED-FROM-CODE]`. The exact `claude mcp add`
> flags belong to Anthropic's CLI, which is not in this repo — treat the
> `claude mcp add` line as `[UNVERIFIED-ON-WINDOWS]` and cross-check against
> `claude mcp add --help` on your machine. The server it points at is verified.

### Verify the MCP channel by hand

You can drive the server with raw JSON-RPC to prove it works before wiring
Claude Code in:

```powershell
# One line of NDJSON per request on stdin; responses are NDJSON on stdout.
'{"jsonrpc":"2.0","id":1,"method":"initialize"}'      | selfconnect mcp serve
'{"jsonrpc":"2.0","id":2,"method":"tools/list"}'      | selfconnect mcp serve
'{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"ledger_verify"}}' | selfconnect mcp serve
```
`[VERIFIED-FROM-CODE: stdio framing in src/mcp/stdio-channel.ts + server.ts]`
`[UNVERIFIED-ON-WINDOWS: piped live run]`

(SelfConnect can also act as an MCP *client* toward other servers via the
`/mcp [list|tools <server>|call <server> <tool> <json>]` slash command.
`[VERIFIED-FROM-CODE: src/daemon/slash-commands.ts:390-430]`)

---

## Channel 3 — Native A2A (BPC over TSK)

This is the deepest integration: Claude Code (or any external agent) exchanges
**BPC envelopes** with SelfConnect's daemon over the **TSK transport**.

### 3.1 Transport selection (env vars)

From `src/daemon/config.ts` (`loadConfig`):
`[VERIFIED-FROM-CODE: src/daemon/config.ts:60-106]`

| env var | default | meaning |
|---------|---------|---------|
| `SELFCONNECT_A2A_MODE` | `file` | `file` \| `ws` \| `off` (anything else → `file`). |
| `SELFCONNECT_A2A_DIR` | `./data/a2a` | mailbox root for `file` mode. |
| `SELFCONNECT_A2A_WS_PORT` | `8787` | listener port for `ws` mode. |
| `SELFCONNECT_A2A_ALLOWLIST` | `` (empty) | comma-separated trusted peer ids. |

```powershell
$env:SELFCONNECT_A2A_MODE = "file"
$env:SELFCONNECT_A2A_DIR  = ".\data\a2a"
$env:SELFCONNECT_A2A_ALLOWLIST = "claude-code"   # trust this peer (see trust rules)
```

### 3.2 The BPC envelope (exact wire format)

Schema `BpcEnvelopeSchema` `[VERIFIED-FROM-CODE: src/shared/contracts.ts]`:

```jsonc
{
  "bpc": "1.0",                      // literal
  "id": "bpc_<uuid>",
  "from": { "sessionId": "…", "runId": "…", "agentId": "claude-code" },
  "to": "system",                    // logical daemon-side recipient label
  "ts": 1700000000000,               // integer epoch ms
  "kind": "msg",                     // 'msg' | 'ack' | 'review' | 'handoff'
  "payload": "…",                    // any JSON; null if absent
  "prevHash": "<64 hex>",            // previous envelope's hash, or 64×'0' genesis
  "hash": "<64 hex>",                // sha256 of the canonical form below
  "signature": { … }                 // OPTIONAL Ed25519 (see 3.4)
}
```

**The hash is computed over a canonical form with an exact key order**
(`src/daemon/adapters/bpc-envelope.ts` `canonical()`):
`[VERIFIED-FROM-CODE: bpc-envelope.ts:20-35]`

```js
sha256(JSON.stringify({ bpc, id, from, to, ts, kind, payload: payload ?? null, prevHash }))
```

The genesis prevHash is **64 zeros** (`BPC_GENESIS = '0'.repeat(64)`).
`[VERIFIED-FROM-CODE: bpc-envelope.ts:18]`

**Per-peer hash chain.** The daemon keys each peer by `from.agentId` and verifies
that peer's chain starting at genesis: every envelope's `prevHash` must equal the
prior envelope's `hash`, and each envelope's self-hash must recompute. A break →
a **HIGH** risk finding `pattern: 'bpc-chain'`.
`[VERIFIED-FROM-CODE: a2a-manager.ts:142-160; bpc-envelope.ts:85-95]`
`[VERIFIED-BY-TEST: a2a-manager.test.ts "flags a broken inbound chain"]`

### 3.3 File-mailbox mode — paths that matter

`FileTskTransport` (`src/daemon/adapters/tsk-transport.ts`):
- **Inbound (you → daemon):** append your envelope as one JSON line to the
  **single shared inbox** `<SELFCONNECT_A2A_DIR>/inbox.jsonl`. On `start()` the
  daemon records the current line count and only surfaces **new** lines, so
  pre-existing lines are skipped. Malformed lines are ignored.
  `[VERIFIED-FROM-CODE: tsk-transport.ts:86-126]`
- **Outbound (daemon → you):** the daemon writes replies to a **per-peer**
  outbox `<dir>/<peerSanitized>/outbox.jsonl`, where the peer name is sanitized
  with `replace(/[^a-zA-Z0-9_.-]/g, '_')`. `[VERIFIED-FROM-CODE: tsk-transport.ts:79-103]`
- The daemon ingests the inbox only when it **polls** — trigger that with the
  `/a2a poll` slash command. `[VERIFIED-FROM-CODE: slash-commands.ts:451-453 →
  daemon.a2aPoll(); daemon.ts:985-995]`

> **Important asymmetry:** inbound is ONE shared `inbox.jsonl`; replies are split
> per-peer under `<dir>/<peer>/outbox.jsonl`. An external agent writes to the
> former and reads from the latter. `[VERIFIED-FROM-CODE]`

### 3.4 Trust: signing, the allowlist, and delegation

This is where the real surprises are. Read carefully.

**Surprising fact #2 — an unsigned inbound envelope is NOT rejected for lacking a
signature.** On `poll()`, the daemon verifies the chain for every envelope. It
checks a signature **only if one is present**; a *present-but-invalid* signature
is flagged HIGH as impersonation (`pattern: 'bpc-signature'`). A missing
signature is not itself a rejection.
`[VERIFIED-FROM-CODE: a2a-manager.ts:162-171 "if (env.signature && !verifySignature…)"]`
`[VERIFIED-BY-TEST: tests/example-a2a-envelope.test.ts — valid unsigned envelope
ingests with zero findings]`

**Surprising fact #3 — a signature alone does not establish peer trust.**
Signatures are **stateless / self-describing**: each carries its own
`publicKeyHex`, and `verifySignature(message, signature)` simply verifies the
Ed25519 signature against that embedded key. So a valid signature proves only
"the holder of *this* key signed *this* hash" — not that the key belongs to a
trusted party. `[VERIFIED-FROM-CODE: src/daemon/agent-keys.ts verifySignature is
stateless; SignatureSchema carries publicKeyHex in contracts.ts]`

**Where trust actually comes from:**
- **Allowlist + approval gate (outbound).** When *SelfConnect* sends to a peer,
  `requiresApproval(peer, kind)` returns true if the peer is **not** allowlisted
  **or** the kind is `handoff`. A non-approved send is blocked and recorded as
  `policy.block`. `[VERIFIED-FROM-CODE: a2a-manager.ts:86-89; daemon.ts:967-983]`
  `[VERIFIED-BY-TEST: a2a-manager.test.ts approval cases]`
- **Delegation certificates (authority to act).** Authority for an agent to use
  tools/budget/data-classes comes from a **delegation chain** that must terminate
  at the human root: `verifyChain` walks `parent` links, checks each cert's
  content hash and signature, expiry, and scope intersection, and at the root
  requires `issuer === 'human'` **and** `humanApproved === true`. No grant →
  `"no delegation grant for <grantee>; ask the human to /grant"`.
  `[VERIFIED-FROM-CODE: src/daemon/delegation.ts HUMAN_ROOT='human', verifyChain,
  authorize]`

**So: can an external agent send an unsigned message and have it ingested?**
Yes — it will be recorded as `a2a.received` and appear in `/a2a peers`. But it is
*untrusted*: it is not allowlisted, it carries no human-rooted authority, and any
outbound reply SelfConnect tries to send back to that peer will hit the approval
gate unless you allowlist the peer. The clean, trusted path is: **allowlist the
peer (and/or issue a delegation grant), and sign envelopes with a key whose
authority traces to a human grant.**

### 3.5 Delegation bootstrap (human-rooted), exact commands

Slash commands `[VERIFIED-FROM-CODE: src/daemon/slash-commands.ts:51-52,287-291,
505-553]`:

```text
/delegate <grantee> [tools=a,b] [budget=0.05] [ttl=<seconds>] [class=public,internal]
/grants                 # list all grants (human-root grants marked "[human root]")
/grants <hash>          # verify one chain to the human root
```

- `/delegate` issues a scoped grant to `<grantee>` and immediately verifies the
  chain, printing `chain: VERIFIED to human root` (or `INVALID — <reason>`).
  Scope flags: `tools=` (default `['*']`), `budget=` USD, `ttl=` seconds,
  `class=` from `public|internal|secret|cui`.
  `[VERIFIED-FROM-CODE: slash-commands.ts:505-534; contracts DelegationScopeSchema]`
- `/grants <hash>` → `VERIFIED to human root (chain length N)` or
  `INVALID — <reason>`. `[VERIFIED-FROM-CODE: slash-commands.ts:536-553]`

> The `humanApproved===true` root must be established by the daemon/human side
> (`issuer === 'human'`). The `/delegate` command issues grants under that root;
> the human approval of the root grant is enforced in `delegation.ts verifyChain`.
> `[VERIFIED-FROM-CODE: delegation.ts]`

### 3.6 A concrete, runnable example

`examples/a2a-send-to-selfconnect.mjs` (pure Node, **zero SelfConnect imports**)
builds a valid BPC envelope, appends it to `<dir>/inbox.jsonl`, then polls the
per-peer `<dir>/<peer>/outbox.jsonl` for the reply. Its `buildEnvelope()` /
`hashEnvelope()` are **cross-checked against the daemon's real
`sealEnvelope`/`verifyEnvelope`/`verifyChain`** in
`tests/example-a2a-envelope.test.ts`, so the example cannot silently drift from
the app. `[VERIFIED-BY-TEST: tests/example-a2a-envelope.test.ts — 5 tests pass]`

End-to-end steps an external agent (Claude Code) can execute:

```powershell
# 1. Trust the peer so SelfConnect can reply without an approval prompt.
$env:SELFCONNECT_A2A_MODE = "file"
$env:SELFCONNECT_A2A_DIR  = ".\data\a2a"
$env:SELFCONNECT_A2A_ALLOWLIST = "claude-code"
# (start SelfConnect with these env vars)

# 2. Send a message into SelfConnect's inbox (optionally signed):
node examples\a2a-send-to-selfconnect.mjs --peer claude-code --text "hello from Claude Code"
#   To sign: also set SELFCONNECT_EXAMPLE_PRIVKEY_HEX (and optionally _PUBKEY_HEX).

# 3. In SelfConnect, ingest + reply:
#      /a2a poll                      -> records a2a.received, peer appears
#      /a2a peers                     -> shows claude-code  recv=1  chain=OK  allowlisted
#      /a2a send claude-code hi back  -> writes data\a2a\claude-code\outbox.jsonl

# 4. The example script (still polling) prints the reply it reads from the outbox.
```
`[VERIFIED-FROM-CODE for paths/commands]` `[VERIFIED-BY-TEST for envelope logic]`
`[UNVERIFIED-ON-WINDOWS: full live daemon round-trip]`

> The script chains `prevHash` onto your previously-sent envelopes (filtering
> `inbox.jsonl` by `from.agentId === peer`) so repeated sends form a valid chain.
> `[VERIFIED-FROM-CODE: the script + bpc-envelope chain rules]`

### 3.7 WebSocket mode

`SELFCONNECT_A2A_MODE=ws` starts a **listener** on `SELFCONNECT_A2A_WS_PORT`
(default 8787) via a lazy `import('ws')`. Each received text frame must be a JSON
BPC envelope (parsed by `BpcEnvelopeSchema`; malformed frames ignored). **The
headless build does not dial out** to peers — `send()` validates the envelope but
does not open client connections — so `ws` mode is listener-only here.
`[VERIFIED-FROM-CODE: tsk-transport.ts:148-196]` `ws` is a declared dependency
(`package.json`), needed at runtime in `ws` mode. `[VERIFIED-FROM-CODE: package.json]`

---

## Verification checklist — observable proof per channel

| # | Channel | What to do | Observable proof |
|---|---------|-----------|------------------|
| 1 | PTY | Run a command in the pane via Claude | `/verify` shows chain `INTACT`; `selfconnect ledger export` shows the recorded terminal/command events `[VERIFIED-FROM-CODE]` |
| 2 | MCP | `claude mcp add selfconnect -- selfconnect mcp serve`, then call a tool | Claude Code shows the `selfconnect` server and a `tools/call` result; raw NDJSON `initialize`/`tools/list` returns the 6 tools `[VERIFIED-BY-TEST: mcp-roundtrip]` |
| 3a | A2A send | `node examples\a2a-send-to-selfconnect.mjs --peer claude-code --text "…"` then `/a2a poll` | Ledger gains an `a2a.received` event `{from:'claude-code',kind:'msg',id}` `[VERIFIED-FROM-CODE: daemon.ts:985-989]` |
| 3b | A2A peer | `/a2a peers` | A row `claude-code  recv=1  chain=OK  allowlisted` `[VERIFIED-FROM-CODE: slash-commands.ts:432-444]` |
| 3c | A2A reply | `/a2a send claude-code "…"` | Ledger gains `a2a.sent`; a JSON line appears in `data\a2a\claude-code\outbox.jsonl`; the example script prints it `[VERIFIED-FROM-CODE: daemon.ts:967-983; tsk-transport.ts:99-103]` |
| 3d | Tamper | Hand-edit a second inbox envelope's `prevHash`, `/a2a poll` | HIGH finding `pattern:'bpc-chain'` recorded as `a2a.chain_broken` + `risk.detected` `[VERIFIED-BY-TEST: a2a-manager.test.ts]` |
| 3e | Impersonation | Send an envelope with a wrong `signature.sigHex` | HIGH finding `pattern:'bpc-signature'` (impersonation) `[VERIFIED-FROM-CODE: a2a-manager.ts:162-171]` |
| 3f | Delegation | `/delegate claude-code tools=ledger_query budget=0.05 ttl=3600`, then `/grants <hash>` | `chain: VERIFIED to human root`; `/grants` lists it `[VERIFIED-FROM-CODE: slash-commands.ts:505-553]` |

---

## Summary of surprising trust requirements

1. **No `a2a` CLI** — A2A is daemon-internal, driven by `/a2a` slash commands and
   the file mailbox; the only agent-facing CLI subcommand is `mcp serve`.
2. **Unsigned ≠ rejected.** The daemon does not reject an inbound envelope merely
   for being unsigned; it only flags a *present-but-invalid* signature as
   impersonation. Missing-signature handling is lenient by design.
3. **Signatures are self-describing.** A valid signature proves key-possession,
   not peer identity/trust. Trust is conferred separately by the **allowlist**
   (outbound approval gate) and by **delegation certificates rooted at a human
   grant** (`issuer==='human' && humanApproved===true`).
4. **Reply asymmetry.** Inbound is one shared `inbox.jsonl`; replies are per-peer
   under `<dir>/<peer>/outbox.jsonl`, ingested only on `/a2a poll`.
5. **`handoff` always needs approval**, even from an allowlisted peer.
6. **WS mode is listener-only** in the headless build (no outbound dialing).

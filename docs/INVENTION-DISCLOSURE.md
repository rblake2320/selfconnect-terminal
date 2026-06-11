# Invention Disclosure Record — SelfConnect Terminal

> **Purpose.** This is an invention-disclosure record prepared to support a U.S.
> provisional patent application. It documents the inventive mechanisms, their
> implementation in this codebase (with source-file citations), and a dated
> reduction-to-practice log. Every claimed mechanism below was cross-checked
> against the actual source on the default branch (`master`); nothing is claimed
> that is not implemented. See the **Legal note** at the end.

---

## Title

**System and method for governed agent-to-agent communication using a real
terminal as the communication medium, with a single identity-stamped recording
choke point feeding a cryptographic hash-chained audit ledger.**

## Inventor

R. Blake (GitHub `rblake2320`), Montgomery, Alabama, USA.

## Field

Computer security and artificial-intelligence orchestration; specifically,
governed communication and auditable delegation between autonomous software
agents (AI agents) operating through interactive terminal (PTY/ConPTY)
environments.

## Background / problem

Autonomous AI agents increasingly need to cooperate. Existing approaches connect
agents through bespoke APIs or message buses, which (a) require each agent to
expose a special protocol endpoint, (b) bypass the human-facing surface the agent
already drives, and (c) typically lack a tamper-evident, identity-attributed
record of *what each agent did and on whose authority*. There is no widely used
mechanism that lets one AI talk to another **through the very terminal the second
AI already runs in**, while funneling every action through one governance choke
point and producing a cryptographically verifiable audit trail with
human-rooted authority.

## Summary of the invention

The invention treats **the interactive terminal itself as the communication
medium** between agents: a first party injects keystrokes into a second agent's
real PTY/ConPTY (writing message text, waiting, then transmitting the Enter
keystroke as a *separate* event) and reads the reply back from the terminal's
output stream — with no human relaying messages and no direct API handshake
between the two agents. Layered on this medium is a governance architecture in
which (1) a single identity-stamped `record()` choke point appends every event
to a SHA-256 hash-chained append-only ledger; (2) Ed25519 agent identities and
human-rooted delegation certificate chains authorize actions; (3) Merkle-rooted,
signed "agent passports" allow selective, privacy-preserving disclosure of work
history; (4) a context-economy subsystem tiers, deduplicates, and locally
distills context to reduce token cost; and (5) a harness-lab subsystem scores
competing harness configurations purely from slices of the audit ledger.
Optional structured side-channels (a read-only MCP server; a signed, hash-chained
file/socket envelope protocol) provide alternative governed transports.

---

## Detailed description of the inventive mechanisms

Each mechanism is stated in claim-style language: an **independent
claim-like statement** followed by **dependent variations**, with citations to
the implementing source modules.

### Mechanism A — Terminal-as-medium keystroke-injection communication (CORE)

**Independent statement.** A method of communication between a first software
agent and a second software agent, wherein the second agent executes inside an
interactive pseudo-terminal (PTY/ConPTY), comprising: writing message text into
the second agent's terminal input stream as a first transmission; waiting a
delay interval; transmitting an Enter/carriage-return keystroke as a *separate,
second* transmission to cause the second agent to submit the line; and reading
the second agent's response from the terminal's output stream — such that the
agents communicate over the terminal medium itself without a human relaying
messages and without a direct application-programming-interface handshake between
the two agents.

**Implementation.** The terminal is hosted by `PtyManager`, which spawns a
ConPTY child of `COMSPEC` on Windows or `$SHELL` on POSIX
(`src/daemon/pty-manager.ts:23-28,48-65`) and exposes a single atomic input
primitive `write(data)` (`src/daemon/pty-manager.ts:67-69`). The governed input
entry point validates and forwards keystrokes and, *only when the write contains
`\r`/`\n`*, treats it as a submitted line for inspection/recording
(`electron/main.ts:71-77`). Because `write` is atomic per call, the
"text → wait → Enter" behavior is realized as two separate `write` invocations
with a delay between them; the separate Enter transmission both submits the line
to the hosted agent and triggers governance.

**Dependent variations.**
- The terminal hosts a third-party interactive AI agent (e.g. Claude Code) as an
  ordinary child process, so the host need not modify or instrument the hosted
  agent. (`pty-manager.ts` spawns an unmodified shell/agent.)
- The waiting interval is tuned to the hosted agent's input handling to avoid
  racing text against the line submission.
- Input lines beginning with a reserved prefix (`/`) are intercepted before
  reaching the terminal and never executed as shell, instead dispatching governed
  commands (`src/daemon/slash-commands.ts:7-15,84-308`).
- The submitted line is inspected for risk before/as it is recorded
  (`electron/main.ts:74` → `daemon.inspectInput(...)`).

### Mechanism B — Single identity-stamped recording choke point + SHA-256 hash-chained ledger

**Independent statement.** A governance method comprising a single recording
function through which all governed events pass, the function stamping each event
with a multi-part identity (sessionId, runId, agentId), publishing it to an event
bus, and appending it to an append-only ledger in which each entry stores a
cryptographic hash computed over the entry's canonical content concatenated with
the immediately preceding entry's hash, such that any insertion, deletion,
mutation, or reordering of entries is detectable by recomputation from a genesis
value.

**Implementation.** `Daemon.record(type, payload, agentName)` mints a runId,
stamps identity, publishes to the bus, and appends to the ledger — "single choke
point" (`src/daemon/daemon.ts:254-264`). `AuditLedger.append()` computes
`sha256(canonical(entry) )` where `canonical` fixes field order and includes
`prevHash`, and writes one JSON line per entry; `verifyChain()` recomputes from
`GENESIS_HASH = '0'.repeat(64)` and reports the first divergent index
(`src/daemon/audit-ledger.ts:12-34,73-127`).

**Dependent variations.**
- Governance stages (policy evaluation, human approval gating, secret redaction)
  execute upstream and funnel their outcomes through the same `record()` choke
  point, so the ledger captures blocks, approvals, and redaction counts as
  first-class events (e.g. `policy.block`, `redaction.applied`,
  `risk.detected` recorded via `record()` throughout `src/daemon/daemon.ts`).
- The canonical serialization deliberately excludes the entry's own hash to make
  hashing reproducible across processes/platforms
  (`src/daemon/audit-ledger.ts:14-30`).
- The same hash-chain construction is reused for per-peer message chains
  (Mechanism F) (`src/daemon/adapters/bpc-envelope.ts:18-95`).

### Mechanism C — Ed25519 agent identities with human-rooted delegation certificate chains

**Independent statement.** A method of authorizing agent actions comprising:
minting, per agent, an Ed25519 key pair whose private key never leaves the
governing process; issuing delegation certificates each signed by an issuer's key
and naming a grantee, a scope (permitted tools, spend budget, expiry, data
classes), and a parent certificate; and authorizing an action only if the
certificate chain from the acting agent's grant terminates at a root certificate
whose issuer is a designated human root and which is marked human-approved, with
the effective scope computed as the intersection of scopes along the chain.

**Implementation.** `AgentKeystore` mints/stores Ed25519 keys
(`<dir>/<agentId>.pem`, mode 0o600) and signs/verifies detached signatures that
carry their own public key hex (`src/daemon/agent-keys.ts`). `DelegationRegistry`
issues certificates (`issue()`), and `verifyChain()` walks `parent` links,
verifying each content hash and signature, checking expiry, intersecting scopes,
and requiring at the terminus `issuer === HUMAN_ROOT ('human')` and
`humanApproved === true` (`src/daemon/delegation.ts:31,100-127` and the
`verifyChain`/`authorize` methods following). The daemon establishes the
human→system root grant once at startup (`parent: null, humanApproved: true`)
(`src/daemon/daemon.ts:234-251`).

**Dependent variations.**
- Signatures are stateless/self-describing (embed `publicKeyHex`), enabling
  third-party verification without prior key exchange
  (`SignatureSchema` in `src/shared/contracts.ts`; `agent-keys.ts`).
- Scope data classes are drawn from an ordered set (public/internal/secret/cui)
  and intersected down the chain (`src/daemon/delegation.ts` `intersectScopes`).
- Human-facing issuance/verification via `/delegate` and `/grants`
  (`src/daemon/slash-commands.ts:505-553`).

### Mechanism D — Merkle-rooted signed agent passports with selective reveal

**Independent statement.** A method of attesting an agent's work history
comprising: deriving a stable leaf hash for each audit-ledger entry; constructing
a Merkle tree over the leaves; signing the Merkle root together with summary
statistics using the agent's Ed25519 key to form a passport; and later disclosing
any individual entry by providing that entry's leaf and a Merkle inclusion proof,
which a verifier checks by recomputing the signed root — thereby proving
particular history selectively without revealing the entire record.

**Implementation.** `src/daemon/passport.ts`: `leafHash()` (`:30-32`),
`buildMerkle()` (`:39-57`), `merkleProof()` (`:60-72`), `rootFromProof()`
(`:75-81`), `buildPassport()` (signs root + summary), `revealLeaf()` /
`verifyReveal()` (`rootFromProof(...) === passport.merkleRoot`), and
`verifyPassport()` (signature + signer-identity check). Human-facing via
`/passport [verify]` (`src/daemon/slash-commands.ts:555-572`) and
`selfconnect passport export|verify` (`src/cli/index.ts`).

**Dependent variations.**
- The passport carries only summary counts and the root by default (content
  stays private until a leaf is explicitly revealed).
- Odd nodes are promoted (duplicated) for a deterministic tree
  (`passport.ts:46-55`).

### Mechanism E — Context-economy tiering, deduplication, and $0 local distillation

**Independent statement.** A method of reducing the token cost of operating a
language-model agent comprising: maintaining context in tiers including a
verbatim HOT tier, a discounted distilled WARM tier, and a pinned tier; measuring
token pressure and compacting oldest HOT context into WARM at a discount;
content-addressing context blobs by hash so identical content is transmitted to a
given provider only once (thereafter sending a compact reference plus a short
digest); and distilling a turn into durable knowledge using a *local* model when
available and a deterministic heuristic otherwise, so distillation incurs no
external cost and never leaves the machine.

**Implementation.** `ContextGauge` tracks HOT/WARM/pinned tiers, pressure levels,
and `compactHotToWarm()` (`src/daemon/context-gauge.ts:37-75`). `ContextStore` is
a SHA-256 content-addressed blob store with per-provider dedup via
`prepareForSend()` reporting `tokensSaved`
(`src/daemon/context-store.ts:44-150`). `SessionKnowledgeStore.distill()` uses a
local provider (e.g. Ollama) when reachable and a deterministic
`heuristicDistill()` fallback otherwise — $0 either way
(`src/daemon/session-knowledge.ts:73-131`). Surfaced via `/context`
(`src/daemon/slash-commands.ts:234-247`).

**Dependent variations.**
- Recommended actions escalate with pressure (compact → dedup → migrate)
  (`context-gauge.ts`).
- Dedup references are reused across agent handoffs so the same bytes are not
  re-billed (`context-store.ts:130-150`).

### Mechanism F — Harness-lab scoring from audit-ledger slices

**Independent statement.** A method of comparing agent-harness configurations
comprising: executing the same task under two or more harness "arms" that differ
in configuration (toolset, context policy, model/provider, permission mode), each
arm tagged with a distinct run identifier within one session; and scoring each
arm by a pure, deterministic function of the slice of the audit ledger bearing
that arm's run identifier (e.g. turns, estimated tokens, cache-hit rate, tool
error rate, approvals, wall time, success) — so scores derive solely from the
tamper-evident record and are reproducible offline.

**Implementation.** `src/daemon/lab.ts`: `ArmRunObservation` carries the
per-arm `ledgerSlice`; `scoreArm()` is a pure scorer over that slice (`:55-94`);
`rescoreFromLedger()` reconstructs scores from `lab.arm` marker events in a full
session ledger (`:142-170`); `renderComparison()` renders a side-by-side table
(`:101-134`). Surfaced via `/lab run|report` (`src/daemon/slash-commands.ts:315-341`)
and `selfconnect lab run|report` (`src/cli/index.ts`).

### Mechanism G (supporting) — Read-only MCP governance server

A read-only Model Context Protocol server exposes governed *queries*
(ledger_verify, ledger_query, session_list, cost_report, redact_text,
review_request) over newline-delimited JSON-RPC, and never executes shell or
mutating tools (`src/mcp/server.ts:10-14,25-47,51-104`). Described as a side door,
not the core medium.

### Mechanism H (supporting) — Signed, hash-chained envelope transport (BPC over TSK)

A structured envelope protocol (`bpc:'1.0'`) carries identity-stamped, optionally
Ed25519-signed messages whose per-peer SHA-256 hash chain detects
tamper/reorder/drop, transported over either a file mailbox or a WebSocket
listener (`src/daemon/adapters/bpc-envelope.ts`, `tsk-transport.ts`,
`a2a-manager.ts`). Trust is conferred by an allowlist and by Mechanism C's
human-rooted delegation, not by the mere presence of a signature. Side door.

---

## Reduction-to-practice log

Verified events, reproduced verbatim from the raw evidence file
(`build-artifacts/patent-evidence-raw.md`), recorded 2026-06-10 (America/Chicago).
Machine: Windows 11 Pro 26200, RTX 5090, Node v24.3.0, Electron 31, VS 2022 Build
Tools, Ollama 0.24.0. Relevant commits (all pushed to origin): `fb703a8` (Windows
runbook), `18c35ad` (durable Windows fixes, ws dep, Spectre patch script),
`8ae3889` (sandboxed-preload fix; mock compiled out of real bundle; 244 tests).

1. ~18:09–18:20 CDT: node-pty rebuilt against Electron 31 ABI on Windows; real
   ConPTY child spawned and returned live data ("NODE_PTY_OK spawn=function
   exit=0 sawData=true").
2. 236/236 tests passed natively on Windows (33 files); typecheck and production
   build clean.
3. Headless daemon proofs on Windows: `ledger verify` -> chainOk:true,
   checkpointsOk:true; /cost real cost kernel; `passport export` -> signed
   Merkle-rooted passport, live ed25519 signature.
4. ~18:49 CDT: AI-to-AI terminal exchange via SelfConnect injection protocol: an
   interactive `claude` (Claude Code v2.1.156, Claude Max subscription, NOT API)
   hosted inside a real ConPTY; message injected (text -> wait -> \r separately);
   genuine reply read back: "Received — current working directory is
   C:\Users\techai." Zero human relay.
5. ~18:53–18:57 CDT: After commit 8ae3889 pull+rebuild, real GUI verified live:
   no SIMULATED banner; real session header (sess_a1b02af8…); real cmd.exe ConPTY
   pane executed `echo input-check`; on-disk ledger grew 25 -> 26 entries (hash
   …b6565563c8f5 visible in UI); then Claude Code launched INSIDE the governed
   pane ("Welcome back Ron!", Opus Plan · Claude Max), i.e., a third-party AI
   agent operating inside a governed, hash-chained-ledger terminal.

**Mapping of events to mechanisms.** Event 1 and 5 reduce **Mechanism A**
(terminal-as-medium; event 4 specifically demonstrates the inject→wait→separate-
Enter→read-back protocol). Events 3 and 5 reduce **Mechanism B** (hash-chained
ledger, `verifyChain`, ledger growth 25→26). Event 3 reduces **Mechanism C**
(ed25519 signing) and **Mechanism D** (signed Merkle passport). Test/build runs
(event 2) exercise Mechanisms E, F, G, H per their cited tests in `tests/`.

## Corroboration trail

- Git commit timestamps + GitHub push history (third-party hosted).
- Screenshots taken on the machine (sc-crop.png, sc-claude-zoom.png in working
  tree) + Perplexity Computer session thread.
- WINDOWS-RUN-FINDINGS.md on machine + Owner's Inbox copy; docs/WINDOWS-FINDINGS.md
  in repo.
- This repository's source modules cited inline above; the test suite
  (`tests/`, 249 tests passing on the default branch) provides repeatable
  corroboration of Mechanisms B–H.

## Legal note

GitHub commits are evidence of conception/reduction to practice with timestamps,
**NOT** patent protection. US is first-to-file: public disclosure before filing
can destroy foreign rights and starts the 12-month US grace period. Repo is
private — keep it private until a provisional application is filed. This doc is
an invention-disclosure record to support a provisional filing, not legal advice.

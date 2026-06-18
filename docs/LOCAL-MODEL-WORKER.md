# Local Model Worker

Last updated: 2026-06-18

## Why This Exists

The visible local-model repair test proved that a small local Ollama model can
choose a useful action and fix a sandbox bug. It also exposed the important gap:
typing a status line into an active Codex/Claude terminal is only visual delivery.
If that agent is busy, the line may sit in the input queue and never become a
clean back-and-forth ACK.

So the terminal needs a worker pattern:

```text
local model output
  -> strict JSON plan
  -> validator
  -> sandbox tool executor
  -> verifier/test
  -> durable outbox/inbox
  -> optional visible SelfConnect send
```

The model gets smarter because the wrapper is strict. It does not need to be a
frontier model to do useful work.

## Implemented Module

```text
src/daemon/local-model-worker.ts
```

It provides:

- JSON extraction from fenced/weak model output.
- `validateRepairPlan(...)` for a constrained two-step repair plan.
- `applyRepairPlan(...)` with sandbox path checks and exact old-text matching.
- `buildOutboxRecord(...)` and `appendOutboxRecord(...)` for durable coordination.
- `classifyTool(...)` so MCP/network claims stay honest.

Tests:

```text
tests/local-model-worker.test.ts
```

## Live Baseline

Run a real local-model action baseline:

```text
npm run baseline:local -- --model hermes3:3b
```

On 2026-06-18 this machine produced:

```text
model: hermes3:3b
verdict: PASS
tasks: 2/2 repaired and test-confirmed
artifact: docs/results/local-model-baseline-hermes3_3b-1A4DEB31.json
```

The baseline performs real actions:

- calls local Ollama on `127.0.0.1`;
- asks the model for a strict JSON tool plan;
- validates and safely canonicalizes the file target inside a temp sandbox;
- applies `replace_text` only when the exact old text occurs once;
- reruns failing Node tests before and after the repair;
- writes a durable `outbox.jsonl` status record.

Hermes needed one retry on the addition task because the first response used an
unsafe file path. The wrapper rejected it, fed the validation error back into the
local model, accepted the corrected plan, and the test went green.

## Visible Chat Baseline

Run a local model in a real visible terminal and have it talk to a guarded Codex
terminal:

```text
npm run chat:local -- --model hermes3:3b --codex-hwnd <hwnd> --codex-title "codex 1"
```

On 2026-06-18 this machine produced a visible two-way run:

```text
local window: LOCAL-OLLAMA-CHAT-C4D7091D
model: hermes3:3b
target: codex 1
result: local -> Codex send PASS, Codex -> local reply PASS, local -> Codex reply PASS
transport: guarded SelfConnect Win32 send, no hidden headless-only step
```

For Codex/Claude-style terminal UIs, the visible chat harness uses a two-step
send path:

```text
guarded type -> submit_claude_input(hwnd) dual WM_CHAR Enter -> require True
```

Do not treat `chars_sent` as proof that the agent received the message. It may
only mean the text landed in the input box. The harness now fails loud unless
the submit primitive returns `True`.

Observed limits:

- without Ollama JSON mode, Hermes returned malformed JSON three times;
- with JSON mode, Hermes returned valid JSON but omitted the nonce until the
  wrapper appended it;
- when asked for a safe file-repair plan, Hermes gave a generic repair strategy
  instead of a precise SelfConnect tool plan.

That means the right production shape is not "let the small model freely drive
the machine." The right shape is visible model output plus strict wrappers:
JSON mode, validation, target guard, nonce stamping, sandboxed tool execution,
tests, and durable outbox/inbox records.

## Tool Boundary

Safe local tools:

```text
read_file
search_repo
replace_text
run_tests
write_outbox
send_visible_status
```

MCP tools are profile-dependent:

- local MCP server, local-only tools: can be airgap-safe;
- web/research/cloud MCP tools: not airgapped;
- SelfConnect send tools: must keep target verification and allow flags.

## Correct ACK Model

Do not make the prompt input line the source of truth.

Use:

```text
outbox.jsonl: local model writes task/status
inbox.jsonl: receiver writes ACK/response
visible terminal send: optional human proof only
```

That gives normal SelfConnect users speed while preserving traceability for
enterprise/government modes.

## Next Step

Turn this helper into a long-running local role:

```text
LOCAL-OLLAMA-1
  poll inbox
  plan with local model
  validate plan
  run local tools
  write outbox
  wait for ACK
  optionally send visible status through SelfConnect
```

That is the right place for a small model inside the SelfConnect terminal.

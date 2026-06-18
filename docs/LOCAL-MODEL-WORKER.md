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

# Governed desktop assist

Status: implemented desktop-assist MVP. Windows installed acceptance and exact-input readback passed; see [verification](verification/2026-09-22/computer-use.md). Paid adapter tests use substituted responses; no live paid inference was run.

Desktop assist is an optional executor beside terminal injection, MCP, shell and A2A. It reuses the existing tool registry, identity, approvals, ledger and Python SelfConnect operations. It does not replace terminal-as-medium injection.

## Local operation

Select a window in Desktop assist, request a session, approve it, then observe before acting. Each operation is a high-risk `computer_use` registry call, including in auto mode; plan mode refuses it. The target binds HWND, PID, executable, class and title. Every action binds the latest observation and next sequence. Sessions have an action limit and expiry. Focus loss stops input; clicking Approve in SCT may restore focus only from that exact SCT approval window.

Observe, focus, click, type, supported key combinations, scroll (positive down, negative up), bounded wait and finish are available. Stop interrupts subsequent work and checks between typed characters. Window capture uses PrintWindow without an unrelated-desktop capture fallback. PNGs remain in private application evidence storage; the ledger records hashes and references. Pixel changes are evidence of changed pixels, not semantic task completion. Unknown or partial execution must be inspected before retrying.

The UI provides manual operations. A subscription CLI can reason about a screenshot and supply a proposed action, but this release does not automatically attach to a CLI subscription or use its credentials as an API key. There is no automatic model retry or paid fallback.

## Separately billed suggestions

Default: OFF. Building and substituted-transport testing do not enable paid usage.

Runtime requires all of:
- Explicit `SELFCONNECT_COMPUTER_PAID_API=1` in the launching environment, a separate `ANTHROPIC_API_KEY`, and local-only disabled.
- A new paid session with explicit acknowledgment that API billing is separate from subscriptions, naming provider, model, rates and caps.
- Approval of each individual screenshot upload/model request, showing the request cap. Model suggestions require another approval before execution.

Default UI consent caps: $25 project, $2 session, $0.50 task; each request at most $0.25, additionally constrained by the app policy. One task is one desktop session; its tighter task cap applies cumulatively. No more than 30 model requests per session or 15 minutes. Reservations persist at the normal per-user SelfConnect Terminal budget location, shared across isolated app profiles. Timeout, invalid response and interrupted requests retain the reservation. A locked/corrupt budget refuses calls. Actual usage above a reservation locks further billing.

Reservation estimates are conservative engineering estimates, not provider-enforced dollar limits or invoice guarantees. An already-sent request may be billed even after Stop; Stop discards its proposal and prevents later execution. For zero API charges, leave paid mode disabled. App cost totals include completed desktop charges and uncertain request reservations; they do not measure subscription CLI billing or unrelated external clients.

The Anthropic adapter is tested with substituted HTTP responses. Live paid inference is intentionally not executed without a specific spending decision. It validates image dimensions, model identity, output size and action fields, and offers only the first action from a response batch for review; further steps require a new observation. Screenshots are not automatically scrubbed of secrets: review the captured window before explicitly approving its upload. Credential insertion, automatic redaction, unattended loops and multi-window workflows are not included.

## Reproduce

`npm run typecheck` and `npm test` cover schemas, adapter refusals, billing persistence and controller boundaries. `npm run dist:local` packages the driver as an extra resource. Python with SelfConnect MCP dependencies must be installed. Run `scripts/computer-use-partner-acceptance.cjs` with `SCT_TEST_EXE` set to the installed executable for benign local desktop acceptance; it must keep paid mode disabled and preserve other application windows.

## Sources

- [Anthropic computer-use client toolset](https://platform.claude.com/docs/en/agents-and-tools/tool-use/computer-use-tool)
- [Anthropic pricing](https://platform.claude.com/docs/en/about-claude/pricing)
- [Anthropic vision token accounting](https://platform.claude.com/docs/en/build-with-claude/vision)
- [NVIDIA DFlash research](https://developer.nvidia.com/blog/boost-inference-performance-up-to-15x-on-nvidia-blackwell-using-dflash-speculative-decoding/): a possible future local-inference optimization. Its headline is not a measurement of this terminal or the owner's RTX 5090; no GPU services or inference stack were changed for this feature.

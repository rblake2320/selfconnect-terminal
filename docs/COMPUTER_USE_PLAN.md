# Proposed computer-use executor

Status: design proposal, not implemented or included in today's runtime claims.

Owner constraint: subscription-only. No paid model APIs, including Jev, Anthropic
or OpenAI API calls. Use the existing authenticated CLI subscriptions; assess
which computer-use capabilities are actually available through them before
promising a model adapter. Do not enable API fallback or paid live acceptance.

Computer use can be a selectable executor behind the existing identity, tool
permission, approval and ledger interfaces. The executor owns local observation
and action; a model proposes structured actions. Keep this distinct from native
terminal messaging, MCP transport and the legacy app mailbox.

Reuse verified pieces: guarded native HWND/PID/executable/class identity checks,
window capture, actual UI Automation readback, Core MCP interoperability, shared
tool permission gates and ledger records. The statement that Core is only pixels
and keystrokes is inaccurate: UIA readback was exercised in the installed tests.
The terminal does not yet implement a general API -> DOM -> visual executor
selection policy, a screenshot-to-action model loop or a credential broker.
Do not infer click/focus/scroll MCP tools from successful doctor/tools-list tests;
inventory and validate the exact driver's available operations first.

Proposed bounded implementation:
1. Provider-neutral observation/action schemas with strict validation, coordinate
   bounds, a single allowed target window, and stale-observation/identity checks.
2. A high-risk governed computer-use tool routed through the shared registry;
   plan refusal and explicit approval before mutation, with a visible stop control.
3. An adapter to verified existing Core operations, adding only missing actions.
4. Per-action evidence linking observation hash, proposal, policy decision,
   execution result and post-action observation. Validate screenshot capture/redaction
   before any external provider receives data.
5. One model adapter and a bounded observe/propose/validate/execute/verify loop.
   Use a verified subscription-hosted agent path only; paid live calls are excluded.
6. Installed-artifact acceptance on a benign owned test application, including
   wrong/stale target refusal, rejected action without side effects, focus loss,
   stop, timeout and crash recovery. Add a second adapter only after this passes.

Credential insertion/redaction, automatic retries/failover and multi-application
workflows require their own design and acceptance. A model's proposed action is
not authorization, execution success, or independent verification.

Research references supplied with the proposal, to recheck during implementation:
- https://platform.claude.com/docs/en/agents-and-tools/tool-use/computer-use-tool
- https://platform.openai.com/docs/guides/tools-local-shell

No new provider key, cloud computer-use call or computer-use runtime was created
as part of the 2026-09-22 terminal verification and GitHub capture.

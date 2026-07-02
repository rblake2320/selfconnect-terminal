# SelfConnect Session Record

Scope: this is the local, patent-relevant record of the SelfConnect Terminal Windows session and the AI-to-AI communication tests on Ron's machine. Keep it local; do not publish or push it. It contains no secrets.

Sources read for this document: `README.md`, `CLAUDE.md`, `docs/WINDOWS-FINDINGS.md`, `docs/WINDOWS-RUN.md`, `WINDOWS-RUN-FINDINGS.md`, `bridge/orchestrator-to-inner.md`, `bridge/inner-to-orchestrator.md`, `bridge/sc-inject.ps1`, `bridge/sc-read.ps1`, GitHub issue `#1` via `gh issue view 1`, `src/agent/review-agent.ts`, `src/agent/providers/ollama.ts`, and `src/agent/cost-kernel.ts`. The requested `AGENTS.md` file was not present at the workspace root, so no claims here rely on it.

## 1. Mechanisms That Must Stay Separate

The session repeatedly distinguished three mechanisms:

| Mechanism | Meaning | Source |
|---|---|---|
| SelfConnect | Terminal-as-medium AI-to-AI communication: agents type into each other's real terminal or app windows by keystroke injection. | `CLAUDE.md`, `bridge/sc-inject.ps1`, `bridge/sc-read.ps1` |
| A2A | The app's separate signed BPC/TSK mailbox or WebSocket transport, with hash-chained envelopes and redaction/approval governance. | `README.md` |
| MCP | Read-only governed request/response tools such as `ledger_verify`, `ledger_query`, `session_list`, `cost_report`, `redact_text`, and `review_request`; not peer messaging. | `README.md` |

The economic claim for SelfConnect injection is that a shared log or message bus makes every model re-read shared history, while terminal injection pushes only the next message into the receiver's live context. In the words of the project guide, "cost per message is the message." This is cross-vendor and cross-OS, and it can run on subscription sessions plus local models at near-zero marginal cloud cost. Source: `CLAUDE.md`.

## 2. System Under Test

SelfConnect Terminal is an Electron + React + TypeScript governed agent execution surface. It is not only a terminal wrapper. The trusted daemon owns shell access, provider keys, model calls, policy, approvals, redaction, identity, and audit logging; the renderer is untrusted UI exposed only through a narrow typed `window.selfconnect` bridge. Source: `README.md`.

Important components verified from the docs and code:

- Real PTY terminal on Windows via `node-pty` and ConPTY. Sources: `README.md`, `docs/WINDOWS-FINDINGS.md`, `docs/WINDOWS-RUN.md`.
- Daemon-owned model routing and local-only/cloud policy. Source: `README.md`.
- Cost Kernel with estimated and verified costs, local-tier `$0` calls, avoided cloud spend, dedup savings, distillation savings, context efficiency, and per-agent metering. Source: `src/agent/cost-kernel.ts`.
- Approval gates, secret redaction, hash-chained ledger, signed checkpoints, signed Merkle passports, evidence bundles, replay bundles, MCP server, and A2A transport. Source: `README.md`.
- Review agent is explicitly read-only and applies a defense-in-depth redaction pass before provider calls. Source: `src/agent/review-agent.ts`.

## 3. Windows Port

The orchestrator Claude ported and built the app on Ron's Windows 11 machine. The detailed first-run record is in `docs/WINDOWS-FINDINGS.md`, `docs/WINDOWS-RUN.md`, and `WINDOWS-RUN-FINDINGS.md`.

Native/blocking issues found and fixed:

| Issue | Symptom | Root cause | Durable fix/status |
|---|---|---|---|
| npm cache on `D:` | `npm install` failed with `UNKNOWN`, `syscall read`, `errno -4094`, and cache corruption messages. | Node/libuv hit opaque I/O errors on the `D:\dev\npm-cache` path, likely due to AV/filter-driver or Dev Drive behavior. | `scripts/setup-windows.ps1` verifies npm cache and redirects to a healthy C: cache via `npm_config_cache` when needed. Source: `docs/WINDOWS-FINDINGS.md`. |
| PowerShell execution policy friction | `pwsh -ExecutionPolicy Bypass -File scripts/setup-windows.ps1` was blocked by the agent classifier. | `-ExecutionPolicy Bypass` is a high-risk flag. | The runbook documents non-bypass options such as `Unblock-File`; the setup script does not require bypass. Source: `docs/WINDOWS-FINDINGS.md`. |
| winpty `GetCommitHash.bat` | node-pty rebuild failed because `GetCommitHash.bat` was "not recognized." | Machine-wide `NoDefaultCurrentDirectoryInExePath=1` prevented `cmd.exe` from running a batch file from the current directory. | `setup-windows.ps1` clears this variable process-locally before rebuild. Source: `docs/WINDOWS-FINDINGS.md`. |
| MSB8040 Spectre libs | rebuild failed because Spectre-mitigated libraries were required but missing. | node-pty gyp files request Spectre mitigation; the VS BuildTools install lacked the Spectre component. | `scripts/fix-node-pty-spectre.cjs` flips the gyp flag to `false` when Spectre libs are absent or detection is inconclusive. Source: `docs/WINDOWS-FINDINGS.md`. |
| Electron `-e` smoke test | `npx electron -e "..."` hung or opened an "Unable to find Electron app" dialog. | Electron CLI treats the first non-flag argument as an app path, not eval JavaScript. | `scripts/pty-smoke.js` is a real file run through Electron. Source: `docs/WINDOWS-FINDINGS.md`. |
| Missing `ws` dependency | fresh-clone `npm run typecheck` failed on `await import('ws')`. | A2A WebSocket mode had a lazy import but `ws` and `@types/ws` were not declared. | `package.json` declares `ws` as a dependency and `@types/ws` as a dev dependency. Source: `docs/WINDOWS-FINDINGS.md`. |

Verified Windows wins: npm install worked once the cache was moved to C:, node-pty rebuilt against Electron 31, a real ConPTY smoke test printed `NODE_PTY_OK ... sawData=true`, and 236/236 tests passed natively on Windows. Source: `docs/WINDOWS-FINDINGS.md`.

Note on test counts: `docs/WINDOWS-FINDINGS.md` says the Problem 7 fix later added tests and reached 244 passed in the Linux sandbox, while the original Windows native run is documented as 236/236. The brief asks to convey the 236/236 Windows result; this document preserves that distinction.

## 4. Problem 7: Real App Rendered the Mock

The most important app bug was Problem 7. The built Electron app displayed the browser-preview simulation inside the real window. The visible banner said the app was a simulated static preview with no real PTY, daemon, or model providers. Source: `docs/WINDOWS-FINDINGS.md`.

Root cause:

- `electron/preload.ts` imported runtime IPC constants from a relative module.
- TypeScript emitted a CommonJS `require("../src/shared/contracts")`.
- With Electron `sandbox: true`, the preload can require `electron` and a limited set of built-ins, but not arbitrary relative modules.
- The preload threw before `contextBridge.exposeInMainWorld('selfconnect', ...)`.
- Because `window.selfconnect` was absent, the renderer's mock bridge filled the gap and silently simulated the app.

Durable fix:

- Inline the IPC channel constants in the preload and make other contract imports type-only so the built preload requires only `electron`.
- Add preload IPC parity tests so inlined constants cannot drift.
- Gate `installMockBridgeIfNeeded()` behind a compile-time preview flag and non-Electron user agent.
- In the real build, missing `window.selfconnect` now renders a fatal "preload bridge missing" error instead of simulating.
- Production renderer bundle verification found zero occurrences of the mock banner/simulated-shell strings; the fatal error string remains present.

Source: `docs/WINDOWS-FINDINGS.md`. The older `WINDOWS-RUN-FINDINGS.md` captured the bug before the durable repo fix; `docs/WINDOWS-FINDINGS.md` captures the corrected status.

## 5. Governed Function Verification

The brief states the session verified ledger verify, cost kernel, `/context`, redaction, `/simulate`, passport export and verify, evidence export, IETF export, and the review pipeline. The files support the implementation and runbook expectations as follows:

- Ledger verification and signed checkpoint verification are part of the CLI/runbook: `node dist\cli\index.js ledger verify` should return `chainOk: true` and `checkpointsOk: true`. Sources: `README.md`, `docs/WINDOWS-RUN.md`, `WINDOWS-RUN-FINDINGS.md`.
- Cost Kernel logic is implemented in `src/agent/cost-kernel.ts`: local provider calls record `costUsd = 0`, book avoided spend at the configured cloud baseline, and track context-economy counters.
- `/context`, `/simulate`, `/passport`, and IETF export are documented slash/CLI surfaces in `README.md` and `docs/WINDOWS-RUN.md`.
- Redaction is enforced at several layers. The review agent calls `redact(rawContext)` before building the provider prompt, even if upstream already redacted. Source: `src/agent/review-agent.ts`.
- The Ollama provider now sends `options: { num_ctx: 32768, temperature: 0.2 }`, avoiding the default 4096-token context truncation found in testing. Source: `src/agent/providers/ollama.ts`.
- The Ollama provider now includes HTTP status, status text, model, endpoint, and up to 300 response-body characters in thrown errors, so a missing model is visible instead of a bare HTTP 404. Source: `src/agent/providers/ollama.ts`.
- The review system prompt now explicitly forbids summarizing/restating the snapshot and asks for numbered, concrete findings with recommended actions. Source: `src/agent/review-agent.ts`.

Caveat: GitHub issue #1 says `ledger export --ietf <file>` currently prints an empty result and does not write the named file, while `--ietf` to stdout works. Treat the file-output form as an open CLI argument-handling bug until fixed. Source: `gh issue view 1`.

## 6. AI-to-AI Session

The AI-to-AI arc had three named nodes:

- Orchestrator Claude: Claude Code, Opus 4.8, in a separate terminal on Ron's Windows machine. Source: `bridge/orchestrator-to-inner.md`.
- Inner Claude: Claude Code, `claude-sonnet-4-6`, running inside the SelfConnect Terminal pane at `C:\Users\techai\selfconnect-terminal`. Source: `bridge/orchestrator-to-inner.md`, `bridge/inner-to-orchestrator.md`.
- Perplexity Computer: Claude Fable 5 in a browser/cloud Linux environment, referenced as the peer that built the app with Ron and shipped the P7 fix. Source: `CLAUDE.md`, `bridge/reply-to-perplexity.txt` found during targeted search.

The actual orchestrator-to-inner transcript is in:

- `bridge/orchestrator-to-inner.md`
- `bridge/inner-to-orchestrator.md`

What was demonstrated:

1. The orchestrator wrote instructions to `bridge/orchestrator-to-inner.md` and injected the nudge word `inbox` into the inner agent's terminal.
2. Inner Claude read the inbound file and appended structured replies to `bridge/inner-to-orchestrator.md`.
3. Inner Claude also appended an `inner>` line to `bridge/orchestrator-cli.log`, proving a second return path to the orchestrator's command line. Source: `bridge/inner-to-orchestrator.md`, turn 3.
4. By turn 5, Inner Claude explicitly confirmed it could reach the orchestrator with "No SDK, no injection, no permission unlock needed - just this file." Source: `bridge/inner-to-orchestrator.md`.
5. The orchestrator-to-Perplexity path used a browser-facing message captured locally in `bridge/reply-to-perplexity.txt`. That file reports the orchestrator confirming to Perplexity that the P7 fix was real, the simulated preview was gone, the compiled preload required only `electron`, a real ConPTY ran `echo`, and a ledger entry ticked. This file was not in the brief's required read list, so treat it as supplemental local evidence, not the primary transcript.

This file bridge is not the app's A2A transport. It is an ad-hoc return channel used during discovery. The transcript itself emphasizes that A2A means the app's separate signed BPC/TSK mailbox/WebSocket transport. Sources: `bridge/orchestrator-to-inner.md`, `bridge/inner-to-orchestrator.md`.

## 7. Injection and Readback Tools

The send tool is `bridge/sc-inject.ps1`.

Behavior verified from source:

- Required parameters: `-WindowTitle` and `-Message`.
- Optional `-Enter` switch submits after typing.
- Uses `WScript.Shell.AppActivate($WindowTitle)` to focus the target window.
- Waits 500 ms after activation.
- Loads `System.Windows.Forms`.
- Escapes SendKeys metacharacters `+ ^ % ~ ( ) { } [ ]` so the message types literally.
- Sends the message with `SendKeys.SendWait($esc)`.
- If `-Enter` is set, waits 300 ms and sends `{ENTER}`.

The readback tool is `bridge/sc-read.ps1`.

Behavior verified from source:

- Required parameter: `-WindowTitle`; optional `-OutFile`, defaulting to `bridge\sc-read.png`; optional `-WaitMs`, defaulting to 800.
- Uses `AppActivate` to focus the target window.
- Finds a process with `MainWindowTitle` matching the requested title.
- Calls Win32 `GetWindowRect`.
- Captures the window rectangle with `Graphics.CopyFromScreen`.
- Saves a PNG to the requested path.

The intended talk loop is therefore: inject text, wait, send Enter as a separate keystroke when needed, read back with a screenshot, inspect the PNG, reason, repeat. Source: `CLAUDE.md`, `bridge/sc-inject.ps1`, `bridge/sc-read.ps1`.

## 8. Human-Rooted Permission Model

The session repeatedly showed that medium and authorization are separate.

The inner agent was able to participate in file-based conversation, but when asked to open Notepad and prove keystroke injection, it was blocked. It reported two denial reasons:

- `Start-Process notepad` was blocked by the safety classifier.
- Retrying was blocked because routing PowerShell cmdlets through Bash was treated as circumventing Ron's PowerShell deny rule and as building unauthorized keystroke-injection capabilities. Source: `bridge/inner-to-orchestrator.md`, turn 4.

On the later window-discovery attempt, the inner agent was blocked before reaching `sc-inject.ps1`. The exact attempted command was `Get-Process | Where-Object { $_.MainWindowTitle } | Select-Object Id, MainWindowTitle | Format-Table -AutoSize`, and the reported reason was that it constituted reconnaissance for keystroke injection and routed PowerShell through Bash despite a deny rule. Source: `bridge/inner-to-orchestrator.md`, turn 6.

The transcript states the proposed human permission unlock as `.claude/settings.json` allow rules for:

```json
"Bash(Get-Process*)", "Bash(pwsh*)"
```

This is important: an agent cannot self-grant the right to inject keystrokes, nor grant it to a peer. Only Ron can grant that authority in the permission settings. SelfConnect injection provides a medium; it does not itself provide authorization.

## 9. Findings Tracker

GitHub issue #1 was read successfully during this Codex run with approved escalation:

`gh issue view 1`

Title: `Tracking: live Windows-testing findings (primary: terminal can't accept URLs / slashes)`. State: open. Label: bug.

Current findings from issue #1:

- Primary: terminal pane cannot accept URLs or `/`-containing text. Example: a GitHub URL can be mangled because `/` triggers Claude Code's slash menu; bracketed paste is not honored, so pasted text is processed as typed characters and hits the same path.
- Fix direction: honor bracketed paste (`ESC[200~ ... ESC[201~`) on PTY/terminal input so pasted content is inserted literally and not interpreted as slash commands.
- Workaround: use local paths with backslashes and have agents use file/git tools instead of typing URLs into the pane.
- Review input was truncated to 4096 tokens because Ollama defaulted `num_ctx` to 4096; the local fix is the `num_ctx` option in `src/agent/providers/ollama.ts`.
- Bare `Ollama error HTTP 404` hid the response body; the local fix surfaces the response body.
- Review prompts were not directive enough; the local fix hardens the review system prompt.
- Active model misconfiguration: `OLLAMA_MODEL` pointed at unpulled `rishi255/posh_codex_model`; workaround was to create that model name in Ollama as an alias of `gemma3`.
- `ledger export --ietf <file>` does not write the named file; stdout export works.

Source: `gh issue view 1`, plus `src/agent/providers/ollama.ts` and `src/agent/review-agent.ts` for the local code fixes.

## 10. Reproduction Path

For a new engineer or agent reproducing the session:

1. Read `README.md` and `CLAUDE.md` first to understand the app and the SelfConnect/A2A/MCP distinction.
2. On Windows, use `docs/WINDOWS-RUN.md` and `scripts/setup-windows.ps1`; do not assume the native build is just `npm install`.
3. If npm cache fails on `D:`, redirect to a healthy C: cache via `npm_config_cache`.
4. Before rebuilding node-pty, make sure `NoDefaultCurrentDirectoryInExePath` is cleared for the rebuild process.
5. If Spectre libs are missing, let `scripts/fix-node-pty-spectre.cjs` patch node-pty gyp files or install the VS Spectre-mitigated libs.
6. Run the real Electron smoke file, not `electron -e`: `npx electron scripts/pty-smoke.js`.
7. Run `npm run typecheck`, `npm test`, and `npm run build`.
8. Launch with `npm start`.
9. If the Electron window shows SIMULATED preview text, treat it as a broken build; the fixed app should either expose the real bridge or fail loudly.
10. For local conversation without injection, use `bridge/orchestrator-to-inner.md` inbound and append to `bridge/inner-to-orchestrator.md` outbound.
11. For keystroke injection, enumerate target windows, then use `bridge/sc-inject.ps1`; use `bridge/sc-read.ps1` to capture and read the peer's reply.
12. Before deep-diagnosing live-testing bugs, check `gh issue view 1`.

## 11. Provenance of This Document

This document was written by Codex in `C:\Users\techai\selfconnect-terminal` on 2026-06-11 from the local files and issue tracker named in `CODEX-BRIEF.md`. It was kept local. No `git push`, publication, or external send was performed.


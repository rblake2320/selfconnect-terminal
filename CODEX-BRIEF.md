# CODEX BRIEF — Document the SelfConnect AI-to-AI Session (read this top to bottom, then do it)

You are **Codex** (OpenAI CLI agent), joining a multi-agent session on Ron's Windows machine.
You have **no prior context** — everything you need is in this brief and the files it points to.
Do not assume; read the listed files, then write the document. Work only inside
`C:\Users\techai\selfconnect-terminal`.

## Your single task
Produce one complete, accurate markdown document of everything that happened this session,
written so a new engineer (or a new agent) could understand the system and reproduce it.
Write it to:  `docs\SELFCONNECT-SESSION.md`

## Background you must convey (verify details against the files below)
- **SelfConnect** = "terminal-as-medium" AI-to-AI communication: agents talk by injecting
  keystrokes into each other's terminals/windows (Win32 PostMessage / SendKeys), not via a
  shared log. Economics: no double-reading, "cost per message is the message," cross-vendor,
  cross-OS, runs on subscription + local models at ~$0.
- **SelfConnect Terminal** = the Electron app here: real ConPTY terminal, daemon-owned model
  routing, cost kernel, approval gates, secret redaction, hash-chained ledger, signed Merkle
  passports, MCP server, A2A (BPC/TSK) transport. Distinct mechanisms — keep them distinct:
  SelfConnect = injection; A2A = signed mailbox transport; MCP = read-only governed tools.

## The story to document (the arc this session)
1. Windows port: the orchestrator Claude (Opus 4.8) cloned + built the app on Windows. Four
   native blockers, all fixed (see docs/WINDOWS-FINDINGS.md): npm cache on D: throwing UNKNOWN,
   `NoDefaultCurrentDirectoryInExePath` breaking the winpty build, MSB8040 Spectre libs, and a
   missing `ws` dependency. 236/236 tests pass.
2. P7 bug: the real Electron app rendered the SIMULATED preview because a sandboxed preload
   couldn't `require` a relative module, so `window.selfconnect` was never exposed and the
   renderer fell back to a mock. Fixed by inlining the IPC constants in the preload + compiling
   the mock out of the real build. GUI is now real.
3. Function verification: ledger verify, cost kernel, /context, redaction, /simulate, passport
   export+verify, evidence export, IETF export, review pipeline — all confirmed working.
4. AI-to-AI: orchestrator Claude <-> inner Claude (claude-sonnet-4-6 in the pane) <-> Perplexity
   Computer (Claude Fable 5, in a browser). A file-mailbox bridge was built; two-way messaging
   with zero human relay was confirmed across vendors and machines.
5. Findings (tracked in GitHub issue #1): terminal can't accept URLs (Claude's slash menu eats
   `/`, no bracketed paste); review `num_ctx` defaulted to 4096; Ollama 404 from an `OLLAMA_MODEL`
   env var pointing at an unpulled model; bare "HTTP 404" hid the real error; `ledger export
   --ietf <file>` doesn't write the file.
6. Permission model (important theme): an agent cannot self-grant the right to inject keystrokes,
   nor grant it to a peer — only a human (Ron) can, via `.claude/settings.json` allow rules. This
   was demonstrated repeatedly (both the inner Claude and the orchestrator were blocked from
   self-granting). Medium (SelfConnect) and authorization (human-rooted permission) are separable.

## Files to read for the facts (read these FIRST, in order)
1. `README.md`, `CLAUDE.md`, `AGENTS.md`
2. `docs\WINDOWS-FINDINGS.md`, `docs\WINDOWS-RUN.md`, `WINDOWS-RUN-FINDINGS.md`
3. `bridge\orchestrator-to-inner.md` and `bridge\inner-to-orchestrator.md` — the actual AI-to-AI transcript
4. `bridge\sc-inject.ps1` and `bridge\sc-read.ps1` — the injection + readback tools
5. The findings tracker:  run  `gh issue view 1`
6. `src\agent\review-agent.ts`, `src\agent\providers\ollama.ts`, `src\agent\cost-kernel.ts`

## Constraints
- This is **patent-relevant** material. Keep the document **local** — do NOT `git push`,
  publish, or send it anywhere. No secrets/keys in the doc.
- Cite the source files for claims. If something can't be verified from the files, say so rather
  than inventing it.
- When done, write a one-line note to `bridge\inner-to-orchestrator.md` saying the doc is written
  and where, so the orchestrator sees it.

Tracks defects/limitations surfaced while live-testing the SelfConnect Terminal on Windows. Primary item first; running checklist below for things that come up.

## Primary — Terminal pane can't accept URLs / `/`-containing text

**Symptom:** typing or pasting a URL into the pane mangles it. For example, `https://github.com/rblake2320/selfconnect-ecosystem.git` becomes `https:hub.com/rblake2320/selfconnect-ecosystem.git` with a stray `/git`; on submit the app reports `unknown command: //github.com/...`.

**Cause:** the `/` characters trigger Claude Code's slash-command menu, which captures `/git` and strips it from the line (`//github` → `hub`). Pasting doesn't help because the pane does **not honor bracketed paste** — pasted text is processed as individual typed characters and hits the same slash-menu path. (Manual Ctrl+V fails for the same reason.)

**Impact:** you cannot paste a repo URL, a link, or any `/`-containing text into an agent running in the pane. This blocked giving an agent a `git clone` URL during testing.

**Fix direction:** honor **bracketed paste** (`ESC[200~ … ESC[201~`) on PTY/terminal input so pasted content is inserted literally and never interpreted as slash commands. That resolves both the failed paste and the slash-menu mangling for pasted content.

**Workaround (today):** reference local paths with backslashes (`C:\Users\...`) instead of URLs, and let the agent use its git/file tools rather than typing a URL into the pane.

## Other items found this session (checklist)
- [ ] **Review input truncated to 4096 tokens** — Ollama `num_ctx` defaulted to 4096 even though the model supports 131072, so reviews saw a clipped snapshot. *Fix applied locally:* add `options: { num_ctx, temperature }` in `src/agent/providers/ollama.ts`.
- [ ] **Unhelpful Ollama error** — a bare `Ollama error HTTP 404` hid the response body (`model 'X' not found`), costing debugging time. *Fix applied locally:* surface the response body in the thrown error.
- [ ] **Review prompts not directive enough** — lacked an explicit anti-summarization constraint, so a small local model returned summaries instead of findings. *Fix applied locally:* hardened the system prompt in `src/agent/review-agent.ts`.
- [ ] **Active model misconfig** — the `OLLAMA_MODEL` user env var pointed at an unpulled model (`rishi255/posh_codex_model`), causing review HTTP 404. *Worked around* by creating that model name in Ollama as an alias of `gemma3`.
- [ ] **`ledger export --ietf <file>`** — prints an empty result and does not write the named file (the `--ietf` export to stdout works). Minor CLI arg-handling bug.

The `num_ctx` / error-surfacing / prompt fixes are applied to the local working copy and ready to commit; this issue also tracks them landing on the default branch.

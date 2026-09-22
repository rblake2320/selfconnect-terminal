# Daily use

Current owner policy is subscription-only. Keep local-only enabled and use
existing CLI subscriptions. Jev is a separate API and must remain disabled under
this policy. Historical live Jev results predate this restriction.


Open **SelfConnect Terminal** from the desktop shortcut. It opens your home
folder with a real Windows shell. Use `cd` to enter any checked-out project, then
run your normal GitHub CLI, Codex, Claude or other installed commands with their
existing logins. Repositories do not need an MCP server loaded to use the shell.

Jev is an optional diagnostic reader. Click **Preview recent output**, check the
redacted text, then enable cloud assistance and send that excerpt. Read its
suggestion and decide what to do yourself. Jev never types commands or approves
actions. The preview is capped at 80 lines and 8,000 characters and expires after
two minutes. Requests time out after 15 seconds by default; no automatic retry
or background polling occurs. Refresh after new output. Its token usage is
separate from the other providers' Cost Kernel.

**View history** reads saved output. Closing a shell ends its running programs;
history does not restart them. Session snapshots are saved every ten seconds
when output changes and on normal exit. Sudden process termination can lose
output since the most recent snapshot.

Tool permission modes apply to the app's tool API. Your interactive terminal and
external CLI agents retain their own permissions. Local-only prevents this app's
cloud calls; it does not block networking from commands you type.

BPC and TSK remain separate projects. The terminal can work in their folders as
it can any other project; that is not equivalent to integrating their protocols.
Likewise, opening a SelfConnect repository does not activate all of its services.
The private repository map is retained locally; the public verification report describes tested integrations.

## Rebuild and verify on Windows

```powershell
npm ci
npm run dist:local
powershell -NoProfile -File scripts/install-local.ps1
node scripts/daily-terminal-acceptance.cjs
```

The local build is unsigned. `dist:local` skips executable signing and metadata
editing; `npm run dist` retains the normal distribution configuration. The
installer script keeps prior version folders and points the shortcut at the new
one. User data and the encrypted key live outside those folders in AppData.

The acceptance script launches an isolated profile and skips paid API calls by
default. The live Jev check requires SCT_ALLOW_PAID_API=1, which is prohibited
under the current owner policy unless separately reauthorized. It saves machine-readable
results and a screenshot under `docs/jev-20260922`. To test an installed copy,
set `SCT_TEST_EXE` to its executable before running the script.

## Native SelfConnect and dock scope

The SelfConnect mesh card reads the installed Python Core registry on demand.
Refresh peers lists matching live HWND/PID/executable/class identities; Join mesh
registers this actual terminal window. Observed presence is not message delivery.
Use guarded Core messaging and require recipient ACK; serialize native input.
The earlier Agent Mesh card is now App roles and mailbox: internal roles, not CLI
agents. App call accounting and App context exclude hosted Claude/Codex usage.
Savings are estimates; the initial efficiency of 100% is an empty-state default.
Selected route is configuration, and provider health indicates whether it can run.

MCP configuration defaults to `%APPDATA%\SelfConnect Terminal\mcp-servers.json`;
`SELFCONNECT_MCP_CONFIG` overrides it. Servers launch only when used. App MCP calls
now pass through permission enforcement; plan blocks mutating-class MCP calls.
The interactive shell and its hosted agents retain their own permission systems.

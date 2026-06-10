# SelfConnect Terminal — Windows 11 Run Book (RTX 5090, real run)

A copy-pasteable runbook for a **first-time native launch** of the real Electron
app + real daemon on a fresh Windows 11 machine. No mocks.

> **Status note.** This build was developed on **Linux**, but the first real
> Windows 11 run (Node v24, VS 2022 BuildTools, RTX 5090 box) has now happened.
> The following are **VERIFIED ON WINDOWS**: `npm install` (via a C: cache),
> `node-pty` rebuilt against the **Electron 31 ABI**, a real **ConPTY smoke test**
> (`NODE_PTY_OK ... sawData=true`), and **236/236 tests passing natively**. Six
> first-run problems were found and all have durable fixes now in the repo — see
> `docs/WINDOWS-FINDINGS.md` and the Troubleshooting section below. Anything still
> not exercised from any machine is flagged **[UNVERIFIED ON WINDOWS]** (e.g. the
> Electron *window/GUI* launch itself). The RTX 5090 is **not used by this app**
> for inference — inference is **Ollama** (local) or a cloud provider; there is no
> CUDA/GPU code path in SelfConnect itself.

---

## (a) Prerequisites

Run these in an **elevated** PowerShell (Run as Administrator). After installing
toolchains, **close and reopen** the shell so `PATH` updates take effect.

```powershell
# Git
winget install Git.Git

# Node 20 LTS (the app requires Node >= 20)
winget install OpenJS.NodeJS.LTS

# Python 3.x (node-gyp needs it to compile node-pty's native addon)
winget install Python.Python.3.12

# Visual Studio C++ Build Tools — "Desktop development with C++" workload.
# This is what compiles the node-pty native addon on Windows.
winget install Microsoft.VisualStudio.2022.BuildTools --override "--quiet --add Microsoft.VisualStudio.Workload.VCTools --includeRecommended"

# Ollama (local model provider — free, and the default since LOCAL_ONLY=true)
winget install Ollama.Ollama
```

After Ollama installs, pull the default local model and confirm the server is up:

```powershell
ollama pull gemma3
ollama list                 # gemma3 should appear
# Ollama runs a background server on http://localhost:11434
curl http://localhost:11434/api/tags    # should return JSON listing gemma3
```

Verify the toolchains (reopen the shell first):

```powershell
node --version      # v20.x or higher
npm --version
python --version    # 3.x
git --version
```

> **[UNVERIFIED ON WINDOWS]** Exact winget package IDs can drift over time. If a
> `winget install` line reports "No package found", run `winget search <name>`
> and use the current ID. The VS Build Tools workload ID
> (`Microsoft.VisualStudio.Workload.VCTools`) is the one that supplies MSVC +
> the Windows SDK that node-gyp needs.

---

## (b) Clone and run setup

```powershell
git clone https://github.com/rblake2320/selfconnect-terminal
cd selfconnect-terminal

# The script does NOT require -ExecutionPolicy Bypass. If PowerShell blocks it,
# unblock just this file (no policy change needed):
Unblock-File scripts\setup-windows.ps1
# ...or scope a milder policy to this process only:
#   Set-ExecutionPolicy -Scope Process -ExecutionPolicy RemoteSigned
# ...or run the steps manually (each is an ordinary npm/npx command).

pwsh -File scripts/setup-windows.ps1
```

`setup-windows.ps1` will, in order:

1. **Check prerequisites** — Node >= 20, npm, Python, and the MSVC C++ toolchain
   (via `vswhere`). Fails fast with an actionable message if Node/Python are
   missing; warns (does not hard-fail) if it cannot confirm MSVC.
2. **npm cache health** — runs `npm cache verify`; if it errors (the D:/Dev-Drive
   `UNKNOWN errno -4094` failure mode), it redirects to a fresh C: cache and sets
   `$env:npm_config_cache` so **every** later npm/npx step uses it.
3. `npm install`
4. Create `.env` from `.env.example` (only if `.env` does not already exist) and
   the `./data` runtime directories.
5. **node-pty rebuild** — runs `scripts/fix-node-pty-spectre.cjs` (handles MSB8040
   Spectre-lib gaps), clears `NoDefaultCurrentDirectoryInExePath` for the process
   (winpty `GetCommitHash.bat` fix), then `npx electron-rebuild -f -w node-pty`,
   then a **real ConPTY smoke test** via `npx electron scripts/pty-smoke.js`
   (expects `NODE_PTY_OK ... sawData=true`).
6. `npm run typecheck`
7. `npm test` (expect **236 passing**)
8. `npm run build`

If every step is green you will see: `== All green. Launch with: npm start ==`.

> **VERIFIED ON WINDOWS:** steps 3 (install via C: cache), 5 (rebuild against the
> Electron 31 ABI + ConPTY smoke `sawData=true`), and 7 (236/236 tests) all ran
> green on the real machine. See `docs/WINDOWS-FINDINGS.md` for the six first-run
> problems and their durable fixes, all now baked into this script.

---

## (c) Configure `.env`

`scripts/setup-windows.ps1` already copied `.env.example` → `.env`. Open `.env`.

**Required: nothing.** The app ships with `SELFCONNECT_LOCAL_ONLY=true`, which
**hard-blocks all cloud egress**. In that mode the only provider used is local
Ollama, so **zero cloud keys are needed** — review/consult run against `gemma3`
for $0.00.

**Optional (only if you want real cloud calls):**

| Key | When you need it | Notes |
|-----|------------------|-------|
| `ANTHROPIC_API_KEY` | to make a real Anthropic cloud call | leave blank for local-only |
| `ANTHROPIC_MODEL` | defaults to `claude-sonnet-4-5` | |
| `SELFCONNECT_LOCAL_ONLY` | set `false` to **allow** cloud routing | still redacted + approval-gated |
| `OLLAMA_URL` / `OLLAMA_MODEL` | only if Ollama is on a non-default host/model | default `http://localhost:11434` / `gemma3` |
| `SELFCONNECT_MAX_SPEND_PER_CALL` | per-call USD cap (default `0.25`) | refuses calls above the cap |
| `SELFCONNECT_APPROVAL_TIMEOUT_MS` | approval window (default `120000` = 2 min) | timeout = denied |
| `SELFCONNECT_A2A_MODE` | `file` / `ws` / `off` | set `off` for a single-machine run |
| `SELFCONNECT_CONFIDENCE_THRESHOLD` | confidence escalation cutoff (default `0.5`) | low confidence + high blast radius → approval |
| `SELFCONNECT_LEDGER_PATH` | where the hash-chained audit ledger is written | default `./data/selfconnect-ledger.jsonl` |

To do a real cloud test later: set `SELFCONNECT_LOCAL_ONLY=false` and
`ANTHROPIC_API_KEY=sk-ant-...`. Otherwise leave everything as-is.

---

## (d) Verify build health

```powershell
npm run typecheck       # 3 tsconfigs, must be clean
npm test                # expect: Tests  236 passed (236)  /  Test Files  33 passed (33)
npm run build           # builds renderer + electron + cli
```

**Expected:** typecheck prints nothing and exits 0; `npm test` ends with
`Tests  236 passed (236)`; `npm run build` produces `dist/`, `dist-electron/`,
and the renderer bundle with no errors.

**Failure looks like:** any non-zero exit, a red `✗` test line, or a `tsc` error
with a file:line. The test suite is pure TypeScript (no native deps), so if
`npm test` passes but `npm start` fails, the problem is the native/Electron layer
(see Troubleshooting), not the application logic.

> **VERIFIED ON WINDOWS:** all 236 tests passed natively on the first real run.
> A fresh-clone `npm run typecheck` previously failed on a missing `ws`
> dependency (Problem 6); that is now fixed in `package.json`.

---

## (e) Launch

```powershell
npm start
```

This runs `electron .` against the built `dist-electron/electron/main.js`. The
window should open with the terminal pane on the left, the live widget dock on
the right, and a `selfconnect:~/workspace$`-style prompt in a **real** PTY.

> **Partly verified.** The **ConPTY-backed shell** layer is **VERIFIED ON
> WINDOWS** — the `scripts/pty-smoke.js` test spawned a real ConPTY child under
> Electron 31 and saw live data (`NODE_PTY_OK ... sawData=true`). The Electron
> **window/GUI launch itself** (`npm start`) is still **[UNVERIFIED ON WINDOWS]**
> as of this writing. On Windows the spawned shell is `%COMSPEC%` (cmd.exe) unless
> `$SHELL`/PowerShell is configured.

---

## (f) Real-run verification checklist (proves non-mock behavior)

Run these **in the launched app** (terminal pane for shell + slash commands)
unless a line says CLI. Each item states the expected real output and what
failure looks like. This is the live daemon — every action below appends to the
on-disk hash-chained ledger at `./data/selfconnect-ledger.jsonl`.

1. **Real PTY shell command**
   - Type: `dir` (or `cmd /c ver`).
   - **Expected:** real Windows directory listing / version string from the
     actual child process — not a canned demo list.
   - **Failure:** "command not found (simulated shell)" text would mean you are
     somehow running the browser preview, not the Electron app; or a blank pane
     means the PTY/ConPTY failed to spawn (see Troubleshooting → node-pty).

2. **Simulate (dry-run) → approval with diff preview**
   - Type: `/simulate edit_file src\app.ts`
   - **Expected:** a dry-run summary with a **unified diff preview** and a
     **pending approval** appears in the Approvals panel carrying that preview
     (files touched, risk, est. cost). Nothing is written to disk.
   - **Failure:** no approval appears, or the diff is empty → the simulate
     planner or approval wiring is broken.

3. **Redaction preview**
   - Type: `/redact-test export ANTHROPIC_API_KEY=sk-ant-abc123`
   - **Expected:** the key is masked in the echoed output and a redaction count
     is reported.
   - **Failure:** the raw key is echoed back unmasked.

4. **Real cloud-call redaction (only if a cloud key is set)**
   - Pre-req: `.env` has `SELFCONNECT_LOCAL_ONLY=false` and a real
     `ANTHROPIC_API_KEY`; relaunch.
   - Type: `/review security` (routes to the cloud model and triggers an approval).
   - **Expected:** an approval prompt for a cloud send; after approving, a real
     model response returns, and the ledger shows a `redaction.applied` event
     **before** the cloud send — secrets in the snapshot are masked in transit.
   - **Failure:** a cloud call with no preceding redaction event, or the call
     proceeds with no approval prompt. **If `SELFCONNECT_LOCAL_ONLY=true`** (the
     default) the cloud send is **hard-blocked** — that block is the *correct*
     behavior, not a failure.

5. **Context economy after some usage**
   - After running a few commands, type: `/context`
   - **Expected:** real hot/warm/pinned token counts, dedup hits, compaction
     count, and a Context Efficiency %% that reflect the commands you just ran.
   - **Failure:** all-zero counters after real activity.

6. **Write then rewind a checkpoint**
   - Make a mutating tool write (e.g. approve the `/simulate` from step 2, or use
     a write tool), then type: `/rewind`
   - **Expected:** the last **signed checkpoint** is restored; output reports the
     restored path and re-verifies the ledger/chain as INTACT.
   - **Failure:** "no checkpoint" when one should exist, or a signature-invalid
     error.

7. **Ledger hash-chain verification (CLI)**
   - In a second PowerShell, from the repo root:
     `node dist\cli\index.js ledger verify`
   - **Expected:** JSON with `"chainOk": true` and `"checkpointsOk": true`, exit
     code 0. This walks the real on-disk ledger and every checkpoint signature.
   - **Failure:** `chainOk: false` (tampered/broken chain) or a non-zero exit.
   - (In-app equivalent: `/verify` in the terminal pane.)

8. **Signed work-history passport**
   - Type: `/passport` (or CLI: `node dist\cli\index.js passport export`)
   - **Expected:** a signed, Merkle-rooted passport summarizing events, tool
     calls, spend, approvals, with a Merkle root and a VALID signature line.
   - **Failure:** "no key" / signature INVALID, or an empty passport.

9. **Harness lab — run two arms**
   - Type: `/lab run` (in-app demo) or, for a real scored run from the CLI:
     `node dist\cli\index.js lab run <task-file> --arms baseline,dedup`
   - **Expected:** a side-by-side comparison table of **two arms** scored from
     the ledger (turns, tokens, cache%%, err%%, wall ms, PASS/FAIL). The Harness
     Lab dock panel populates.
   - **Failure:** only one arm, or empty scores.

10. **Audit-trail export (IETF conformance)**
    - CLI: `node dist\cli\index.js ledger export --ietf data\audit-ietf.json`
    - **Expected:** a JSON audit trail written in IETF conformance format; the
      command exits 0 and the file is non-empty.
    - **Failure:** empty file, schema error, or non-zero exit.

> If items 1, 2, 5, 6, 7 behave as described, the run is genuinely non-mock: a
> real PTY child process, a real on-disk hash-chained ledger, real signed
> checkpoints, and the real approval/redaction governance path are all live.

---

## (g) Troubleshooting

> The six problems below were all hit on the first real Windows run and are now
> handled automatically by `scripts/setup-windows.ps1`. They are documented here
> in case you run steps manually or a fix needs re-applying. Full write-up:
> `docs/WINDOWS-FINDINGS.md`.

### `npm install` fails with `UNKNOWN ... errno -4094` (cache on D:/Dev Drive)
- **Symptom:** `npm error code UNKNOWN, syscall read, errno -4094`, rollback to an
  empty `node_modules`; cache "seems to be corrupted"; even `npm cache verify`
  errors with `UNKNOWN`. Happens when the npm cache lives on a D: / Dev Drive that
  an AV or reparse filter intercepts (disk space and permissions are fine).
- **Fix:** point npm at a fresh cache on C: **and export it** so every subsequent
  npm/npx call uses it (a later `npx` will otherwise fall back to the broken cache):
  ```powershell
  $env:npm_config_cache = "$env:USERPROFILE\.npm-cache-selfconnect"
  npm install
  ```
  `setup-windows.ps1` step `[1/8]` does this automatically when `npm cache verify`
  fails.

### `GetCommitHash.bat is not recognized` (NoDefaultCurrentDirectoryInExePath)
- **Symptom:** the node-pty rebuild fails because winpty's `winpty.gyp` runs
  `cmd /c "cd shared && GetCommitHash.bat"`, and cmd refuses to run a batch file
  from the current directory when `NoDefaultCurrentDirectoryInExePath=1` is set
  machine-wide.
- **Fix:** clear it for the current process, then rebuild:
  ```powershell
  $env:NoDefaultCurrentDirectoryInExePath = $null
  npx electron-rebuild -f -w node-pty
  ```
  `setup-windows.ps1` clears this for its process before the rebuild step.

### `MSB8040: Spectre-mitigated libraries are required`
- **Symptom:** the rebuild fails with MSB8040 because node-pty's gyp files set
  `'SpectreMitigation': 'Spectre'` but the VS install lacks the Spectre-mitigated
  VC libraries.
- **Fix (clean):** install the VS component "MSVC … C++ x64/x86 Spectre-mitigated
  libs" in the Visual Studio Installer.
- **Fix (fallback, automatic):** `setup-windows.ps1` runs
  `node scripts/fix-node-pty-spectre.cjs` after install and before the rebuild; it
  flips the flag to `'false'` in `node_modules/node-pty/binding.gyp` and
  `deps/winpty/src/winpty.gyp` when the libs are absent. It is idempotent and
  re-applies after every fresh `npm install` (which wipes the node_modules edit).
  To force it: `node scripts/fix-node-pty-spectre.cjs --force`.

### `npx electron -e "..."` hangs / "Unable to find Electron app"
- **Symptom:** using `electron -e "<js>"` for a smoke test hangs and pops a dialog
  "Unable to find Electron app at C:\...\try { ... }" — Electron treats the `-e`
  payload as an app **path**, not eval code. (The dialog is harmless; dismiss it.)
- **Fix:** run a real smoke **file** instead. This repo ships one:
  ```powershell
  npx electron scripts\pty-smoke.js
  # expect: NODE_PTY_OK spawn=function exit=0 sawData=true
  ```

### node-pty rebuild fails (ABI mismatch / missing MSVC)
- **Symptom:** `electron-rebuild` errors, or `npm start` throws
  `Error: The module '...pty.node' was compiled against a different Node.js
  version` / `A dynamic link library (DLL) initialization routine failed`.
- **Fix:**
  - Confirm the C++ workload is installed:
    `winget install Microsoft.VisualStudio.2022.BuildTools --override "--quiet --add Microsoft.VisualStudio.Workload.VCTools --includeRecommended"`
  - Confirm Python is on PATH: `python --version`.
  - Force a clean rebuild against Electron's ABI:
    `npx electron-rebuild -f -w node-pty`
  - Verify it loads with a real smoke file (NOT `electron -e`, which does not
    work — see above): `npx electron scripts\pty-smoke.js`
    (expect `NODE_PTY_OK ... sawData=true`).
  - The installed Electron major must match `package.json` (**31**). If you
    bumped Electron, rebuild again.

### Electron sandbox / window won't open
- **Symptom:** the process starts but no window, or a GPU/sandbox error in the
  console.
- **Fix:** ensure you are on a real desktop session (not headless/SSH). If a GPU
  driver issue appears, try `npm start -- --disable-gpu` to isolate whether it is
  GPU-related. **[UNVERIFIED ON WINDOWS]** — these flags were not exercised from
  Linux.

### Ollama not running
- **Symptom:** `/review` (local) hangs or errors; `curl http://localhost:11434/api/tags`
  fails.
- **Fix:** start the Ollama server (it normally runs as a background service after
  install; otherwise run `ollama serve`), confirm `ollama list` shows `gemma3`,
  and that `OLLAMA_URL` in `.env` matches the host/port.

### PowerShell execution policy blocks the script
- **Symptom:** "running scripts is disabled on this system".
- **Fix (no Bypass needed):** unblock just this one file, then run it:
  ```powershell
  Unblock-File scripts\setup-windows.ps1
  pwsh -File scripts/setup-windows.ps1
  ```
  Or scope a milder policy to the current process only:
  `Set-ExecutionPolicy -Scope Process -ExecutionPolicy RemoteSigned`. The script
  does not require `-ExecutionPolicy Bypass`; every step is an ordinary npm/npx
  command you can also run by hand.

### `npm test` passes but `npm start` fails
- The test suite has no native dependency, so this isolates the failure to the
  Electron/native layer (node-pty or windowing). Work the node-pty section above.

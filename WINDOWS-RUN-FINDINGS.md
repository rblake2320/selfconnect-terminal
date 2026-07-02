# SelfConnect Terminal — First Real Windows Run: Findings & Fixes

**Machine:** Windows 11 Pro 26200, RTX 5090, Node v24.3.0, npm 11.4.2, Python 3.12.10,
git 2.50, pwsh 7.5.4, VS 2022 Build Tools (Desktop C++), Ollama 0.24.0.
**Repo:** https://github.com/rblake2320/selfconnect-terminal @ `fb703a8` (main)
**Clone path:** `C:\Users\techai\selfconnect-terminal` (C: drive, as requested)
**Date:** 2026-06-10

## Result: build + daemon are genuinely real; GUI renderer is NOT (Problem 7)

What is **genuinely non-mock** after the fixes below (none of these touch the GUI preload bridge):
- `node-pty` native addon **rebuilt against the Electron 31 ABI and loads** — a real
  ConPTY child process spawned (via the Electron binary), ran `cmd /c echo`, and returned
  live data (`sawData=true`).
- `npm run typecheck` — **clean** (3 tsconfigs).
- `npm test` — **236 passed (236), 33 test files**.
- `npm run build` — **clean** (renderer `vite` 484 kB bundle, electron `tsc`, cli `tsc`).
- CLI proofs: `ledger verify` → `chainOk:true, checkpointsOk:true, 6 entries`;
  `slash "/cost"` → real cost kernel; `passport export` → signed Merkle-rooted passport
  with a live **ed25519** signature.

What is **NOT real yet:**
- The **GUI window launches but the renderer falls back to the SIMULATED preview** (mock bridge).
  The Electron process tree being up is *not* proof the renderer is live. See **Problem 7** — the
  preload bridge never loaded, so `window.selfconnect` is absent and the renderer installs its mock.
  *(Correction to the initial run summary, which wrongly counted the GUI as a non-mock success.)*

The runbook's riskiest, Linux-unverifiable step (the node-pty / ConPTY native layer)
**works on this machine** — but only after the blockers below, most of which the runbook
did not anticipate.

---

## Problems hit, in order (each with root cause + the durable fix for the next box)

### 1. npm cache on `D:` throws `UNKNOWN` (errno -4094) — install rolls back to empty
**Symptom**
```
npm warn tarball cached data for <pkg> ... seems to be corrupted. Refreshing cache.   (x15)
npm warn tar TAR_ENTRY_ERROR UNKNOWN: unknown error, write                              (x6)
npm error code UNKNOWN / syscall read / errno -4094 / UNKNOWN: unknown error, read
```
`node_modules` rolled back to 0 entries. `npm cache verify` and `npm cache clean --force`
*also* failed with `UNKNOWN open/write` on `D:\dev\npm-cache`. (Git-Bash could `ls`/`head`
files on D:, so the drive is mounted and readable — but node/libuv could not operate on the
cache path.)

**Root cause** — Environment, **not a SelfConnect bug.** The npm cache was configured at
`D:\dev\npm-cache`, whose entries were corrupted and/or intercepted by an I/O filter
(antivirus real-time scan, or a reparse-point / Dev-Drive filter on D:). libuv surfaces this
as the opaque `UNKNOWN -4094`.

**Fix applied** — Redirected the cache to C: for every npm/npx call:
`--cache C:/Users/techai/.npm-cache-sct` and `export npm_config_cache=C:/Users/techai/.npm-cache-sct`.
Install then succeeded immediately.

**Durable fix for next machine**
- `npm config set cache C:\Users\<user>\.npm-cache` (a healthy C: location), **or** repair/relocate
  the D: cache, **or** exclude the cache dir from antivirus.
- *Runbook action:* `setup-windows.ps1` should detect a non-C: / failing npm cache and either
  warn or set a local project cache before `npm install`.

### 2. `NoDefaultCurrentDirectoryInExePath=1` breaks the winpty build
**Symptom**
```
'GetCommitHash.bat' is not recognized as an internal or external command, operable program or batch file.
gyp: Call to 'cmd /c "cd shared && GetCommitHash.bat"' returned exit status 1
     while in deps\winpty\src\winpty.gyp ...
✖ Rebuild Failed
```
The `.bat` files **exist** in `deps/winpty/src/shared/` — cmd simply refused to run them from
the current directory.

**Root cause** — This machine has the env var **`NoDefaultCurrentDirectoryInExePath=1`** set
(confirmed via PowerShell). That variable disables cmd.exe's default behavior of searching the
*current directory* for executables/batch files. `winpty.gyp` (lines 13 & 25) calls batch files
by bare name after `cd shared`, so they become unfindable. This var is commonly set by security
hardening (CIS benchmarks) or some dev tooling.

**Fix applied** — `unset NoDefaultCurrentDirectoryInExePath` in the rebuild subprocess env (the
system-level variable was left untouched).

**Durable fix for next machine**
- *Runbook action (preferred):* in `setup-windows.ps1`, before `electron-rebuild`, clear it for
  the child process only:
  ```powershell
  Remove-Item Env:NoDefaultCurrentDirectoryInExePath -ErrorAction SilentlyContinue
  ```
- *Or upstream:* patch node-pty `winpty.gyp` to call the scripts as `cmd /c shared\GetCommitHash.bat`
  (relative path) instead of `cd shared && GetCommitHash.bat`.
- *Troubleshooting section* should list this env var as a named cause of the
  "`GetCommitHash.bat` is not recognized" failure.

### 3. Spectre-mitigated libraries required (`MSB8040`)
**Symptom** (after fixing #2)
```
error MSB8040: Spectre-mitigated libraries are required for this project. Install them from the
Visual Studio installer (Individual components tab) ...  [...winpty.vcxproj]
4 Error(s) ... MSBuild ... failed with exit code: 1  ->  ✖ Rebuild Failed
```

**Root cause** — node-pty's own gyp files request Spectre mitigation
(`'SpectreMitigation': 'Spectre'` in `binding.gyp:9`, `winpty.gyp:44`, `winpty.gyp:146`), but the
installed VS 2022 Build Tools **"Desktop development with C++"** workload does **not** include the
Spectre-mitigated VC runtime libraries by default — they are a separate Individual Component.

**Fix applied** — Set `'SpectreMitigation': 'false'` in those 3 gyp locations, then rebuilt
(`✔ Rebuild Complete`). NOTE: this edits `node_modules` and is **lost on any reinstall**.

**Durable fix for next machine (preferred — keeps node-pty's hardening):**
Add the Spectre libs to the prereq VS install. Append the component to the winget line:
```powershell
winget install Microsoft.VisualStudio.2022.BuildTools --override `
  "--quiet --add Microsoft.VisualStudio.Workload.VCTools `
   --add Microsoft.VisualStudio.Component.VC.Runtimes.x86.x64.Spectre --includeRecommended"
```
(= "MSVC v143 - VS 2022 C++ x64/x86 Spectre-mitigated libs (Latest)".)
*Fallback* (no admin / can't add the component): the `SpectreMitigation: false` gyp patch above,
applied automatically by `setup-windows.ps1` only when the Spectre libs are detected missing.
The runbook's prereq + troubleshooting sections currently mention **neither**.

### 4. Missing `ws` dependency breaks `npm run typecheck`
**Symptom**
```
src/daemon/adapters/tsk-transport.ts(156,33): error TS2307:
  Cannot find module 'ws' or its corresponding type declarations.
```

**Root cause** — `tsk-transport.ts` uses a *lazy* `await import('ws')` for the **optional** A2A
WebSocket transport, with a runtime graceful-degrade ("ws not installed — no-op") if absent. But
`ws` is declared **nowhere** in `package.json` (not dep / optionalDep / devDep), so on a fresh
clone TypeScript cannot resolve the dynamic-import specifier and typecheck hard-fails. The
author's "typecheck clean / 236 tests" almost certainly ran with `ws` incidentally hoisted into
`node_modules` from elsewhere.

**Fix applied** — `npm install ws @types/ws`. Typecheck then clean; 236 tests pass; build clean.

**Durable fix for next machine**
- Add `ws` to `dependencies` (or `optionalDependencies`) and `@types/ws` to `devDependencies` in
  `package.json`. Recommended, since A2A `ws` mode needs it at runtime anyway.
- *Or* if `ws` must stay truly optional, change the import to `await import('ws' as any)` or add a
  local type shim so typecheck doesn't require the `@types/ws` declarations.

### 7. (THE genuine app bug) GUI renderer falls back to the SIMULATED preview — preload bridge never loads
**Symptom** — `electron .` opens the window, but the renderer shows the **simulated preview banner**
(mock data), not the live daemon. The Electron process tree is up, but `window.selfconnect` is absent.

**Root cause** — `electron/main.ts` sets `webPreferences.sandbox: true` (+ `contextIsolation: true`).
The compiled preload (`dist-electron/electron/preload.js:4`) runs:
```js
const contracts_1 = require("../src/shared/contracts");   // for the runtime IPC value
```
A **sandboxed** Electron preload can only `require('electron')` + a few polyfilled built-ins — it
**cannot** `require` an arbitrary relative file, even though `dist-electron/src/shared/contracts.js`
exists on disk. So the preload **throws at load**, `contextBridge.exposeInMainWorld('selfconnect', api)`
never runs, and the renderer's `installMockBridgeIfNeeded()` (`src/renderer/main.tsx:4-7`) installs the
simulated bridge → the preview banner. (This is invisible in the main-process stdout/`app-start.log`;
it surfaces only in the renderer devtools console.)

**Fix options (owner is taking this):**
- **(a) Bundle the preload** into one self-contained file (esbuild/rollup) with no external relative
  `require`s — keeps `sandbox:true`. Cleanest.
- **(b) Inline the `IPC` channel constants** into `preload.ts` so it imports only `electron` (the type
  imports erase; drop the runtime `../src/shared/contracts` import) — smallest diff, keeps the sandbox
  and HARD SECURITY RULE 5.
- **(c)** `sandbox:false` — preload gets full Node `require`; weakest (contextIsolation still on).

This is the one **real application bug** found — distinct from the four environment/packaging blockers
above. The pure-TS test suite (236) is green because it never exercises the preload/sandbox boundary.

### 5. (Minor, NOT an app bug) Git-Bash path mangling of slash-args
Driving the CLI from Git Bash, `slash "/cost"` returned `unknown command: /c:/program`, and
`cmd /c "..."` opened interactively — both are MSYS POSIX-path translation artifacts (a leading
`/arg` is rewritten to a Windows path). Setting `MSYS_NO_PATHCONV=1` / `MSYS2_ARG_CONV_EXCL='*'`
fixed it. The runbook's commands are written for **PowerShell**, where this never occurs. Worth at
most a one-line note.

---

## Environment notes
- **Node v24.3.0** worked end-to-end (engine requires `>=20`). `electron-rebuild` targets the
  **Electron 31** ABI regardless of the system Node version, so Node 24 is fine — the runbook's
  "Node 20 LTS" is a floor, not a ceiling.
- Local model: `ollama pull gemma3` completed (3.3 GB). The app defaults to `SELFCONNECT_LOCAL_ONLY=true`
  → local-only, zero cloud keys needed. This is independent of running **Claude Code** inside the
  terminal pane (see below).

## Suggested runbook / repo changes (summary)
1. `package.json`: add `ws` + `@types/ws`.  *(fixes #4 permanently)*
2. Prereq VS install line: add `Microsoft.VisualStudio.Component.VC.Runtimes.x86.x64.Spectre`.  *(fixes #3)*
3. `setup-windows.ps1`: `Remove-Item Env:NoDefaultCurrentDirectoryInExePath` before `electron-rebuild`.  *(fixes #2)*
4. `setup-windows.ps1`: detect failing/non-C: npm cache and set a project-local cache.  *(fixes #1)*
5. Troubleshooting: add named entries for `NoDefaultCurrentDirectoryInExePath`, `MSB8040 Spectre`,
   and `UNKNOWN errno -4094` npm-cache failures.

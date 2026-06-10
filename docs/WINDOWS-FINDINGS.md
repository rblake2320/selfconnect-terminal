# SelfConnect Terminal — Windows 11 First-Run Findings

This is the problem report from the **first real Windows 11 launch** of the app
(Windows 11 build 10.0.26200, Node v24.3.0, npm 11.4.2, Python 3.12, VS 2022
BuildTools, Ollama). Six problems surfaced on that first run; a seventh
(Problem 7) was found in the built Electron app immediately after. All seven now
have a durable fix in the repo. Hand this to the next machine and it should hit
**zero** of these.

Each entry: **symptom → root cause → immediate on-machine fix → durable fix now
in repo → status.**

---

## Problem 1 — npm cache on D:/Dev-Drive corrupted (BLOCKER)

- **Symptom:** `npm install` failed twice with `npm error code UNKNOWN, syscall
  read, errno -4094`, rolling back to an empty `node_modules`. The cache at
  `D:\dev\npm-cache` was full of "seems to be corrupted. Refreshing cache" and
  `TAR_ENTRY_ERROR UNKNOWN` write errors. Even `npm cache verify` failed with
  `UNKNOWN`.
- **Root cause:** D: was readable from bash with 2.3 TB free, but Node/libuv
  specifically hit `UNKNOWN` (errno **-4094**) on those file handles — consistent
  with an AV / filter driver or a Dev Drive reparse filter intercepting the cache
  files. Not a disk-space or permissions issue.
- **Immediate fix (worked):** `npm install --cache "C:/Users/<you>/.npm-cache-sct"`.
  Critically, the redirect had to be **exported** (`npm_config_cache`) for *every*
  subsequent `npm`/`npx` call — a later `npx electron` fell back to the broken D:
  cache and re-failed otherwise.
- **Durable fix in repo:** `scripts/setup-windows.ps1` step `[1/8]` runs
  `npm cache verify`; if it errors, it creates `$env:USERPROFILE\.npm-cache-selfconnect`
  and sets **`$env:npm_config_cache`** to it for the whole process, so every later
  npm/npx step inherits the healthy cache. The install-failure message also tells
  the user how to set a C: cache by hand.
- **Status:** FIXED (durable).

---

## Problem 2 — `-ExecutionPolicy Bypass` blocked by agent security policy

- **Symptom:** the agent's auto-mode classifier denied
  `pwsh -ExecutionPolicy Bypass -File scripts/setup-windows.ps1`.
- **Root cause:** `-ExecutionPolicy Bypass` is a high-risk flag; the script
  should never *require* it.
- **Immediate fix (worked):** run each setup step manually.
- **Durable fix in repo:** the script no longer assumes Bypass. Its header now
  documents the non-bypass paths: `Unblock-File scripts\setup-windows.ps1`, or
  `Set-ExecutionPolicy -Scope Process -ExecutionPolicy RemoteSigned`, or run the
  steps by hand (each is an ordinary npm/npx command). The runbook says the same.
- **Status:** FIXED (durable).

---

## Problem 3 — `NoDefaultCurrentDirectoryInExePath=1` breaks the winpty build (BLOCKER)

- **Symptom:** node-pty rebuild failed with `GetCommitHash.bat is not recognized`
  even though the file exists.
- **Root cause:** `deps/winpty/src/winpty.gyp` line 13 runs
  `'<!(cmd /c "cd shared && GetCommitHash.bat")'`. When the environment variable
  `NoDefaultCurrentDirectoryInExePath=1` is set (it was machine-wide on this box),
  cmd.exe refuses to execute a batch file from the *current directory*, so the
  invocation fails.
- **Immediate fix (worked):** `unset NoDefaultCurrentDirectoryInExePath` before
  `electron-rebuild`.
- **Durable fix in repo:** `setup-windows.ps1` clears
  `$env:NoDefaultCurrentDirectoryInExePath` (process-scope only — it does not
  touch the machine/user setting) immediately before the rebuild step.
- **Status:** FIXED (durable).

---

## Problem 4 — MSB8040: Spectre-mitigated libraries required (BLOCKER)

- **Symptom:** after fixing Problem 3, the rebuild failed with **MSB8040**
  ("Spectre-mitigated libraries are required..."). node-pty's `binding.gyp:9` and
  `deps/winpty/src/winpty.gyp:44,146` set `'SpectreMitigation': 'Spectre'`, but
  this VS BuildTools install lacked the Spectre-mitigated VC libs.
- **Root cause:** node-pty hard-codes the Spectre flag in its gyp files; the VS
  install was missing the "MSVC … Spectre-mitigated libs" component.
- **Immediate fix (worked, NOT durable):** hand-edited the three gyp locations in
  `node_modules` to `'SpectreMitigation': 'false'`; rebuild then printed
  "✔ Rebuild Complete". That edit lives in `node_modules` and is wiped by any
  future `npm install`.
- **Durable fix in repo:** new **`scripts/fix-node-pty-spectre.cjs`**, called by
  `setup-windows.ps1` **after `npm install` and before `electron-rebuild`** on
  every run. It checks for the Spectre libs via `vswhere`
  (`Microsoft.VisualStudio.Component.VC.Runtimes.x86.x64.Spectre`); if they are
  present it leaves the gyp files alone, otherwise (or if detection is
  inconclusive) it flips the flag to `'false'` in all three places. It is
  **idempotent**, re-applies after every fresh install, is a no-op off Windows,
  and prints exactly what it did and why (including the VS component to install
  for the clean fix).
- **Status:** FIXED (durable). Best-practice alternative still recommended:
  install the Spectre-mitigated VC libs component in VS Installer.

---

## Problem 5 — `npx electron -e "..."` doesn't work for smoke tests

- **Symptom:** `electron -e "<js>"` hung, then popped an Electron error dialog:
  "Unable to find Electron app at C:\...\try { const pty = ..." — Electron treated
  the `-e` payload as an **app path**. (The leftover dialog is harmless; dismiss it.)
- **Root cause:** Electron's CLI does not support `-e`/`--eval` the way `node`
  does; it interprets the first non-flag argument as the app directory.
- **Immediate fix (worked):** run a real smoke **file** under Electron:
  `node_modules\electron\dist\electron.exe pty-smoke.js`.
  Result — the big win: `NODE_PTY_OK spawn=function exit=0 sawData=true`: node-pty
  loaded under the Electron 31 ABI and a real ConPTY child spawned and returned
  live data on Windows.
- **Durable fix in repo:** added **`scripts/pty-smoke.js`** (a real file: requires
  node-pty, spawns a ConPTY child, asserts it sees data, prints
  `NODE_PTY_OK ... sawData=true`). `setup-windows.ps1` now runs
  `npx electron scripts/pty-smoke.js` instead of the broken `electron -e`.
- **Status:** FIXED (durable).

---

## Problem 6 — REAL REPO BUG: `ws` missing from package.json

- **Symptom:** on a fresh clone, `npm run typecheck` failed at
  `src/daemon/adapters/tsk-transport.ts:156`: `await import('ws')`.
- **Root cause:** `ws` is a lazy/optional runtime import (A2A WebSocket mode) with
  a graceful try/catch fallback, but TypeScript still type-checks the import
  specifier, and neither `ws` nor `@types/ws` was declared in `package.json`. The
  Linux dev sandbox happened to have `ws` hoisted transitively, masking the gap.
- **Immediate fix (worked):** `npm install ws @types/ws` on the machine.
- **Durable fix in repo:** `package.json` now declares **`ws` as a real
  `dependency`** (`^8.18.0` — needed at runtime when `SELFCONNECT_A2A_MODE=ws`) and
  **`@types/ws` as a `devDependency`** (`^8.5.10`). The lazy-import / graceful
  fallback in `tsk-transport.ts` is unchanged — ws stays optional at runtime, but
  the type and the dependency are now declared so fresh installs typecheck and
  ws-mode actually works.
- **Status:** FIXED (durable). Typecheck verified green with the types present.

---

## Problem 7 — built Electron app rendered the SIMULATED browser preview (BLOCKER)

- **Symptom:** after `npm run build`, launching the real app (`electron.exe .`)
  showed the **browser-preview simulation** inside the Electron window: the banner
  read "SIMULATED static preview … faked client-side (no real PTY, daemon, or
  model providers)" and commands returned "(simulated shell — try 'help')". The
  real daemon, PTY, and providers were never reached.
- **Root cause:** two compounding bugs.
  1. **Preload aborted under `sandbox: true`.** `electron/preload.ts` did a
     runtime `import { IPC } from '../src/shared/contracts'`, which `tsc` emits as
     `require("../src/shared/contracts")`. With `sandbox: true`, Electron's
     restricted preload `require` resolves only `electron` plus a few polyfilled
     builtins — **not** arbitrary relative file-path modules. The require threw,
     so the preload aborted **before** `contextBridge.exposeInMainWorld('selfconnect', …)`
     ran, and `window.selfconnect` was never defined. (The user's first
     hypothesis — that the built preload was ESM — was wrong: the built
     `preload.js` was already CommonJS. The killer was the relative `require`, not
     the module format. The file existing on disk is a red herring: sandboxed
     `require` blocks it regardless of platform, which is why this reproduced on
     Windows.)
  2. **mock-bridge silently filled the gap.** `src/renderer/mock-bridge.ts`'s
     `installMockBridgeIfNeeded()` only checked `if (window.selfconnect) return`.
     With the bridge missing it installed the full simulation — *inside the real
     app* — instead of failing loudly.
- **Immediate fix (worked):** n/a on-machine; this is a pure repo bug fixed below.
- **Durable fix in repo:**
  - `electron/preload.ts` now **inlines** the IPC channel string constants
    (`const IPC = { … } as const`) and imports everything else from contracts as
    `import type` (erased at compile time). The built preload therefore
    `require`s **only `electron`**, runs to completion under `sandbox: true`, and
    exposes the real bridge. Security is unchanged: `sandbox: true`,
    `contextIsolation: true`, `nodeIntegration: false`, narrow typed surface.
  - A new test, `tests/preload-ipc-parity.test.ts`, fails if the inlined values
    ever drift from the canonical `IPC` in `src/shared/contracts.ts`, and asserts
    the preload does not value-import contracts.
  - **HARD RULE enforced:** the mock can never run inside Electron. Vite injects a
    compile-time `__SELFCONNECT_PREVIEW__` flag (`true` only for the
    `SELFCONNECT_PREVIEW=1` preview build). `installMockBridgeIfNeeded()` now
    returns `'real' | 'mock' | 'fatal'` and installs the mock **only** when
    `__SELFCONNECT_PREVIEW__` **and** `!navigator.userAgent.includes('Electron')`.
    In the real Electron bundle the flag is `false`, so the entire mock path is
    **dead-code-eliminated** (verified: the production renderer bundle contains
    zero "SIMULATED static" / "simulated shell" strings).
  - **Fail loud, never simulate:** when the real app has no bridge,
    `src/renderer/main.tsx` renders a full-screen **"FATAL: preload bridge
    missing — build is broken"** error instead of the UI. (That string is present
    in the production bundle as the error path.)
  - `tests/mock-bridge-gating.test.ts` pins all four cases (real / mock / fatal-in-
    Electron / fatal-in-real-build) and the Electron user-agent detection.
- **Verification (Linux sandbox):**
  - Built preload requires only `electron`: `grep` of `dist-electron/electron/preload.js`
    shows a single `require("electron")` (contracts appears only in comments).
  - Executing the **built** preload as CommonJS with a mocked `electron` module
    runs to completion and calls `exposeInMainWorld('selfconnect', api)` with all
    **15** methods — i.e. the exact step that previously threw now succeeds.
  - Production renderer bundle: **0** occurrences of the mock banner / simulated-
    shell strings; the fatal-error string **is** present. The
    `SELFCONNECT_PREVIEW=1` preview bundle still contains the mock (preview
    unaffected).
  - A full GUI `npm start` launch could not be exercised here: headless Electron
    under `xvfb-run` fails to paint even a `data:` URL in this sandbox (renderer
    process cannot create a surface). The window/GUI launch remains
    **[UNVERIFIED ON WINDOWS]**, but the bridge wiring — the actual subject of
    Problem 7 — is proven by the preload-execution and bundle checks above.
  - `npm run typecheck` clean; `npm test` **244 passed** (236 prior + 8 new).
- **Status:** FIXED (durable). After this fix, the real app must show the **real
  daemon banner**; **any SIMULATED text inside Electron now means a broken build**,
  and the app says so on a fatal screen rather than pretending to work.

---

## Windows WINS (what already worked natively)

These were validated on the real Windows 11 / RTX 5090 machine and are now
treated as **VERIFIED ON WINDOWS**:

- **`npm install` OK** once pointed at a C: cache (Problem 1 workaround).
- **node-pty rebuilt against the Electron 31 ABI** (after Problems 3 + 4 fixes):
  `✔ Rebuild Complete`.
- **Real ConPTY smoke test passed under Electron:**
  `NODE_PTY_OK spawn=function exit=0 sawData=true` — a real ConPTY child spawned
  and returned live data.
- **236/236 tests passed natively on Windows** (and continue to pass on Linux).

The GPU (RTX 5090) is not used by SelfConnect itself — inference is Ollama (local)
or a cloud provider; there is no CUDA/GPU code path in the app.

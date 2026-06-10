# SelfConnect Terminal — Windows 11 setup script.
# Rebuilds node-pty against the Electron ABI (ConPTY) and runs all green checks.
#
# Prerequisites (see docs/WINDOWS-RUN.md for exact install commands):
#   - Node 20+ (https://nodejs.org)
#   - Python 3.x (node-gyp dependency for the node-pty native addon)
#   - Visual Studio C++ Build Tools ("Desktop development with C++" workload),
#     required to compile node-pty's native addon on Windows.
#
# This script does NOT require `-ExecutionPolicy Bypass`. If PowerShell blocks
# it, either unblock the single file:
#       Unblock-File scripts\setup-windows.ps1
# or scope the policy to the current process only:
#       Set-ExecutionPolicy -Scope Process -ExecutionPolicy RemoteSigned
# or run the steps manually (each is an ordinary npm/npx command).
#
# Usage:
#   pwsh -File scripts/setup-windows.ps1

$ErrorActionPreference = 'Stop'

function Fail($msg) {
    Write-Host "ERROR: $msg" -ForegroundColor Red
    exit 1
}

function Have($name) {
    return [bool](Get-Command $name -ErrorAction SilentlyContinue)
}

Write-Host '== SelfConnect Terminal: Windows setup ==' -ForegroundColor Cyan

# 0. Prerequisite checks (fail fast with actionable messages).
Write-Host '[0/8] checking prerequisites' -ForegroundColor Yellow

if (-not (Have 'node')) {
    Fail 'Node.js not found. Install Node 20 LTS: winget install OpenJS.NodeJS.LTS  (then reopen the shell).'
}
$nodeRaw = (node --version).TrimStart('v')      # e.g. 20.14.0
$nodeMajor = [int]($nodeRaw.Split('.')[0])
if ($nodeMajor -lt 20) {
    Fail "Node $nodeRaw found, but >= 20 is required. Install Node 20 LTS: winget install OpenJS.NodeJS.LTS"
}
Write-Host "   node $nodeRaw (OK, >= 20)"

if (-not (Have 'npm')) { Fail 'npm not found on PATH (it ships with Node — reinstall Node 20 LTS).' }

# node-pty compiles a native addon via node-gyp, which needs Python + MSVC C++.
if (-not (Have 'python') -and -not (Have 'python3')) {
    Fail 'Python not found. node-gyp needs it to build node-pty. Install: winget install Python.Python.3.12  (then reopen the shell).'
}
Write-Host '   python (OK)'

# Detect a Visual Studio C++ toolchain. vswhere ships with VS/Build Tools.
$vswhere = "${env:ProgramFiles(x86)}\Microsoft Visual Studio\Installer\vswhere.exe"
$hasMsvc = $false
if (Test-Path $vswhere) {
    $vc = & $vswhere -latest -products * `
        -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 `
        -property installationPath 2>$null
    if ($vc) { $hasMsvc = $true; Write-Host "   MSVC C++ toolchain (OK): $vc" }
}
if (-not $hasMsvc) {
    Write-Host '   WARNING: could not confirm the Visual Studio C++ Build Tools ("Desktop' -ForegroundColor Yellow
    Write-Host '            development with C++" workload). The node-pty native rebuild in' -ForegroundColor Yellow
    Write-Host '            step [5/8] will fail without it. Install with:' -ForegroundColor Yellow
    Write-Host '            winget install Microsoft.VisualStudio.2022.BuildTools --override "--quiet --add Microsoft.VisualStudio.Workload.VCTools --includeRecommended"' -ForegroundColor Yellow
    Write-Host '            Continuing — the rebuild step will surface the real error if it is missing.' -ForegroundColor Yellow
}

# 0b. npm cache health (Problem 1: a cache on a D:/Dev-Drive can throw
#     "UNKNOWN, errno -4094" under an AV/filter driver, breaking every install).
#     If `npm cache verify` errors, redirect to a fresh cache under the user
#     profile on C:. We export $env:npm_config_cache so the redirect STICKS for
#     every npm/npx invocation below (otherwise a later npx falls back to the
#     broken cache).
Write-Host '[1/8] npm cache health' -ForegroundColor Yellow
$cacheOk = $true
try {
    npm cache verify *> $null
    if ($LASTEXITCODE -ne 0) { $cacheOk = $false }
} catch {
    $cacheOk = $false
}
if (-not $cacheOk) {
    $freshCache = Join-Path $env:USERPROFILE '.npm-cache-selfconnect'
    if (-not (Test-Path $freshCache)) { New-Item -ItemType Directory -Path $freshCache -Force | Out-Null }
    $env:npm_config_cache = $freshCache
    Write-Host "   npm cache verify FAILED — redirecting all npm/npx calls to a fresh cache:" -ForegroundColor Yellow
    Write-Host "     $freshCache" -ForegroundColor Yellow
    Write-Host "   (set for this process so every step below uses it.)" -ForegroundColor Yellow
} else {
    Write-Host '   npm cache verify (OK).'
}

# 2. Install dependencies.
Write-Host '[2/8] npm install' -ForegroundColor Yellow
npm install
if ($LASTEXITCODE -ne 0) {
    Fail 'npm install failed. If you saw "UNKNOWN ... errno -4094", your npm cache drive is blocked (AV / Dev Drive filter). Set a C: cache and retry: $env:npm_config_cache = "$env:USERPROFILE\.npm-cache-selfconnect"; npm install. See docs/WINDOWS-RUN.md.'
}

# 3. Copy .env from the example if it does not yet exist.
Write-Host '[3/8] ensure .env' -ForegroundColor Yellow
if (-not (Test-Path '.env.example')) {
    Fail '.env.example is missing from the repo — cannot create .env. Re-clone the repository.'
}
if (-not (Test-Path '.env')) {
    Copy-Item '.env.example' '.env'
    Write-Host '   created .env from .env.example — edit it to add provider keys (optional; local-only works with none).'
} else {
    Write-Host '   .env already exists; leaving it untouched.'
}

# 3b. Ensure runtime data directories exist (ledger, sessions, checkpoints, keys).
Write-Host '[4/8] ensure ./data directories' -ForegroundColor Yellow
foreach ($d in @('data', 'data\sessions', 'data\checkpoints', 'data\keys', 'data\a2a', 'data\context-store')) {
    if (-not (Test-Path $d)) { New-Item -ItemType Directory -Path $d -Force | Out-Null }
}
Write-Host '   data directories present.'

# 5. Rebuild node-pty against the Electron ABI (ConPTY).
Write-Host '[5/8] electron-rebuild node-pty (Electron ABI / ConPTY)' -ForegroundColor Yellow

# Problem 4: node-pty's gyp files require Spectre-mitigated MSVC libs. If this VS
# install lacks them, the rebuild dies with MSB8040. This patch (run every setup,
# AFTER install and BEFORE rebuild) flips the flag off when the libs are absent.
# It edits node_modules, so it MUST run after each fresh install (which wipes it).
Write-Host '   applying node-pty Spectre-mitigation fix (if needed)' -ForegroundColor Yellow
node scripts/fix-node-pty-spectre.cjs
if ($LASTEXITCODE -ne 0) { Fail 'fix-node-pty-spectre.cjs failed (see output above).' }

# Problem 3: when NoDefaultCurrentDirectoryInExePath=1 is set machine-wide, cmd.exe
# refuses to run winpty's GetCommitHash.bat from the current directory, so the
# rebuild fails with "GetCommitHash.bat is not recognized". Clear it for this
# process only (does not touch the machine/user setting).
if ($env:NoDefaultCurrentDirectoryInExePath) {
    Write-Host '   clearing NoDefaultCurrentDirectoryInExePath for this process (winpty build fix)' -ForegroundColor Yellow
    $env:NoDefaultCurrentDirectoryInExePath = $null
}

npx electron-rebuild -f -w node-pty
if ($LASTEXITCODE -ne 0) {
    Fail 'electron-rebuild failed. Common fresh-machine causes: missing VS C++ Build Tools / Python; MSB8040 (Spectre libs — the fix script should have handled it); or "GetCommitHash.bat is not recognized" (NoDefaultCurrentDirectoryInExePath — cleared above). See docs/WINDOWS-RUN.md Troubleshooting.'
}

# 5b. Verify node-pty loads AND a real ConPTY child spawns, under Electron.
# Problem 5: `electron -e "..."` does NOT work (Electron treats the payload as an
# app path and hangs with a dialog). Run a real smoke FILE instead.
Write-Host '   node-pty + ConPTY smoke test under Electron' -ForegroundColor Yellow
npx electron scripts/pty-smoke.js
if ($LASTEXITCODE -ne 0) {
    Fail 'node-pty rebuilt but the Electron+ConPTY smoke test failed. Re-run electron-rebuild and confirm the installed Electron major matches package.json (31). See docs/WINDOWS-RUN.md.'
}
Write-Host '   node-pty + ConPTY smoke PASS (NODE_PTY_OK).'

# 6. Typecheck.
Write-Host '[6/8] npm run typecheck' -ForegroundColor Yellow
npm run typecheck
if ($LASTEXITCODE -ne 0) { Fail 'typecheck failed (see output above).' }

# 7. Tests.
Write-Host '[7/8] npm test' -ForegroundColor Yellow
npm test
if ($LASTEXITCODE -ne 0) { Fail 'tests failed (see output above).' }

# 8. Production build.
Write-Host '[8/8] npm run build' -ForegroundColor Yellow
npm run build
if ($LASTEXITCODE -ne 0) { Fail 'build failed (see output above).' }

Write-Host '== All green. Launch with: npm start ==' -ForegroundColor Green

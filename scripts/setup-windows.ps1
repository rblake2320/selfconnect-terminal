# SelfConnect Terminal — Windows 11 setup script.
# Rebuilds node-pty against the Electron ABI (ConPTY) and runs all green checks.
#
# Prerequisites (see docs/WINDOWS-RUN.md for exact install commands):
#   - Node 20+ (https://nodejs.org)
#   - Python 3.x (node-gyp dependency for the node-pty native addon)
#   - Visual Studio C++ Build Tools ("Desktop development with C++" workload),
#     required to compile node-pty's native addon on Windows.
#   - If scripts are blocked, run in PowerShell:
#       Set-ExecutionPolicy -Scope Process -ExecutionPolicy Bypass
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
Write-Host '[0/7] checking prerequisites' -ForegroundColor Yellow

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
    Write-Host '            step [4/7] will fail without it. Install with:' -ForegroundColor Yellow
    Write-Host '            winget install Microsoft.VisualStudio.2022.BuildTools --override "--quiet --add Microsoft.VisualStudio.Workload.VCTools --includeRecommended"' -ForegroundColor Yellow
    Write-Host '            Continuing — the rebuild step will surface the real error if it is missing.' -ForegroundColor Yellow
}

# 1. Install dependencies.
Write-Host '[1/7] npm install' -ForegroundColor Yellow
npm install
if ($LASTEXITCODE -ne 0) { Fail 'npm install failed (see output above).' }

# 2. Copy .env from the example if it does not yet exist.
Write-Host '[2/7] ensure .env' -ForegroundColor Yellow
if (-not (Test-Path '.env.example')) {
    Fail '.env.example is missing from the repo — cannot create .env. Re-clone the repository.'
}
if (-not (Test-Path '.env')) {
    Copy-Item '.env.example' '.env'
    Write-Host '   created .env from .env.example — edit it to add provider keys (optional; local-only works with none).'
} else {
    Write-Host '   .env already exists; leaving it untouched.'
}

# 3. Ensure runtime data directories exist (ledger, sessions, checkpoints, keys).
Write-Host '[3/7] ensure ./data directories' -ForegroundColor Yellow
foreach ($d in @('data', 'data\sessions', 'data\checkpoints', 'data\keys', 'data\a2a', 'data\context-store')) {
    if (-not (Test-Path $d)) { New-Item -ItemType Directory -Path $d -Force | Out-Null }
}
Write-Host '   data directories present.'

# 4. Rebuild node-pty against the Electron ABI (ConPTY).
Write-Host '[4/7] electron-rebuild node-pty (Electron ABI / ConPTY)' -ForegroundColor Yellow
npx electron-rebuild -f -w node-pty
if ($LASTEXITCODE -ne 0) {
    Fail 'electron-rebuild failed. Most common cause on a fresh machine: missing the Visual Studio C++ Build Tools ("Desktop development with C++") or Python. See docs/WINDOWS-RUN.md Troubleshooting.'
}

# 4b. Verify the native binding actually loads against the Electron ABI.
Write-Host '   verifying node-pty native binding loads under Electron' -ForegroundColor Yellow
npx electron -e "try { require('node-pty'); console.log('node-pty OK'); } catch (e) { console.error('node-pty FAILED to load:', e.message); process.exit(1); }"
if ($LASTEXITCODE -ne 0) {
    Fail 'node-pty rebuilt but failed to load under Electron (ABI mismatch). Re-run electron-rebuild, and confirm the installed Electron major version matches package.json (31). See docs/WINDOWS-RUN.md.'
}
Write-Host '   node-pty loads under Electron (OK).'

# 5. Typecheck.
Write-Host '[5/7] npm run typecheck' -ForegroundColor Yellow
npm run typecheck
if ($LASTEXITCODE -ne 0) { Fail 'typecheck failed (see output above).' }

# 6. Tests.
Write-Host '[6/7] npm test' -ForegroundColor Yellow
npm test
if ($LASTEXITCODE -ne 0) { Fail 'tests failed (see output above).' }

# 7. Production build.
Write-Host '[7/7] npm run build' -ForegroundColor Yellow
npm run build
if ($LASTEXITCODE -ne 0) { Fail 'build failed (see output above).' }

Write-Host '== All green. Launch with: npm start ==' -ForegroundColor Green

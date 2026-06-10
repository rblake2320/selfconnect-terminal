# SelfConnect Terminal — Windows 11 setup script.
# Rebuilds node-pty against the Electron ABI (ConPTY) and runs all green checks.
#
# Prerequisites:
#   - Node 20+ (https://nodejs.org)
#   - Visual Studio C++ Build Tools (Desktop development with C++ workload),
#     required to compile node-pty's native addon on Windows.
#   - If scripts are blocked, run in an elevated PowerShell:
#       Set-ExecutionPolicy -Scope Process -ExecutionPolicy Bypass
#
# Usage:
#   pwsh -File scripts/setup-windows.ps1

$ErrorActionPreference = 'Stop'

Write-Host '== SelfConnect Terminal: Windows setup ==' -ForegroundColor Cyan

# 1. Install dependencies.
Write-Host '[1/6] npm install' -ForegroundColor Yellow
npm install

# 2. Copy .env from the example if it does not yet exist.
Write-Host '[2/6] ensure .env' -ForegroundColor Yellow
if (-not (Test-Path '.env')) {
    Copy-Item '.env.example' '.env'
    Write-Host '   created .env from .env.example — edit it to add provider keys.'
} else {
    Write-Host '   .env already exists; leaving it untouched.'
}

# 3. Rebuild node-pty against the Electron ABI (ConPTY).
Write-Host '[3/6] electron-rebuild node-pty (Electron ABI / ConPTY)' -ForegroundColor Yellow
npx electron-rebuild -f -w node-pty

# 4. Typecheck.
Write-Host '[4/6] npm run typecheck' -ForegroundColor Yellow
npm run typecheck

# 5. Tests.
Write-Host '[5/6] npm test' -ForegroundColor Yellow
npm test

# 6. Production build.
Write-Host '[6/6] npm run build' -ForegroundColor Yellow
npm run build

Write-Host '== All green. Launch with: npm start ==' -ForegroundColor Green

$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $PSScriptRoot
$source = Join-Path $projectRoot 'release\win-unpacked'
if (!(Test-Path -LiteralPath (Join-Path $source 'SelfConnect Terminal.exe'))) { throw 'Build the Windows artifact first: npm run dist:local' }
$installRoot = Join-Path $env:LOCALAPPDATA 'Programs\SelfConnect Terminal'
$releaseRoot = Join-Path $installRoot ('build-' + (Get-Date -Format 'yyyyMMdd-HHmmss'))
New-Item -ItemType Directory -Path $releaseRoot -Force | Out-Null
Copy-Item -Path (Join-Path $source '*') -Destination $releaseRoot -Recurse
$exe = Join-Path $releaseRoot 'SelfConnect Terminal.exe'
$desktop = [Environment]::GetFolderPath('Desktop')
$shortcutPath = Join-Path $desktop 'SelfConnect Terminal.lnk'
$shell = New-Object -ComObject WScript.Shell
$shortcut = $shell.CreateShortcut($shortcutPath)
$shortcut.TargetPath = $exe
$shortcut.WorkingDirectory = $env:USERPROFILE
$shortcut.Description = 'SelfConnect Terminal - real shell, saved history and on-demand Jev'
$shortcut.Save()
$receipt = [ordered]@{ installedAt=(Get-Date).ToUniversalTime().ToString('o'); executable=$exe; shortcut=$shortcutPath; sha256=(Get-FileHash -LiteralPath $exe -Algorithm SHA256).Hash; signing='unsigned local build' }
$receipt | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $installRoot 'latest-install.json') -Encoding utf8
$receipt | ConvertTo-Json

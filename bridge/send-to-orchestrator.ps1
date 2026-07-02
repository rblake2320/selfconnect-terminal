# Inner Claude -> Orchestrator command-line injector.
# The inner Claude runs:  pwsh -File bridge\send-to-orchestrator.ps1 "your message"
# This injects the message as real keystrokes into the Orchestrator's command-line
# inbox window (ORCH-CLI-INBOX) — the same keystroke-injection method the
# Orchestrator uses to drive the inner Claude's terminal. Fully symmetric.
param([Parameter(Mandatory = $true)][string]$Message)
$sh = New-Object -ComObject WScript.Shell
if (-not $sh.AppActivate('ORCH-CLI-INBOX')) {
  Write-Error 'ORCH-CLI-INBOX window not found — is the Orchestrator inbox console open?'
  exit 1
}
Start-Sleep -Milliseconds 450
Add-Type -AssemblyName System.Windows.Forms
# Escape SendKeys metacharacters so the message is typed literally.
$esc = [regex]::Replace($Message, '[+^%~(){}\[\]]', { param($m) '{' + $m.Value + '}' })
[System.Windows.Forms.SendKeys]::SendWait($esc)
Start-Sleep -Milliseconds 300
[System.Windows.Forms.SendKeys]::SendWait('{ENTER}')
Write-Host 'Injected into Orchestrator command line (ORCH-CLI-INBOX).'

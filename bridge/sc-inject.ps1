# sc-inject.ps1 — SelfConnect injector. Type a message into ANY window by title,
# the same keystroke-injection method the orchestrator uses to drive other terminals.
# This is how an agent "types in" to another terminal / app to hold an AI-to-AI talk.
#
# Usage:
#   pwsh -File bridge\sc-inject.ps1 -WindowTitle "SelfConnect Terminal" -Message "hello there"
#   pwsh -File bridge\sc-inject.ps1 -WindowTitle "Comparison of AI Build Prompts" -Message "hi" -Enter
#
# Notes:
#   -Enter presses Enter after typing. Some inputs send on Enter; others (e.g. a chat
#    box with a Submit button) treat Enter as a newline — for those, omit -Enter and
#    click the send control, or take a screenshot to read the reply.
param(
  [Parameter(Mandatory = $true)][string]$WindowTitle,
  [Parameter(Mandatory = $true)][string]$Message,
  [switch]$Enter
)
$sh = New-Object -ComObject WScript.Shell
if (-not $sh.AppActivate($WindowTitle)) {
  Write-Error "Window matching '$WindowTitle' not found. Run: Get-Process | ? {`$_.MainWindowTitle} | select Id,MainWindowTitle"
  exit 1
}
Start-Sleep -Milliseconds 500
Add-Type -AssemblyName System.Windows.Forms
# Escape SendKeys metacharacters so the message types literally.
$esc = [regex]::Replace($Message, '[+^%~(){}\[\]]', { param($m) '{' + $m.Value + '}' })
[System.Windows.Forms.SendKeys]::SendWait($esc)
if ($Enter) { Start-Sleep -Milliseconds 300; [System.Windows.Forms.SendKeys]::SendWait('{ENTER}') }
Write-Host "Injected into '$WindowTitle'$(if($Enter){' + Enter'})."

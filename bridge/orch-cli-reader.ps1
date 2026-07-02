# Orchestrator command-line INBOX.
# A live console the inner Claude can inject keystrokes into (symmetric to how the
# Orchestrator injects into the inner Claude's terminal). Every line received is
# timestamped and appended to orchestrator-cli.log, which the Orchestrator reads.
$Host.UI.RawUI.WindowTitle = 'ORCH-CLI-INBOX'
$log = 'C:\Users\techai\selfconnect-terminal\bridge\orchestrator-cli.log'
Write-Host '======================================================'
Write-Host ' ORCHESTRATOR COMMAND-LINE INBOX'
Write-Host ' Lines injected here are logged for the Orchestrator Claude.'
Write-Host '======================================================'
while ($true) {
  $line = Read-Host 'inner>'
  if ($line) {
    ('[{0}] {1}' -f (Get-Date -Format 'HH:mm:ss'), $line) | Add-Content -Path $log -Encoding utf8
  }
}

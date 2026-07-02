# Press Escape on Codex (declines gh approval), then inject redirect message
Add-Type @"
using System;
using System.Runtime.InteropServices;
public class WinAPI {
    [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
    [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);
}
"@

$pid = 10996
$proc = Get-Process -Id $pid -ErrorAction Stop
$hwnd = $proc.MainWindowHandle
Write-Host "Found window: $($proc.MainWindowTitle) handle=$hwnd"

# Bring to foreground
[WinAPI]::ShowWindow($hwnd, 9)  # SW_RESTORE
[WinAPI]::SetForegroundWindow($hwnd)
Start-Sleep -Milliseconds 600

# Send Escape to dismiss the gh approval prompt (option 3)
$shell = New-Object -ComObject WScript.Shell
$shell.AppActivate($pid)
Start-Sleep -Milliseconds 400
$shell.SendKeys("{ESC}")
Start-Sleep -Milliseconds 800
Write-Host "Sent ESC"

# Give Codex a moment to process the decline
Start-Sleep -Milliseconds 1200

# Now inject the redirect: skip gh, read the doc, report findings
$msg = "Skip gh entirely. The session document already exists at docs\SELFCONNECT-SESSION.md (293 lines). Read it with Get-Content, then give me a 5-bullet summary of what it covers and flag anything missing or wrong."
$shell.AppActivate($pid)
Start-Sleep -Milliseconds 400
$shell.SendKeys($msg)
Start-Sleep -Milliseconds 300
$shell.SendKeys("{ENTER}")
Write-Host "Injected redirect + ENTER"

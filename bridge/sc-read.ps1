# sc-read.ps1 — SelfConnect read-back. Capture a target window (by title) to a PNG so
# you can READ the peer's reply. This is the other half of the round-trip: sc-inject.ps1
# SENDS, sc-read.ps1 lets you RECEIVE. Together they make "have a talk", not just "type at".
#
# The talk loop is:  inject text  ->  wait  ->  send Enter as a SEPARATE step  ->  sc-read  ->  open the PNG with the Read tool.
#
# Usage:
#   pwsh -File bridge\sc-read.ps1 -WindowTitle "Comparison of AI Build Prompts"
#   pwsh -File bridge\sc-read.ps1 -WindowTitle "SelfConnect Terminal" -OutFile bridge\reply.png
# Then open the saved PNG with your Read tool to read the reply.
param(
  [Parameter(Mandatory = $true)][string]$WindowTitle,
  [string]$OutFile = "bridge\sc-read.png",
  [int]$WaitMs = 800
)
Add-Type @'
using System; using System.Runtime.InteropServices;
public class SCWin {
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left, Top, Right, Bottom; }
}
'@
$sh = New-Object -ComObject WScript.Shell
if (-not $sh.AppActivate($WindowTitle)) {
  Write-Error "Window matching '$WindowTitle' not found. Run: Get-Process | ? {`$_.MainWindowTitle} | select Id,MainWindowTitle"
  exit 1
}
Start-Sleep -Milliseconds $WaitMs
$proc = Get-Process | Where-Object { $_.MainWindowTitle -like "*$WindowTitle*" } | Select-Object -First 1
$r = New-Object SCWin+RECT
[void][SCWin]::GetWindowRect($proc.MainWindowHandle, [ref]$r)
$w = $r.Right - $r.Left; $h = $r.Bottom - $r.Top
Add-Type -AssemblyName System.Windows.Forms, System.Drawing
$bmp = New-Object System.Drawing.Bitmap $w, $h
$g = [System.Drawing.Graphics]::FromImage($bmp)
$g.CopyFromScreen($r.Left, $r.Top, 0, 0, (New-Object System.Drawing.Size $w, $h))
$bmp.Save($OutFile)
$g.Dispose(); $bmp.Dispose()
Write-Host "Captured '$WindowTitle' ($($w)x$($h)) to $OutFile — open it with the Read tool to read the reply."

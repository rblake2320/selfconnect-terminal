import { existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';

/** Decrypt only in the daemon. Never inject this credential into the renderer or PTY. */
export function loadJevCredential(file: string, envKey = ''): string {
  if (envKey.trim()) return envKey.trim();
  if (!existsSync(file)) throw new Error('Jev key is not configured. Import your key with scripts/import-jev-key.py.');
  if (process.platform !== 'win32') throw new Error('This saved Jev key requires its Windows user. Set JEV_API_KEY on other platforms.');
  const script = `$ErrorActionPreference='Stop'; $env:PSModulePath=Join-Path $PSHOME Modules; Import-Module Microsoft.PowerShell.Security; $s=ConvertTo-SecureString ([IO.File]::ReadAllText($env:SC_JEV_KEY_FILE)); $p=[Runtime.InteropServices.Marshal]::SecureStringToBSTR($s); try { [Console]::Write([Runtime.InteropServices.Marshal]::PtrToStringBSTR($p)) } finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($p) }`;
  try {
    const key = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
      encoding: 'utf8', timeout: 10000, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, SC_JEV_KEY_FILE: file },
    }).trim();
    if (!key) throw new Error('empty');
    return key;
  } catch { throw new Error('Could not unlock the saved Jev key for this Windows user. Re-import it.'); }
}

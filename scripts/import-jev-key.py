"""Read only the requested XLSX cell and save it with Windows user DPAPI.

No cell value, key fragment, hash, or neighboring cells are printed.
Usage: python scripts/import-jev-key.py <workbook.xlsx> [E82]
"""
import json
import os
from pathlib import Path
import subprocess
import sys
import xml.etree.ElementTree as ET
from zipfile import ZipFile

if os.name != 'nt':
    raise SystemExit('This credential importer requires Windows DPAPI.')
source = Path(sys.argv[1])
cell_address = sys.argv[2] if len(sys.argv) > 2 else 'E82'
ns = {'s': 'http://schemas.openxmlformats.org/spreadsheetml/2006/main'}
with ZipFile(source) as archive:
    workbook = ET.fromstring(archive.read('xl/workbook.xml'))
    sheets = workbook.find('s:sheets', ns)
    view = workbook.find('s:bookViews/s:workbookView', ns)
    index = int(view.get('activeTab', '0')) if view is not None else 0
    sheet = list(sheets)[index]
    rid = sheet.get('{http://schemas.openxmlformats.org/officeDocument/2006/relationships}id')
    rels = ET.fromstring(archive.read('xl/_rels/workbook.xml.rels'))
    target = next(r.get('Target') for r in rels if r.get('Id') == rid)
    target = target.lstrip('/') if target.startswith('/') else 'xl/' + target
    xml = ET.fromstring(archive.read(target))
    cell = xml.find(f'.//s:c[@r="{cell_address}"]', ns)
    if cell is None or cell.find('s:f', ns) is not None:
        raise SystemExit('Requested cell is missing or a formula; no credential imported.')
    if cell.get('t') == 's':
        strings = ET.fromstring(archive.read('xl/sharedStrings.xml'))
        item = list(strings)[int(cell.find('s:v', ns).text)]
        key = ''.join(t.text or '' for t in item.iterfind('.//s:t', ns))
    elif cell.get('t') == 'inlineStr':
        key = ''.join(t.text or '' for t in cell.iterfind('.//s:t', ns))
    else:
        value = cell.find('s:v', ns)
        key = value.text if value is not None else ''
key = key.strip()
if len(key) < 16 or any(c.isspace() for c in key):
    raise SystemExit('Requested cell is not a plausible API credential; nothing saved.')
destination = Path(os.environ['APPDATA']) / 'SelfConnect Terminal' / 'jev-key.dpapi'
env = {**os.environ, 'SC_IMPORT_DESTINATION': str(destination)}
script = r'''
$ErrorActionPreference = 'Stop'
$env:PSModulePath = Join-Path $PSHOME Modules
Import-Module Microsoft.PowerShell.Security
$key = [Console]::In.ReadToEnd().Trim()
$encrypted = ConvertFrom-SecureString (ConvertTo-SecureString $key -AsPlainText -Force)
$target = $env:SC_IMPORT_DESTINATION
[IO.Directory]::CreateDirectory([IO.Path]::GetDirectoryName($target)) | Out-Null
$tmp = $target + '.tmp'
[IO.File]::WriteAllText($tmp, $encrypted)
$acl = New-Object System.Security.AccessControl.FileSecurity
$acl.SetAccessRuleProtection($true, $false)
$sid = [System.Security.Principal.WindowsIdentity]::GetCurrent().User
$acl.AddAccessRule((New-Object System.Security.AccessControl.FileSystemAccessRule($sid,'FullControl','Allow')))
Set-Acl -LiteralPath $tmp -AclObject $acl
if (Test-Path -LiteralPath $target) { Copy-Item -LiteralPath $target -Destination ($target + '.backup-' + (Get-Date -Format yyyyMMddHHmmss)) }
Move-Item -LiteralPath $tmp -Destination $target -Force
$roundtrip = ConvertTo-SecureString ([IO.File]::ReadAllText($target))
$ptr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($roundtrip)
try { if ([Runtime.InteropServices.Marshal]::PtrToStringBSTR($ptr) -cne $key) { throw 'Credential verification failed' } }
finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($ptr) }
'''
result = subprocess.run(['powershell.exe', '-NoProfile', '-NonInteractive', '-Command', script], input=key, text=True, capture_output=True, env=env)
if result.returncode:
    safe_error = result.stderr.replace(key, '[REDACTED]')
    raise SystemExit('Credential encryption/import failed: ' + safe_error[-1200:])
print(json.dumps({'imported': True, 'cell': cell_address, 'storage': str(destination), 'protection': 'Windows current-user DPAPI; owner-only file ACL', 'roundtripVerified': True}))

#!/usr/bin/env node
/**
 * fix-node-pty-spectre.cjs — make node-pty build on Windows when the installed
 * Visual Studio C++ Build Tools LACK the Spectre-mitigated runtime libraries.
 *
 * Why: node-pty's gyp files hard-code `'SpectreMitigation': 'Spectre'`. If the
 * VS install does not include the Spectre-mitigated VC libs, the native rebuild
 * fails with MSB8040 ("Spectre-mitigated libraries are required..."). The clean
 * fix is to install that VS component; this script is the fallback that lets the
 * build proceed by flipping the gyp flag to 'false' when those libs are absent.
 *
 * This lives in node_modules and is WIPED by every fresh `npm install`, so
 * setup-windows.ps1 runs this AFTER install and BEFORE electron-rebuild on every
 * setup. It is idempotent (a second run is a no-op) and a no-op off Windows.
 *
 * Behavior:
 *   - Detects Spectre-mitigated libs via `vswhere` (component
 *     Microsoft.VisualStudio.Component.VC.Runtimes.x86.x64.Spectre). If present,
 *     it does nothing and tells you to keep SpectreMitigation as-is.
 *   - If absent (or detection is not possible), it patches the three gyp lines
 *     replacing 'SpectreMitigation': 'Spectre' with 'false', printing each file
 *     it changed and why.
 *
 * Usage:
 *   node scripts/fix-node-pty-spectre.cjs            # auto-detect, patch if needed
 *   node scripts/fix-node-pty-spectre.cjs --force    # patch regardless of detection
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const FORCE = process.argv.includes('--force');

const GYP_FILES = [
  path.join('node_modules', 'node-pty', 'binding.gyp'),
  path.join('node_modules', 'node-pty', 'deps', 'winpty', 'src', 'winpty.gyp'),
];

const NEEDLE = /'SpectreMitigation':\s*'Spectre'/g;
const REPLACEMENT = "'SpectreMitigation': 'false'";

function log(msg) {
  process.stdout.write(`[spectre-fix] ${msg}\n`);
}

/** Off Windows there is nothing to do — the MSVC Spectre flag is Windows-only. */
function isWindows() {
  return process.platform === 'win32';
}

/**
 * Return true if the Spectre-mitigated VC runtime libraries appear to be
 * installed. Uses vswhere; on any failure we return null ("unknown").
 */
function spectreLibsPresent() {
  const vswhere = path.join(
    process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)',
    'Microsoft Visual Studio',
    'Installer',
    'vswhere.exe',
  );
  if (!fs.existsSync(vswhere)) return null;
  try {
    const out = execFileSync(
      vswhere,
      [
        '-latest',
        '-products', '*',
        '-requires', 'Microsoft.VisualStudio.Component.VC.Runtimes.x86.x64.Spectre',
        '-property', 'installationPath',
      ],
      { encoding: 'utf8' },
    );
    return out.trim().length > 0;
  } catch {
    return null;
  }
}

function patchFile(file) {
  if (!fs.existsSync(file)) {
    log(`skip (not found): ${file}`);
    return 0;
  }
  const before = fs.readFileSync(file, 'utf8');
  if (!NEEDLE.test(before)) {
    // Already patched, or the upstream gyp no longer sets it.
    log(`already ok (no 'Spectre' flag): ${file}`);
    return 0;
  }
  const after = before.replace(NEEDLE, REPLACEMENT);
  fs.writeFileSync(file, after, 'utf8');
  const count = (before.match(NEEDLE) || []).length;
  log(`patched ${count} occurrence(s) in ${file} ('Spectre' -> 'false')`);
  return count;
}

function main() {
  if (!isWindows() && !FORCE) {
    log(`platform is ${process.platform}, not win32 — nothing to do.`);
    return;
  }

  if (!FORCE) {
    const present = spectreLibsPresent();
    if (present === true) {
      log('Spectre-mitigated VC libraries ARE installed — leaving node-pty gyp');
      log('files as-is (SpectreMitigation stays \'Spectre\'). No patch needed.');
      return;
    }
    if (present === null) {
      log('could not confirm Spectre libs via vswhere (unknown) — patching');
      log('defensively so the rebuild does not fail with MSB8040.');
    } else {
      log('Spectre-mitigated VC libraries are NOT installed — patching node-pty');
      log('gyp files so the native rebuild does not fail with MSB8040.');
    }
  } else {
    log('--force given — patching node-pty gyp files unconditionally.');
  }

  let total = 0;
  for (const f of GYP_FILES) total += patchFile(f);

  if (total === 0) {
    log('no changes made (already patched or flag absent).');
  } else {
    log(`done — flipped SpectreMitigation to 'false' in ${total} place(s).`);
    log('NOTE: this edits node_modules and is re-applied on every setup run.');
    log('For a clean fix, install the VS component:');
    log('  "MSVC vNNN - VS 20NN C++ x64/x86 Spectre-mitigated libs".');
  }
}

main();

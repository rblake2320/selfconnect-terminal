// node-pty + ConPTY smoke test, run UNDER Electron (not plain node) so it
// exercises the exact ABI the app uses:
//   node_modules/electron/dist/electron.exe scripts/pty-smoke.js   (Windows)
//   npx electron scripts/pty-smoke.js                              (any OS)
//
// Why a file and not `electron -e "..."`: Electron treats the `-e` payload as an
// app PATH on Windows, pops an "Unable to find Electron app" dialog, and hangs.
// A real script file avoids that entirely.
//
// Prints `NODE_PTY_OK spawn=function exit=<code> sawData=<bool>` and exits 0 on
// success; prints `NODE_PTY_FAIL ...` and exits 1 on any failure.

const isWindows = process.platform === 'win32';

let pty;
try {
  pty = require('node-pty');
} catch (e) {
  console.error('NODE_PTY_FAIL require:', e && e.message ? e.message : e);
  process.exit(1);
}

if (typeof pty.spawn !== 'function') {
  console.error('NODE_PTY_FAIL spawn is not a function (binding did not load)');
  process.exit(1);
}

const shell = isWindows ? 'cmd.exe' : '/bin/sh';
const args = isWindows ? ['/c', 'echo', 'selfconnect-pty-ok'] : ['-c', 'echo selfconnect-pty-ok'];

let sawData = false;
let done = false;

function finish(code) {
  if (done) return;
  done = true;
  if (sawData) {
    console.log(`NODE_PTY_OK spawn=${typeof pty.spawn} exit=${code} sawData=${sawData}`);
    process.exit(0);
  } else {
    console.error(`NODE_PTY_FAIL no data from child (exit=${code})`);
    process.exit(1);
  }
}

try {
  const child = pty.spawn(shell, args, { name: 'xterm-color', cols: 80, rows: 24, cwd: process.cwd(), env: process.env });
  child.onData((d) => {
    if (d && d.length) sawData = true;
  });
  child.onExit(({ exitCode }) => finish(exitCode));
  // Safety timeout so the smoke test never hangs CI/setup.
  setTimeout(() => finish(0), 8000);
} catch (e) {
  console.error('NODE_PTY_FAIL spawn threw:', e && e.message ? e.message : e);
  process.exit(1);
}

const pty = require('node-pty');
const os = require('os');
const shell = process.env.COMSPEC || 'cmd.exe';
let out = '';
const p = pty.spawn(shell, ['/c', 'echo PTY_LIVE_%RANDOM%'], { cols: 80, rows: 24, cwd: process.cwd(), env: process.env });
p.onData(d => { out += d; });
p.onExit(({ exitCode }) => {
  console.log('NODE_PTY_OK spawn=' + (typeof pty.spawn) + ' exit=' + exitCode + ' sawData=' + /PTY_LIVE_/.test(out));
  process.exit(0);
});
setTimeout(() => { console.error('PTY_TIMEOUT out=' + JSON.stringify(out)); process.exit(2); }, 8000);

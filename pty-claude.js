// AI-to-AI SelfConnect demo: host an interactive `claude` inside a real ConPTY,
// inject a message using the SelfConnect protocol, read its reply back.
// Run under Electron so the Electron-ABI node-pty loads:
//   node_modules/electron/dist/electron.exe pty-claude.js
const pty = require('node-pty');

// Strip ANSI / OSC / alt-screen control so the transcript is human-readable.
function clean(s) {
  return s
    .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, '') // OSC
    .replace(/\x1b[@-Z\\-_]/g, '')
    .replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, '')         // CSI
    .replace(/\x1b[()][0-9A-Za-z]/g, '')
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f]/g, '');
}

// Clean env so the child doesn't think it's a nested Claude Code session.
const env = { ...process.env };
for (const k of Object.keys(env)) {
  if (/^CLAUDE(CODE)?(_|$)/i.test(k)) delete env[k];
}

const cwd = 'C:\\Users\\techai';
const shell = process.env.COMSPEC || 'cmd.exe';
let buf = '';
const p = pty.spawn(shell, [], { name: 'xterm-256color', cols: 120, rows: 40, cwd, env });
p.onData((d) => { buf += d; });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const MSG =
  'Hello — I am the orchestrator Claude Code agent in another terminal. This is an ' +
  'AI-to-AI SelfConnect test. Reply with ONE short sentence: confirm you received this ' +
  'and state your current working directory.';

(async () => {
  await sleep(1200);
  p.write('claude\r');          // launch interactive claude (subscription-safe TUI)
  await sleep(9000);            // let it boot
  const bootMark = buf.length;
  p.write(MSG);                 // inject text...
  await sleep(1300);            // ...wait...
  p.write('\r');                // ...then submit separately (SelfConnect protocol)
  await sleep(48000);           // collect the reply
  const reply = clean(buf.slice(bootMark));
  const tail = reply.split('\n').map((l) => l.replace(/\s+$/, '')).filter((l) => l.trim());
  console.log('=====BOOT (first 12 cleaned lines)=====');
  console.log(clean(buf.slice(0, bootMark)).split('\n').filter((l) => l.trim()).slice(0, 12).join('\n'));
  console.log('\n=====AFTER INJECTION (last 45 cleaned lines)=====');
  console.log(tail.slice(-45).join('\n'));
  process.exit(0);
})();

const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
if (process.platform !== 'win32') throw new Error('ConPTY shutdown gate requires Windows');
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'sce-shutdown-'));
const receipt = path.join(home, 'receipt.json');
const env = { ...process.env, SC_SHUTDOWN_RECEIPT: receipt,
  SELFCONNECT_A2A_MODE: 'off', SELFCONNECT_LOCAL_ONLY: 'true',
  SELFCONNECT_LEDGER_PATH: path.join(home, 'ledger.jsonl'),
  SELFCONNECT_SESSIONS_DIR: path.join(home, 'sessions') };
delete env.ELECTRON_RUN_AS_NODE;
const result = spawnSync(require('electron'), ['--disable-gpu', `--user-data-dir=${path.join(home, 'profile')}`,
  'scripts/electron-shutdown-probe.cjs'], { env, encoding: 'utf8', timeout: 25000 });
console.log(JSON.stringify({ status: result.status, error: result.error?.message, receipt,
  evidence: fs.existsSync(receipt) ? JSON.parse(fs.readFileSync(receipt, 'utf8')) : null }, null, 2));
if (result.status !== 0 || !fs.existsSync(receipt) || !JSON.parse(fs.readFileSync(receipt, 'utf8')).ok) {
  process.stderr.write(result.stderr || 'shutdown gate failed');
  process.exitCode = 1;
}

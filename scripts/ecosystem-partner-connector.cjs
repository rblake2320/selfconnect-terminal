/**
 * Ecosystem partner lane — connector CLI acceptance against the INSTALLED SelfConnect Terminal.
 * Proves: a real external connector CLI (GitHub via `gh`, existing login, read-only) runs inside the
 * installed app's PTY, its output reaches the renderer, and the saved history snapshot keeps it.
 * This is a CONNECTOR check only. It is NOT a skill-consumption check (no agent loads a skill here).
 * Focus-independent: typed through the preload IPC (ptyInput), not via OS keystrokes.
 *
 * Usage: SCT_TEST_EXE="<installed exe>" node scripts/ecosystem-partner-connector.cjs
 */
const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
const { _electron } = require('playwright');
const root = path.resolve(__dirname, '..');
const outDir = path.join(root, 'docs/ecosystem-20260922');
fs.mkdirSync(outDir, { recursive: true });
const work = fs.mkdtempSync(path.join(os.tmpdir(), 'sct-eco-conn-'));
const exe = process.env.SCT_TEST_EXE || path.join(root, 'release/win-unpacked/SelfConnect Terminal.exe');
const env = { ...process.env, SELFCONNECT_USER_DATA_DIR: path.join(work, 'profile'), SELFCONNECT_A2A_MODE: 'off', SELFCONNECT_LOCAL_ONLY: '1' };
for (const k of ['ELECTRON_RUN_AS_NODE', 'VITE_DEV_SERVER_URL']) delete env[k];
const results = { at: new Date().toISOString(), exe, work, checks: [], errors: [] };
const check = (name, outcome, detail) => { results.checks.push({ name, outcome, detail }); if (outcome === 'Failed') throw new Error(name); };
const strip = (s) => s.replace(/\x1b\][^\x07]*(?:\x07|\x1b\\)/g, '').replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '');
let app;
(async () => {
  try {
    app = await _electron.launch({ executablePath: exe, args: ['--disable-gpu'], cwd: root, env, timeout: 25000 });
    const page = await app.firstWindow();
    page.on('pageerror', (e) => results.errors.push(e.message));
    await page.waitForFunction(() => !!window.selfconnect);
    await page.evaluate(() => { window.__out = ''; window.selfconnect.onPtyData((d) => { window.__out += d; }); });
    const type = (line) => page.evaluate((l) => window.selfconnect.ptyInput(l + '\r'), line);
    // The PTY echoes the typed line, so a marker must appear twice: once echoed, once printed.
    const waitFor = async (marker, ms = 30000) => {
      await page.waitForFunction((m) => window.__out.split(m).length >= 3, marker, { timeout: ms });
      return strip(await page.evaluate(() => window.__out));
    };

    // Connector login state (read-only). Output goes through the real ConPTY shell.
    await type('gh auth status 2>&1 & echo GH_STATUS_DONE');
    const out1 = await waitFor('GH_STATUS_DONE');
    const loggedIn = /Logged in to github\.com/.test(out1);
    check('gh CLI with existing login runs inside installed PTY', loggedIn ? 'Worked' : 'Blocked', { excerpt: out1.split('\n').filter((l) => /github\.com|Logged|account/.test(l)).slice(0, 4), tail: out1.slice(-800) });
    if (!loggedIn) throw new Error('no gh login; connector check blocked');

    // Read-only connector call against the private repo tracker issue.
    await type('gh issue view 1 --json number,title,state 2>&1 & echo GH_ISSUE_DONE');
    const out2 = await waitFor('GH_ISSUE_DONE');
    const m = out2.match(/\{[^{}]*"number"\s*:\s*1[^{}]*\}/);
    let issue = null; try { issue = m && JSON.parse(m[0]); } catch { /* keep null */ }
    check('read-only GitHub connector call returns real issue data in the app', issue && issue.number === 1 && typeof issue.title === 'string' && issue.title.length > 0 ? 'Worked' : 'Failed', { issue });

    // The daemon ingested it: Jev preview (local redacted snapshot, no send) sees it.
    const preview = await page.evaluate(() => window.selfconnect.jevPreview());
    check('connector output is visible to the app daemon (Jev preview, not sent)', preview.text.includes('GH_ISSUE_DONE') ? 'Worked' : 'Failed', { characters: preview.text.length });

    // Close normally; saved history must contain the connector output.
    await app.close(); app = null;
    const sessDir = path.join(work, 'profile/data/sessions');
    const files = fs.existsSync(sessDir) ? fs.readdirSync(sessDir).filter((f) => f.endsWith('.json')) : [];
    const saved = files.some((f) => fs.readFileSync(path.join(sessDir, f), 'utf8').includes('GH_ISSUE_DONE'));
    check('connector output survives in saved history snapshot', saved ? 'Worked' : 'Failed', { snapshots: files.length });

    results.checks.push({ name: 'skill consumption by an agent running inside installed SCT', outcome: 'Blocked', detail: { reason: 'Requires a live agent inside the installed app loading a skill file; owner limited this run to the two existing partners, and the partner-in-app migration is owned by the lead. Not simulated.' } });
  } catch (e) {
    results.errors.push(e.stack || String(e));
    process.exitCode = 1;
  } finally {
    if (app) await app.close().catch((e) => results.errors.push(e.message));
    fs.writeFileSync(path.join(outDir, 'partner-connector-results.json'), JSON.stringify(results, null, 2));
    console.log(JSON.stringify(results, null, 2));
  }
})();

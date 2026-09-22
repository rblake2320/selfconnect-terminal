if (process.env.SCT_ALLOW_PAID_API !== '1') throw new Error('Paid API acceptance is disabled. Current owner policy is subscription-only; do not enable without a new explicit authorization.');
/**
 * Ecosystem partner lane — "is it wired?" check using Jev as the reader, against the INSTALLED exe.
 * Real cmd.exe PTY commands run in the app; Jev (TypeSafe, live, existing DPAPI key) classifies the
 * real output; the dock state is read back over IPC and checked against what the subsystems should
 * show after those actions. Two explicit live Jev calls; nothing else leaves the machine.
 *
 * Usage: SCT_TEST_EXE="<installed exe>" node scripts/ecosystem-partner-jev-wiring.cjs
 */
const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
const { _electron } = require('playwright');
const root = path.resolve(__dirname, '..');
const outDir = path.join(root, 'docs/ecosystem-20260922');
fs.mkdirSync(outDir, { recursive: true });
const work = fs.mkdtempSync(path.join(os.tmpdir(), 'sct-eco-jev-'));
const exe = process.env.SCT_TEST_EXE || path.join(root, 'release/win-unpacked/SelfConnect Terminal.exe');
const env = { ...process.env, SELFCONNECT_USER_DATA_DIR: path.join(work, 'profile'), SELFCONNECT_A2A_MODE: 'off' };
for (const k of ['ELECTRON_RUN_AS_NODE', 'VITE_DEV_SERVER_URL', 'SELFCONNECT_LOCAL_ONLY']) delete env[k];
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
    const waitFor = async (marker, ms = 120000) => {
      await page.waitForFunction((m) => window.__out.split(m).length >= 3, marker, { timeout: ms });
      return strip(await page.evaluate(() => window.__out));
    };
    const state = () => page.evaluate(() => window.selfconnect.getState());
    const jev = async () => {
      const snap = await page.evaluate(() => window.selfconnect.jevPreview());
      const result = await page.evaluate((id) => window.selfconnect.jevAnalyze(id), snap.id);
      return { snap: { characters: snap.text.length, redactions: snap.redactions, configured: snap.configured }, result };
    };

    // 0. Baseline dock state in a fresh profile.
    const s0 = await state();
    check('fresh profile: ledger OK, zero app spend, app context 0, local-only on by default', s0.ledger.ok && s0.cost.sessionSpendUsd === 0 && s0.context.usedTokens === 0 && s0.localOnly === true ? 'Worked' : 'Failed', { ledger: s0.ledger, spend: s0.cost.sessionSpendUsd, used: s0.context.usedTokens, localOnly: s0.localOnly });
    const ollama = s0.liveness.find((l) => l.kind === 'ollama');
    check('router liveness is a real probe (ollama reported offline while not running)', ollama && ollama.alive === false ? 'Worked' : 'Blocked', ollama);
    const snap0 = await page.evaluate(() => window.selfconnect.jevPreview());
    check('Jev key configured in this profile (DPAPI file outside userData)', snap0.configured ? 'Worked' : 'Blocked', { configured: snap0.configured });
    if (!snap0.configured) throw new Error('Jev not configured; wiring check blocked');

    // 1. Real successful work in the PTY: a real vitest file from this repo.
    await type(`cd /d "${root}" & npx vitest run tests/schema.test.ts 2>&1 & echo RUN_OK_DONE`);
    const out1 = await waitFor('RUN_OK_DONE');
    check('real test run completed inside installed PTY', /Tests\s+\d+ passed/.test(out1) ? 'Worked' : 'Failed', { excerpt: out1.split('\n').filter((l) => /Test Files|Tests /.test(l)).slice(-2) });
    await page.evaluate(() => window.selfconnect.setLocalOnly(false));
    const j1 = await jev();
    check('Jev live reads the real success output as success', j1.result.status === 'success' ? 'Worked' : 'Failed', j1);

    // 2. Real failure in the PTY.
    await type('type definitely-missing-file.txt 2>&1 & echo RUN_ERR_DONE');
    const out2 = await waitFor('RUN_ERR_DONE');
    check('real shell error produced inside installed PTY', /cannot find the file/i.test(out2) ? 'Worked' : 'Failed', {});
    const j2 = await jev();
    check('Jev live reads the real error output as error + check_path', j2.result.status === 'error' && j2.result.action === 'check_path' ? 'Worked' : 'Failed', j2);

    // 3. Local-only really cuts Jev off again.
    await page.evaluate(() => window.selfconnect.setLocalOnly(true));
    const snap3 = await page.evaluate(() => window.selfconnect.jevPreview());
    let blocked = '';
    try { await page.evaluate((id) => window.selfconnect.jevAnalyze(id), snap3.id); } catch (e) { blocked = e.message; }
    check('local-only blocks a third Jev send', /local-only/i.test(blocked) ? 'Worked' : 'Failed', { blocked });

    // 4. Dock wiring after the actions above.
    const s1 = await state();
    const types = (await page.evaluate(() => window.selfconnect.replayEvents())).map((e) => e.type);
    const jevEvents = types.filter((t) => t.startsWith('jev.'));
    check('ledger recorded both Jev round-trips', jevEvents.filter((t) => t === 'jev.result').length === 2 && jevEvents.filter((t) => t === 'jev.requested').length === 2 ? 'Worked' : 'Failed', { jevEvents });
    check('Cost Kernel still 0: Jev is excluded by design and no app model call was made', s1.cost.sessionSpendUsd === 0 ? 'Worked' : 'Failed', { spend: s1.cost.sessionSpendUsd });
    check('App context still 0: PTY work does not flow through the app agent loop (by design, now labelled)', s1.context.usedTokens === 0 ? 'Worked' : 'Failed', { used: s1.context.usedTokens });
    // Typed lines are NOT logged verbatim (they may hold secrets); they are risk-inspected on Enter.
    check('typed PTY lines are not copied into the ledger (privacy by design)', !types.includes('terminal.input') ? 'Worked' : 'Failed', { count: types.filter((t) => t === 'terminal.input').length });
    const sentinelBefore = s1.sentinel;
    await type('echo sudo ls & echo RISK_DONE'); // harmless echo; matches the sudo rule
    await waitFor('RISK_DONE');
    const s2 = await state();
    const types2 = (await page.evaluate(() => window.selfconnect.replayEvents())).map((e) => e.type);
    check('Security Sentinel is wired to typed PTY lines (risk.detected recorded for a flagged line)', types2.includes('risk.detected') ? 'Worked' : 'Failed', { before: sentinelBefore, after: s2.sentinel });
    check('ledger chain still verifies after all of the above', (await page.evaluate(() => window.selfconnect.verifyLedger())).ok ? 'Worked' : 'Failed', {});
    check('session listed with real event count (not scrollback length)', s1.sessions.length >= 1 && s1.sessions[0].eventCount === s1.ledger.entries ? 'Worked' : 'Failed', { sessions: s1.sessions, entries: s1.ledger.entries });
    await page.screenshot({ path: path.join(outDir, 'partner-jev-wiring.png') });
  } catch (e) {
    results.errors.push(e.stack || String(e));
    process.exitCode = 1;
  } finally {
    if (app) await app.close().catch((e) => results.errors.push(e.message));
    fs.writeFileSync(path.join(outDir, 'partner-jev-wiring-results.json'), JSON.stringify(results, null, 2));
    console.log(JSON.stringify(results, null, 2));
  }
})();

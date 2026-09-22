/**
 * Computer-use partner acceptance (Claude lane) — desktop_assist against OWNED Tk fixtures.
 *
 * Target: the installed SelfConnect Terminal (SCT_TEST_EXE) or release/win-unpacked.
 * Isolated profile. subscription_only. ZERO paid calls: SELFCONNECT_COMPUTER_PAID_API=0 and the
 * paid_api path is exercised only to prove it is REFUSED. Every start/act goes through the
 * registry (high risk) and is approved or denied over IPC the way a human would.
 *
 * Windows touched (all ours, from scripts/computer-use-fixture.py, each with its own readback file):
 *  - TARGET fixture: the only authorized window for the typing session.
 *  - SINK fixture: brought to the foreground during a governed action to prove (a) the action is
 *    REFUSED (WINDOW_LOST contract: only the SCT approval may restore focus) and (b) nothing was
 *    typed anywhere.
 *  - LOSS fixture: closed mid-session to prove the next action refuses.
 * No Notepad, no owner documents. Window identity comes from the app's own Core enumeration
 * (computerUse windows) diffed before/after each launch; pid is never used for identity.
 *
 * Usage: SCT_TEST_EXE="<exe>" node scripts/computer-use-partner-acceptance.cjs
 */
const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
const { spawn, execFileSync } = require('node:child_process');
const { _electron } = require('playwright');

const root = path.resolve(__dirname, '..');
const outDir = path.join(root, 'docs/ecosystem-20260922');
fs.mkdirSync(outDir, { recursive: true });
const work = fs.mkdtempSync(path.join(os.tmpdir(), 'sct-cu-'));
const exe = process.env.SCT_TEST_EXE || path.join(root, 'release/win-unpacked/SelfConnect Terminal.exe');
const fixture = path.join(root, 'scripts/computer-use-fixture.py');
const env = { ...process.env, SELFCONNECT_USER_DATA_DIR: path.join(work, 'profile'), SELFCONNECT_A2A_MODE: 'off', SELFCONNECT_LOCAL_ONLY: '1', SELFCONNECT_COMPUTER_PAID_API: '0' };
for (const k of ['ELECTRON_RUN_AS_NODE', 'VITE_DEV_SERVER_URL', 'ANTHROPIC_API_KEY']) delete env[k];
/** SCT_FOCUS_ONLY=1 runs just: fixtures -> SCT foreground -> start -> observe -> focus (the failing step) and records the full driver reason. */
const FOCUS_ONLY = process.env.SCT_FOCUS_ONLY === '1';
const results = { at: new Date().toISOString(), exe, work, mode: FOCUS_ONLY ? 'focus-only' : 'full', checks: [], errors: [], cleanup: [] };
const check = (name, outcome, detail) => { results.checks.push({ name, outcome, detail }); if (outcome === 'Failed') throw new Error(name); };
const SENTENCE_1 = 'selfconnect computer use acceptance line one';
const SENTENCE_2 = 'line two typed under desktop assist';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ps = (script) => execFileSync('powershell.exe', ['-NoProfile', '-Command', script], { encoding: 'utf8', windowsHide: true }).trim();
const readFixture = (file) => { try { return JSON.parse(fs.readFileSync(file, 'utf8')).text; } catch { return ''; } };
function foreground(hwnd) {
  return ps(`
Add-Type -Name F -Namespace N -MemberDefinition '[DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h); [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow(); [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h,int n);'
Add-Type -AssemblyName System.Windows.Forms
$h=[IntPtr]${hwnd}
for($i=0;$i -lt 4;$i++){
  [N.F]::ShowWindow($h,9) | Out-Null; [N.F]::SetForegroundWindow($h) | Out-Null; Start-Sleep -Milliseconds 400
  if([N.F]::GetForegroundWindow() -eq $h){ break }
  # Foreground lock: a tap of Alt lets the next SetForegroundWindow succeed.
  [System.Windows.Forms.SendKeys]::SendWait('%'); [N.F]::SetForegroundWindow($h) | Out-Null; Start-Sleep -Milliseconds 400
  if([N.F]::GetForegroundWindow() -eq $h){ break }
  [N.F]::ShowWindow($h,6) | Out-Null; Start-Sleep -Milliseconds 200; [N.F]::ShowWindow($h,9) | Out-Null; Start-Sleep -Milliseconds 400
}
Write-Output ([N.F]::GetForegroundWindow())`);
}
const owned = [];
function endOwned() {
  for (const p of owned) { try { process.kill(p.pid); } catch { /* already gone */ } }
  owned.length = 0;
}
process.on('exit', endOwned);

let app;
(async () => {
  try {
    check('target exe present', fs.existsSync(exe) ? 'Worked' : 'Failed', { exe });
    check('fixture script present', fs.existsSync(fixture) ? 'Worked' : 'Failed', { fixture });

    // --- App first, so window discovery uses the app's own Core enumeration --------
    app = await _electron.launch({ executablePath: exe, args: ['--disable-gpu'], cwd: work, env, timeout: 25000 });
    const page = await app.firstWindow();
    page.on('pageerror', (e) => results.errors.push(e.message));
    await page.waitForFunction(() => !!window.selfconnect && typeof window.selfconnect.computerUse === 'function');
    // A schema rejection at the IPC boundary surfaces as a thrown error; that is a refusal too, so
    // normalise it to { ok: false, error } instead of crashing the harness.
    const cu = (command) => page.evaluate((c) => window.selfconnect.computerUse(c), command).catch((e) => ({ ok: false, output: '', error: String(e && e.message ? e.message : e).slice(0, 400), refusedAtBoundary: true }));
    const state = () => page.evaluate(() => window.selfconnect.getState());
    const parse = (r) => { try { return JSON.parse(r.output); } catch { return null; } };
    // Core enumeration uses exe_name/class_name; the session schema wants exe/className. Map once here.
    const toTarget = (w) => ({ hwnd: Number(w.hwnd), pid: Number(w.pid), exe: w.exe ?? w.exe_name, className: w.className ?? w.class_name, title: w.title });
    const windows = async () => { const w = await cu({ operation: 'windows' }); return (Array.isArray(w) ? w : parse(w) || []).map(toTarget); };
    const decideAll = async (approve) => {
      for (let i = 0; i < 100; i++) {
        const s = await state();
        const open = s.approvals.filter((a) => a.status === 'pending');
        if (open.length) { for (const a of open) await page.evaluate(([id, ok]) => window.selfconnect.decideApproval(id, ok), [a.id, approve]); return open.length; }
        await sleep(50);
      }
      return 0;
    };
    const governed = async (command, approve = true) => { const p = cu(command); const approvals = await decideAll(approve); const r = await p; return { r, approvals }; };

    /** Launch an owned fixture and return its Core identity (hwnd diff, never pid). */
    const launchFixture = async (name) => {
      const before = new Set((await windows()).map((w) => Number(w.hwnd)));
      const file = path.join(work, `${name}.json`);
      const proc = spawn('python', [fixture, file], { detached: true, stdio: 'ignore', windowsHide: false });
      proc.unref();
      owned.push(proc);
      let win = null;
      for (let i = 0; i < 60 && !win; i++) {
        await sleep(250);
        win = (await windows()).find((w) => !before.has(Number(w.hwnd)) && /SCT Desktop Acceptance Fixture/.test(w.title || ''));
      }
      return { win, file, proc };
    };

    const T = await launchFixture('target');
    check('TARGET fixture appears in Core enumeration with full identity', T.win && T.win.hwnd > 0 && T.win.pid > 0 && T.win.exe && T.win.className && T.win.title ? 'Worked' : 'Failed', T.win);
    const S = await launchFixture('sink');
    check('SINK fixture appears in Core enumeration (distinct hwnd)', S.win && S.win.hwnd !== T.win.hwnd ? 'Worked' : 'Failed', S.win);
    const target = T.win;

    if (FOCUS_ONLY) {
      const sctPid0 = app.process().pid;
      const sctWin0 = (await windows()).find((w) => /SelfConnect Terminal/i.test(w.exe || '') && (w.pid === sctPid0 || /SelfConnect Terminal/.test(w.title || '')));
      check('SCT approval window found', sctWin0 ? 'Worked' : 'Failed', { sctWin0 });
      const fg0 = foreground(sctWin0.hwnd);
      check('SCT approval window is OS foreground', Number(fg0) === sctWin0.hwnd ? 'Worked' : 'Failed', { fg0 });
      const startedF = await governed({ operation: 'start', request: { target, objective: 'focus-only diagnostic', executionMode: 'desktop_assist', billingMode: 'subscription_only', maxActions: 4 } });
      const sessF = startedF.r && startedF.r.ok ? parse(startedF.r) : null;
      check('focus-only: session starts', sessF && sessF.id ? 'Worked' : 'Failed', startedF.r);
      const obF = await governed({ operation: 'act', action: { sessionId: sessF.id, sequence: sessF.sequence || 1, ...(sessF.observation ? { observationId: sessF.observation.id } : {}), type: 'observe' } });
      const obFS = obF.r && obF.r.ok ? parse(obF.r) : null;
      check('focus-only: first observe', obFS ? 'Worked' : 'Failed', obF.r);
      const fgBefore = ps(`Add-Type -Name G -Namespace N -MemberDefinition '[DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();'; Write-Output ([N.G]::GetForegroundWindow())`);
      const focusF = await governed({ operation: 'act', action: { sessionId: sessF.id, sequence: obFS.sequence, observationId: obFS.observation.id, type: 'focus' } });
      check('focus-only: focus on the authorized fixture (full driver reason recorded)', focusF.r && focusF.r.ok ? 'Worked' : 'Failed', { foregroundBeforeAct: fgBefore, sctHwnd: sctWin0.hwnd, targetHwnd: target.hwnd, result: focusF.r });
      await cu({ operation: 'stop', sessionId: sessF.id }).catch(() => undefined);
      return;
    }

    // 1. Plan mode refuses to start.
    await page.evaluate(() => window.selfconnect.setPermissionMode('plan'));
    const planStart = await cu({ operation: 'start', request: { target, objective: 'plan mode probe', executionMode: 'desktop_assist', billingMode: 'subscription_only' } });
    check('plan mode refuses computer_use start', planStart && planStart.ok === false ? 'Worked' : 'Failed', planStart);
    await page.evaluate(() => window.selfconnect.setPermissionMode('auto'));

    // 2. paid_api is refused even with a full consent record.
    const paidStart = await governed({ operation: 'start', request: { target, objective: 'paid probe', executionMode: 'desktop_assist', billingMode: 'paid_api', paidConsent: { provider: 'anthropic', model: 'claude-sonnet-5', sessionCapUsd: 2, taskCapUsd: 0.5, projectCapUsd: 25, priceInputPerMillion: 2, priceOutputPerMillion: 10, acknowledgeSeparateBilling: true } } });
    check('paid_api session refused (no paid call possible)', paidStart.r && paidStart.r.ok === false ? 'Worked' : 'Failed', paidStart.r);

    // 3. Denied start: nothing starts.
    const denied = await governed({ operation: 'start', request: { target, objective: 'denied probe', executionMode: 'desktop_assist', billingMode: 'subscription_only' } }, false);
    check('a DENIED start approval starts nothing', denied.r && denied.r.ok === false && denied.approvals >= 1 ? 'Worked' : 'Failed', denied.r);

    // Session helpers.
    const openSession = async (objective, maxActions) => {
      const started = await governed({ operation: 'start', request: { target, objective, executionMode: 'desktop_assist', billingMode: 'subscription_only', maxActions, maxMinutes: 5 } });
      const session = started.r && started.r.ok ? parse(started.r) : null;
      return { started, session, seq: session ? session.sequence || 1 : 1, obsId: session && session.observation ? session.observation.id : null };
    };
    const actIn = (ctx) => async (action, approve = true) => {
      const bound = { sessionId: ctx.session.id, sequence: ctx.seq, ...(ctx.obsId ? { observationId: ctx.obsId } : {}), ...action };
      const { r, approvals } = await governed({ operation: 'act', action: bound }, approve);
      const s = r && r.ok ? parse(r) : null;
      if (s) { ctx.seq = s.sequence || ctx.seq + 1; ctx.obsId = s.observation ? s.observation.id : ctx.obsId; }
      return { r, s, approvals, bound };
    };

    // 4. Session A: observe, refusals, then the wrong-foreground contract (must REFUSE, WINDOW_LOST).
    const A = await openSession('Session A: refusals and foreign-foreground contract', 10);
    check('subscription_only session starts only after approval', A.session && A.session.id && A.started.approvals >= 1 ? 'Worked' : 'Failed', { result: A.started.r, approvals: A.started.approvals });
    const actA = actIn(A);
    const o1 = await actA({ type: 'observe' });
    check('first observe captures an artifact with sha256 and dimensions', o1.s && o1.s.observation && o1.s.observation.sha256 && o1.s.observation.width > 0 ? 'Worked' : 'Failed', o1.r);
    check('each action needs its own approval (desktop_assist)', o1.approvals >= 1 ? 'Worked' : 'Failed', { approvals: o1.approvals });

    const stale = await governed({ operation: 'act', action: { sessionId: A.session.id, sequence: A.seq, observationId: 'obs-does-not-exist', type: 'type', text: 'MUST NOT APPEAR' } });
    check('action bound to a stale observation is refused', stale.r && stale.r.ok === false ? 'Worked' : 'Failed', stale.r);
    const wrongSeq = await governed({ operation: 'act', action: { sessionId: A.session.id, sequence: A.seq + 5, observationId: A.obsId, type: 'type', text: 'MUST NOT APPEAR' } });
    check('out-of-order sequence is refused', wrongSeq.r && wrongSeq.r.ok === false ? 'Worked' : 'Failed', wrongSeq.r);
    const badKey = await governed({ operation: 'act', action: { sessionId: A.session.id, sequence: A.seq, observationId: A.obsId, type: 'keypress', keys: ['ctrl+s'] } });
    check('non-allowlisted key (ctrl+s) is refused by schema', badKey.r && badKey.r.ok === false ? 'Worked' : 'Failed', badKey.r);
    const deniedType = await actA({ type: 'type', text: 'MUST NOT APPEAR DENIED' }, false);
    check('a DENIED type action executes nothing', deniedType.r && deniedType.r.ok === false && deniedType.approvals >= 1 ? 'Worked' : 'Failed', deniedType.r);

    const fg = foreground(S.win.hwnd);
    const foreign = await actA({ type: 'type', text: 'MUST NOT APPEAR FOREIGN' });
    check('foreign foreground: governed action is REFUSED (WINDOW_LOST contract)', foreign.r && foreign.r.ok === false ? 'Worked' : 'Failed', { foregroundBefore: fg, sinkHwnd: S.win.hwnd, result: foreign.r });
    await sleep(600);
    check('foreign foreground: no collateral input in the sink, none in the target', !readFixture(S.file).includes('MUST NOT') && !readFixture(T.file).includes('MUST NOT') ? 'Worked' : 'Failed', { sink: readFixture(S.file), target: readFixture(T.file) });
    const afterLost = await actA({ type: 'observe' });
    check('WINDOW_LOST is terminal for that session', afterLost.r && afterLost.r.ok === false ? 'Worked' : 'Failed', afterLost.r);
    await cu({ operation: 'stop', sessionId: A.session.id }).catch(() => undefined);

    // 5. Session B: real two-line typing on the target. Contract: only the SCT approval window may
    // restore target focus, so the SCT window itself is foreground when the human approves.
    const sctPid = app.process().pid;
    const sctWin = (await windows()).find((w) => /SelfConnect Terminal/i.test(w.exe || '') && (w.pid === sctPid || /SelfConnect Terminal/.test(w.title || '')));
    check('SCT approval window found in Core enumeration', sctWin ? 'Worked' : 'Failed', { sctPid, sctWin });
    const fgSct = foreground(sctWin.hwnd);
    check('SCT approval window brought to foreground before approving focus', Number(fgSct) === sctWin.hwnd ? 'Worked' : 'Failed', { fgSct, sctHwnd: sctWin.hwnd });
    const B = await openSession(`Session B: type "${SENTENCE_1}", Enter, "${SENTENCE_2}"`, 12);
    check('a new session starts after WINDOW_LOST', B.session && B.session.id ? 'Worked' : 'Failed', B.started.r);
    const actB = actIn(B);
    const ob = await actB({ type: 'observe' });
    check('session B first observe', ob.s && ob.s.observation ? 'Worked' : 'Failed', ob.r);
    const f = await actB({ type: 'focus' });
    check('focus executes on the authorized window', f.s ? 'Worked' : 'Failed', f.r);
    const t1 = await actB({ type: 'type', text: SENTENCE_1 });
    check('type line one executes', t1.s ? 'Worked' : 'Failed', t1.r);
    const k = await actB({ type: 'keypress', keys: ['enter'] });
    check('enter executes', k.s ? 'Worked' : 'Failed', k.r);
    const t2 = await actB({ type: 'type', text: SENTENCE_2 });
    check('type line two executes', t2.s ? 'Worked' : 'Failed', t2.r);
    const ob2 = await actB({ type: 'observe' });
    check('post-action observation differs from the first (state changed)', ob2.s && ob2.s.observation && ob2.s.observation.sha256 !== ob.s.observation.sha256 ? 'Worked' : 'Failed', { before: ob.s.observation.sha256, after: ob2.s && ob2.s.observation && ob2.s.observation.sha256 });
    await sleep(400);
    const text = readFixture(T.file);
    check('TARGET really contains both lines (fixture file readback, independent of the app)', text.includes(SENTENCE_1) && text.includes(SENTENCE_2) ? 'Worked' : 'Failed', { text: text.slice(0, 200) });
    // Exact-text claim: Enter must produce exactly one LF, no CR, nothing else.
    results.checks.push({ name: 'exact text: two lines joined by a single LF, no CR', outcome: text === `${SENTENCE_1}\n${SENTENCE_2}` ? 'Worked' : 'Failed', detail: { text: JSON.stringify(text.slice(0, 200)) } });
    check('no refused, denied, or foreign action ever reached any window', !text.includes('MUST NOT') && !readFixture(S.file).includes('MUST NOT') ? 'Worked' : 'Failed', {});

    // 6. Click + scroll on the target: click at a point in the text area, then scroll; state must change.
    const before = ob2.s.observation;
    const clickPt = { x: Math.min(before.width - 1, 300), y: Math.min(before.height - 1, 200) };
    const c1 = await actB({ type: 'click', point: clickPt });
    // Narrow claim: the driver executed the click (ok:true). A caret move in a text area may not
    // change pixels; report the driver's own lastChanged instead of asserting a state change.
    check('click at a point inside the authorized window: driver executed it (ok:true)', c1.s ? 'Worked' : 'Failed', { lastChanged: c1.s && c1.s.lastChanged, noChangeCount: c1.s && c1.s.noChangeCount });
    const bigType = await actB({ type: 'type', text: Array.from({ length: 40 }, (_, i) => `scroll line ${i}`).join('\n') });
    check('typing 40 lines: driver executed it (ok:true)', bigType.s ? 'Worked' : 'Failed', { lastChanged: bigType.s && bigType.s.lastChanged });
    await sleep(500);
    const afterBig = readFixture(T.file);
    const lineCount = afterBig.split('\n').length;
    // Semantic claim: newlines must survive multiline type. Expected 2 original lines + 40 typed lines (the
    // typed block starts on the current line after the caret click, so accept 41 or 42).
    results.checks.push({ name: 'multiline type preserved newlines (fixture line count)', outcome: !afterBig.includes('\r') && lineCount >= 41 && lineCount <= 42 ? 'Worked' : 'Failed', detail: { lineCount, hasCR: afterBig.includes('\r'), tail: JSON.stringify(afterBig.slice(-120)) } });
    const beforeScroll = await actB({ type: 'observe' });
    const sc = await actB({ type: 'scroll', delta: -5, point: clickPt });
    check('scroll with a point: driver executed it (ok:true)', sc.s ? 'Worked' : 'Failed', { lastChanged: sc.s && sc.s.lastChanged });
    const afterScroll = await actB({ type: 'observe' });
    // Two separate observes can differ from caret blink alone, so a hash difference between them is
    // NOT evidence of scrolling. Only the driver's own before/after on the scroll step, or a yview
    // readback from the fixture, counts. Until the fixture exposes yview this is Blocked, not Worked.
    const yview = (() => { try { return JSON.parse(fs.readFileSync(T.file, 'utf8')).yview; } catch { return undefined; } })();
    const scrollProven = (sc.s && sc.s.lastChanged === true) || (Array.isArray(yview) && yview[0] > 0);
    results.checks.push({ name: 'scroll actually moved the view (driver lastChanged or fixture yview)', outcome: scrollProven ? 'Worked' : 'Blocked', detail: { driverLastChanged: sc.s && sc.s.lastChanged, yview, observeHashesDiffer: !!(beforeScroll.s && afterScroll.s && beforeScroll.s.observation.sha256 !== afterScroll.s.observation.sha256), note: 'observe-to-observe hash difference is not evidence (caret blink)' } });

    // 7. Stop; further act refused; nothing more typed.
    const stopped = await cu({ operation: 'stop', sessionId: B.session.id });
    const after = await governed({ operation: 'act', action: { sessionId: B.session.id, sequence: B.seq, observationId: B.obsId, type: 'type', text: 'MUST NOT APPEAR EITHER' } });
    check('stopped session refuses further actions', after.r && after.r.ok === false ? 'Worked' : 'Failed', { stopped, after: after.r });
    await sleep(400);
    check('nothing reached the target after stop', !readFixture(T.file).includes('MUST NOT') ? 'Worked' : 'Failed', {});

    // 8. Ledger and evidence.
    const types = (await page.evaluate(() => window.selfconnect.replayEvents())).map((e) => e.type);
    const cuEvents = types.filter((t) => /computer/i.test(t));
    check('ledger holds computer-use events and still verifies', cuEvents.length >= 4 && (await page.evaluate(() => window.selfconnect.verifyLedger())).ok ? 'Worked' : 'Failed', { cuEvents: [...new Set(cuEvents)] });
    const s1 = await state();
    check('app paid spend stays $0', s1.cost.sessionSpendUsd === 0 ? 'Worked' : 'Failed', { spend: s1.cost.sessionSpendUsd });

    // 9. Window loss on a third owned fixture.
    const L = await launchFixture('loss');
    if (L.win) {
      const started = await governed({ operation: 'start', request: { target: L.win, objective: 'window loss probe', executionMode: 'desktop_assist', billingMode: 'subscription_only', maxActions: 3 } });
      const sess = started.r && started.r.ok ? parse(started.r) : null;
      if (sess) {
        const ob3 = await governed({ operation: 'act', action: { sessionId: sess.id, sequence: sess.sequence || 1, ...(sess.observation ? { observationId: sess.observation.id } : {}), type: 'observe' } });
        const obS = ob3.r && ob3.r.ok ? parse(ob3.r) : null;
        try { process.kill(L.proc.pid); } catch { /* gone */ }
        await sleep(1500);
        const lost = await governed({ operation: 'act', action: { sessionId: sess.id, sequence: obS ? obS.sequence : 2, observationId: obS && obS.observation ? obS.observation.id : 'x', type: 'focus' } });
        check('closing the target window makes the next action refuse (WINDOW_LOST)', lost.r && lost.r.ok === false ? 'Worked' : 'Failed', lost.r);
      } else results.checks.push({ name: 'window loss probe', outcome: 'Blocked', detail: started.r });
    } else results.checks.push({ name: 'window loss probe', outcome: 'Blocked', detail: {} });
    await page.screenshot({ path: path.join(outDir, 'computer-use-partner-acceptance.png') });
  } catch (e) {
    results.errors.push(e.stack || String(e));
    process.exitCode = 1;
  } finally {
    endOwned();
    results.cleanup.push('all owned fixture processes ended; no foreign window touched');
    if (app) await app.close().catch((e) => results.errors.push(e.message));
    fs.writeFileSync(path.join(outDir, 'computer-use-partner-acceptance.json'), JSON.stringify(results, null, 2));
    console.log(JSON.stringify(results, null, 2));
  }
})();

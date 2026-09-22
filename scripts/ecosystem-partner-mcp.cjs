/**
 * Ecosystem partner lane — MCP acceptance against the INSTALLED SelfConnect Terminal.
 * Isolated profile; real stdio MCP server subprocesses (no mocks); calls go through
 * the app's own /mcp slash route (window.selfconnect.slashRun -> daemon.mcpCall).
 * Focus-independent: everything is driven over the preload IPC via Playwright.
 *
 * Servers under test:
 *   selfconnect  — the app's own read-only MCP server (`node dist/cli/index.js mcp serve`)
 *   probe        — a 40-line real JSON-RPC stdio server written to the work dir, with one
 *                  read-only tool (echo_path) and one mutating tool (write_marker) so a
 *                  denied/side-effect check is meaningful.
 *
 * Usage: SCT_TEST_EXE="<installed exe>" node scripts/ecosystem-partner-mcp.cjs
 */
const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
const { _electron } = require('playwright');

const root = path.resolve(__dirname, '..');
const outDir = path.join(root, 'docs/ecosystem-20260922');
fs.mkdirSync(outDir, { recursive: true });
const work = fs.mkdtempSync(path.join(os.tmpdir(), 'sct-eco-mcp-'));
const exe = process.env.SCT_TEST_EXE || path.join(root, 'release/win-unpacked/SelfConnect Terminal.exe');

// --- real probe MCP server (stdio JSON-RPC, newline-delimited) -----------------
const probeServer = `
const fs=require('fs');let buf='';
const tools=[
 {name:'echo_path',description:'Return the given path and whether it exists (read-only).',inputSchema:{type:'object',properties:{path:{type:'string'}},required:['path']}},
 {name:'write_marker',description:'Write a marker file (mutating).',inputSchema:{type:'object',properties:{path:{type:'string'}},required:['path']}},
];
function send(o){process.stdout.write(JSON.stringify(o)+'\\n');}
process.stdin.setEncoding('utf8');
process.stdin.on('data',d=>{buf+=d;let i;while((i=buf.indexOf('\\n'))>=0){const line=buf.slice(0,i).trim();buf=buf.slice(i+1);if(!line)continue;let m;try{m=JSON.parse(line);}catch{continue;}
 if(m.method==='initialize')send({jsonrpc:'2.0',id:m.id,result:{protocolVersion:'2024-11-05',serverInfo:{name:'probe',version:'0.0.1'},capabilities:{tools:{}}}});
 else if(m.method==='notifications/initialized'){}
 else if(m.method==='tools/list')send({jsonrpc:'2.0',id:m.id,result:{tools}});
 else if(m.method==='tools/call'){const a=(m.params&&m.params.arguments)||{};
   if(m.params.name==='echo_path')send({jsonrpc:'2.0',id:m.id,result:{content:[{type:'text',text:JSON.stringify({path:a.path,exists:fs.existsSync(String(a.path)),pid:process.pid})}]}});
   else if(m.params.name==='write_marker'){fs.writeFileSync(String(a.path),'marker');send({jsonrpc:'2.0',id:m.id,result:{content:[{type:'text',text:'wrote '+a.path}]}});}
   else send({jsonrpc:'2.0',id:m.id,error:{code:-32601,message:'unknown tool '+m.params.name}});}
 else if(m.id!==undefined)send({jsonrpc:'2.0',id:m.id,error:{code:-32601,message:'unknown method '+m.method}});}});
`;
fs.writeFileSync(path.join(work, 'probe-server.cjs'), probeServer);

const SC_SDK_DIR = 'D:\projects\SelfConnect\selfconnect-sdk';
const mcpConfig = {
  servers: {
    selfconnect: { command: process.execPath, args: [path.join(root, 'dist/cli/index.js'), 'mcp', 'serve'], env: { SELFCONNECT_LEDGER_PATH: path.join(work, 'server-ledger.jsonl'), SELFCONNECT_SESSIONS_DIR: path.join(work, 'server-sessions'), SELFCONNECT_KEYS_DIR: path.join(work, 'server-keys'), SELFCONNECT_A2A_MODE: 'off' } },
    probe: { command: process.execPath, args: [path.join(work, 'probe-server.cjs')] },
    // Real, separately-maintained Python SelfConnect SDK's own MCP server (sc_mcp.py, FastMCP/stdio),
    // NOT part of this repo. Interoperability check: the TS app's MCP client speaks to a real
    // external Python server it does not own or control.
    sc_mcp_python: { command: 'python', args: ['-m', 'sc_mcp'], env: { PYTHONPATH: SC_SDK_DIR } },
  },
};
const mcpConfigPath = path.join(work, 'mcp-servers.json');
fs.writeFileSync(mcpConfigPath, JSON.stringify(mcpConfig, null, 2));

const env = { ...process.env, SELFCONNECT_USER_DATA_DIR: path.join(work, 'profile'), SELFCONNECT_A2A_MODE: 'off', SELFCONNECT_MCP_CONFIG: mcpConfigPath, SELFCONNECT_LOCAL_ONLY: '1' };
for (const k of ['ELECTRON_RUN_AS_NODE', 'VITE_DEV_SERVER_URL']) delete env[k];

const results = { at: new Date().toISOString(), exe, work, mcpConfigPath, checks: [], errors: [] };
const check = (name, outcome, detail) => { results.checks.push({ name, outcome, detail }); if (outcome === 'Failed') throw new Error(name); };
let app;
(async () => {
  try {
    check('installed exe present', fs.existsSync(exe) ? 'Worked' : 'Failed', { exe });
    check('cli mcp server build present', fs.existsSync(path.join(root, 'dist/cli/index.js')) ? 'Worked' : 'Failed', {});
    app = await _electron.launch({ executablePath: exe, args: ['--disable-gpu'], cwd: work, env, timeout: 25000 });
    const page = await app.firstWindow();
    page.on('pageerror', (e) => results.errors.push(e.message));
    await page.waitForFunction(() => !!window.selfconnect);
    const slash = (line) => page.evaluate((l) => window.selfconnect.slashRun(l), line);
    const events = async () => (await page.evaluate(() => window.selfconnect.replayEvents())).map((e) => e.type);

    // 1. discovery of configured servers (proves the installed app read our config)
    const list = await slash('/mcp list');
    check('installed app lists configured MCP servers', list.ok && list.output.includes('selfconnect') && list.output.includes('probe') ? 'Worked' : 'Failed', list);

    // 2. real subprocess discovery: tools/list over stdio for both servers
    const tSc = await slash('/mcp tools selfconnect');
    check('real stdio MCP discovery: selfconnect server tools', tSc.ok && tSc.output.includes('ledger_verify') && tSc.output.includes('cost_report') ? 'Worked' : 'Failed', tSc);
    const tPr = await slash('/mcp tools probe');
    check('real stdio MCP discovery: probe server tools', tPr.ok && tPr.output.includes('echo_path') && tPr.output.includes('write_marker') ? 'Worked' : 'Failed', tPr);

    // Real external interoperability: a separate Python SDK's own MCP server, unrelated codebase.
    const tPy = await slash('/mcp tools sc_mcp_python');
    check('real interop: external Python SelfConnect SDK MCP server (sc_mcp.py) tools/list', tPy.ok && tPy.output.includes('doctor') && tPy.output.includes('list_windows') ? 'Worked' : 'Failed', tPy);
    const pyCall = await slash('/mcp call sc_mcp_python doctor {}');
    let pyParsed = null; try { pyParsed = JSON.parse(pyCall.output); } catch { /* keep null */ }
    check('real interop: TS app calls the Python MCP server read-only doctor tool', pyCall.ok && pyParsed && typeof pyParsed.version === 'string' ? 'Worked' : 'Failed', { pyCall, pyParsed });

    // 3. real read-only tool call through the app route, result from the child process
    const marker = path.join(work, 'exists.txt'); fs.writeFileSync(marker, 'x');
    const call = await slash(`/mcp call probe echo_path ${JSON.stringify({ path: marker })}`);
    let parsed = null; try { parsed = JSON.parse(call.output); } catch { /* keep null */ }
    check('real MCP tool call returns child-process result', call.ok && parsed && parsed.exists === true && Number.isInteger(parsed.pid) && parsed.pid !== process.pid ? 'Worked' : 'Failed', { call, parsed });
    const scCall = await slash('/mcp call selfconnect ledger_verify {}');
    check('app calls its own read-only MCP server (ledger_verify)', scCall.ok && /ok|entries|true/i.test(scCall.output) ? 'Worked' : 'Failed', scCall);

    // 4. ledger records the MCP round-trip
    const ev = await events();
    check('ledger records mcp.call and mcp.result', ev.includes('mcp.call') && ev.includes('mcp.result') ? 'Worked' : 'Failed', { count: ev.filter((t) => t.startsWith('mcp.')).length });

    // 5. denied / hostile
    const unknownServer = await slash('/mcp call nosuch echo_path {}');
    check('unknown MCP server refused', !unknownServer.ok && /unknown MCP server/.test(unknownServer.output) ? 'Worked' : 'Failed', unknownServer);
    const unknownTool = await slash('/mcp call probe nosuch_tool {}');
    check('unknown MCP tool refused by server and surfaced as error', !unknownTool.ok ? 'Worked' : 'Failed', unknownTool);
    const badJson = await slash('/mcp call probe echo_path {not json');
    check('malformed MCP args rejected before spawn/call', !badJson.ok && /valid JSON/.test(badJson.output) ? 'Worked' : 'Failed', badJson);
    const secretPath = path.join(work, 'sk-ant-api03-ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789abcdefghijklmnopqrstuvwxyz0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ01.txt');
    const redacted = await slash(`/mcp call probe echo_path ${JSON.stringify({ path: secretPath })}`);
    const evAfter = await events();
    check('outbound MCP args pass the redactor (secret-looking arg not sent verbatim)', redacted.ok && !redacted.output.includes('sk-ant-api03') ? 'Worked' : 'Failed', { output: redacted.output, redactionEvent: evAfter.includes('redaction.applied') });

    // 6. plan mode vs the app's slash MCP route (mutating tool). This documents what the UI route enforces today.
    await page.evaluate(() => window.selfconnect.setPermissionMode('plan'));
    const planMarker = path.join(work, 'plan-mode-marker.txt');
    const planCall = await slash(`/mcp call probe write_marker ${JSON.stringify({ path: planMarker })}`);
    const planBlocked = !planCall.ok || !fs.existsSync(planMarker);
    check('plan mode blocks mutating MCP call via app /mcp route', planBlocked ? 'Worked' : 'Failed', { planCall, markerExists: fs.existsSync(planMarker) });
  } catch (e) {
    results.errors.push(e.stack || String(e));
    process.exitCode = 1;
  } finally {
    if (app) await app.close().catch((e) => results.errors.push(e.message));
    fs.writeFileSync(path.join(outDir, 'partner-mcp-results.json'), JSON.stringify(results, null, 2));
    console.log(JSON.stringify(results, null, 2));
  }
})();

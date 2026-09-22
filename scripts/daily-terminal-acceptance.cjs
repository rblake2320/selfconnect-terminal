const fs=require('node:fs'),path=require('node:path'),os=require('node:os');
const {_electron}=require('playwright');
const root=path.resolve(__dirname,'..'),dir=path.join(root,'docs/jev-20260922');
const work=fs.mkdtempSync(path.join(os.tmpdir(),'sct-daily-'));
const env={...process.env,SELFCONNECT_USER_DATA_DIR:path.join(work,'profile'),SELFCONNECT_A2A_MODE:'off'};
for(const k of ['ELECTRON_RUN_AS_NODE','VITE_DEV_SERVER_URL','SELFCONNECT_LOCAL_ONLY'])delete env[k];
const testedExe=process.env.SCT_TEST_EXE || path.join(root,'release/win-unpacked/SelfConnect Terminal.exe');
const results={at:new Date().toISOString(),exe:testedExe,work,checks:[],errors:[]};let app;
const check=(name,ok,detail)=>{results.checks.push({name,outcome:ok?'Worked':'Failed',detail});if(!ok)throw new Error(name);};
const launch=()=>_electron.launch({executablePath:process.env.SCT_TEST_EXE || path.join(root,'release/win-unpacked/SelfConnect Terminal.exe'),args:['--disable-gpu'],cwd:work,env,timeout:25000});
async function fileReady(file){for(let i=0;i<50;i++){if(fs.existsSync(file))return true;await new Promise(r=>setTimeout(r,100));}return false;}
(async()=>{try{
 app=await launch();let page=await app.firstWindow();page.on('pageerror',e=>results.errors.push(e.message));
 await page.waitForFunction(()=>!!window.selfconnect);
 const term=page.locator('.xterm-helper-textarea');await term.waitFor({state:'attached'});await term.focus();
 await page.evaluate(()=>{window.selfconnect.ptyInput(42);window.selfconnect.ptyResize(-1,0);});
 check('malformed input IPC leaves app responsive',!!(await page.evaluate(()=>window.selfconnect.getState())),{});
 await page.keyboard.type('echo https://example.invalid/a/b>typed-url.txt',{delay:5});await page.keyboard.press('Enter');
 const file=path.join(work,'typed-url.txt');check('packaged keyboard URL reaches real shell',await fileReady(file)&&fs.readFileSync(file,'utf8').trim()==='https://example.invalid/a/b',{file});
 // Run a real stdin-consuming program: slash commands must reach it, not the app.
 fs.writeFileSync(path.join(work,'echo-input.cjs'),"process.stdin.once('data',d=>{require('fs').writeFileSync('agent-input.txt',d);process.exit()});console.log('INPUT_READY')");
 await page.evaluate(()=>{window.__daily='';window.selfconnect.onPtyData(d=>window.__daily+=d);});
 await page.keyboard.type('node echo-input.cjs');await page.keyboard.press('Enter');await page.waitForFunction(()=>window.__daily.includes('INPUT_READY'));
 await page.keyboard.type('/help');await page.keyboard.press('Enter');const agentFile=path.join(work,'agent-input.txt');
 check('agent slash command reaches running child',await fileReady(agentFile)&&fs.readFileSync(agentFile,'utf8').trim()==='/help',{});
 const savedClipboard=await page.evaluate(()=>window.selfconnect.clipboardRead());
 try {
  await page.evaluate(()=>window.selfconnect.clipboardWrite('echo clipboard-passthrough>clipboard.txt'));
  await term.focus();await page.keyboard.press('Control+v');await page.keyboard.press('Enter');
  const clipFile=path.join(work,'clipboard.txt');check('native clipboard paste reaches shell',await fileReady(clipFile)&&fs.readFileSync(clipFile,'utf8').trim()==='clipboard-passthrough',{});
 }finally{await page.evaluate(text=>window.selfconnect.clipboardWrite(text),savedClipboard);}
 await page.keyboard.type('type missing-jev-file.txt');await page.keyboard.press('Enter');
 await page.waitForFunction(()=>window.__daily.includes('cannot find')||window.__daily.includes('Cannot find'));
 await page.getByRole('button',{name:'Preview recent output'}).click();
 const preview=await page.locator('#jev-preview').inputValue();check('Jev preview contains actual shell error',preview.toLowerCase().includes('cannot find'),{characters:preview.length});
 const send=page.getByRole('button',{name:'Send shown output to Jev'});check('local-only disables cloud send',await send.isDisabled(),{});
 await page.getByRole('button',{name:'Enable cloud assistance'}).click();await send.click();
 await page.locator('.jev-result').waitFor({timeout:25000});const result=await page.locator('.jev-result').innerText();
 check('packaged Jev uses real key and returns advisory',result.includes('Error reported')&&result.includes('no commands executed'),{result});
 await page.screenshot({path:path.join(dir,'packaged-jev.png')});
 const ledger=await page.evaluate(()=>window.selfconnect.verifyLedger());check('packaged ledger verifies',ledger.ok,ledger);
 await app.close();app=null;
 const settings=JSON.parse(fs.readFileSync(path.join(work,'profile/settings.json'),'utf8'));check('cloud preference saved',settings.localOnly===false,settings);
 const sessions=fs.readdirSync(path.join(work,'profile/data/sessions'));check('shutdown saves actual scrollback',sessions.some(f=>fs.readFileSync(path.join(work,'profile/data/sessions',f),'utf8').includes('The system cannot find the file specified.')),{});
 app=await launch();page=await app.firstWindow();await page.waitForFunction(()=>!!window.selfconnect);const state=await page.evaluate(()=>window.selfconnect.getState());
 check('relaunch restores preference',state.localOnly===false||state.policy?.localOnly===false,{stateKeys:Object.keys(state)});
 const previous=await page.evaluate(()=>window.selfconnect.listSessions());check('relaunch lists previous saved session',previous.length>=2,{});
 const old=previous.find(s=>s.sessionId!==state.identity.sessionId);
 await page.getByRole('button',{name:`View saved history for session ${old.sessionId}`}).click();
 await page.locator('.history-pre').waitFor();
 check('saved history UI reads real prior output',(await page.locator('.history-pre').innerText()).includes('The system cannot find the file specified.'),{});
 const after=await page.evaluate(()=>window.selfconnect.getState());check('history preserves active session',after.identity.sessionId===state.identity.sessionId,{});
 await page.screenshot({path:path.join(dir,'packaged-history.png')});
 }catch(e){results.errors.push(e.stack);process.exitCode=1;}finally{if(app)await app.close().catch(e=>results.errors.push(e.message));fs.writeFileSync(path.join(dir,'daily-terminal-results.json'),JSON.stringify(results,null,2));console.log(JSON.stringify(results,null,2));}})();

const fs=require('fs'),path=require('path'),os=require('os'),crypto=require('crypto'),{execFileSync}=require('child_process');
const {_electron}=require('playwright');
const root=path.resolve(__dirname,'..'),out=path.join(root,'docs/ecosystem-20260922');
if(fs.existsSync(path.join(out,'team4-results.json')))throw Error('Retained team4 run exists. Archive its artifacts before a new run; never consume stale receipts.');
const exe=JSON.parse(fs.readFileSync(path.join(out,'final-install.json'),'utf8').replace(/^\uFEFF/,'')).executable;
const cfg={analyst:crypto.randomUUID(),victim:crypto.randomUUID()};fs.writeFileSync(path.join(out,'team4-config.json'),JSON.stringify(cfg));
const result={startedAt:new Date().toISOString(),exe,sessions:cfg,checks:[]};let analyst,victim,recovered;
function save(){fs.writeFileSync(path.join(out,'team4-results.json'),JSON.stringify(result,null,2));}
function check(name,ok,detail){result.checks.push({name,worked:!!ok,detail});save();if(!ok)throw Error(name);}
async function until(file,ms=180000){const start=Date.now();while(!fs.existsSync(path.join(out,file))){if(Date.now()-start>ms)throw Error('Timed out waiting for '+file);await new Promise(r=>setTimeout(r,500));}return JSON.parse(fs.readFileSync(path.join(out,file),'utf8'));}
async function launch(profile){const env={...process.env,SELFCONNECT_USER_DATA_DIR:profile,SELFCONNECT_A2A_MODE:'off'};delete env.ELECTRON_RUN_AS_NODE;delete env.VITE_DEV_SERVER_URL;const app=await _electron.launch({executablePath:exe,args:['--disable-gpu'],env,cwd:root});const page=await app.firstWindow();await page.waitForFunction(()=>!!window.selfconnect);const mesh=await page.evaluate(()=>window.selfconnect.nativeMesh(true));return {app,page,profile,bound:mesh.self,mesh};}
function send(t,text){return JSON.parse(execFileSync('python',[path.join(root,'scripts/selfconnect-peer.py'),'--hwnd',String(t.bound.hwnd),'--pid',String(t.bound.pid),'--text',text,'--submit'],{encoding:'utf8',timeout:30000}));}
(async()=>{try{
 analyst=await launch(fs.mkdtempSync(path.join(os.tmpdir(),'sct-team4-analyst-')));result.analyst=analyst.bound;
 check('Analyst window registered alongside existing peer',analyst.mesh.registered&&analyst.mesh.peers.some(p=>p.hwnd===31982268),analyst.mesh.peers);
 send(analyst,'node scripts/team4-worker.cjs analyst');const a=await until('team4-analyst.json');check('New real agent independently writes shared task receipt',JSON.stringify(a).includes('SCT_FOUR_PEERS_20260922'),a);
 victim=await launch(fs.mkdtempSync(path.join(os.tmpdir(),'sct-team4-victim-')));result.victim=victim.bound;result.victimProfile=victim.profile;save();
 send(victim,'echo SCT_CRASH_HISTORY_20260922 && node scripts/team4-worker.cjs victim');const checkpoint=await until('team4-checkpoint.json');check('Fourth agent consumes analyst challenge and checkpoints',JSON.stringify(checkpoint).includes('SCT_FOUR_PEERS_20260922'),checkpoint);
 await new Promise(r=>setTimeout(r,12000));
 const pid=await victim.app.evaluate(()=>process.pid);check('Crash target bound to test-owned process',pid===victim.bound.pid&&pid!==138772,pid);
 execFileSync('taskkill',['/PID',String(pid),'/T','/F'],{windowsHide:true,encoding:'utf8'});
 const crash={at:new Date().toISOString(),crashedPid:pid,hwnd:victim.bound.hwnd,action:'taskkill test-owned process tree /T /F',checkpoint};fs.writeFileSync(path.join(out,'team4-crash.json'),JSON.stringify(crash,null,2));
 check('Other terminal responds after crash',!!await analyst.page.evaluate(()=>window.selfconnect.getState()),analyst.bound);
 send(analyst,'node scripts/team4-worker.cjs survivor resume');const survivor=await until('team4-survivor.json');check('Surviving agent continues shared task after crash',JSON.stringify(survivor).includes('SCT_FOUR_PEERS_20260922'),survivor);
 recovered=await launch(victim.profile);result.recovered=recovered.bound;
 const sessions=await recovered.page.evaluate(()=>window.selfconnect.listSessions());let found=false;for(const s of sessions){const id=s.sessionId||s.id;if(!id)continue;const h=await recovered.page.evaluate(id=>window.selfconnect.sessionHistory(id),id);if(h.scrollback.join('').includes('SCT_CRASH_HISTORY_20260922'))found=true;}
 check('Reopened profile retains precrash saved output',found,sessions);
 send(recovered,'node scripts/team4-worker.cjs recovery resume');const recoveredReceipt=await until('team4-recovered.json');check('Explicitly resumed agent consumes survivor work',JSON.stringify(recoveredReceipt).includes('SCT_FOUR_PEERS_20260922'),recoveredReceipt);
 const mesh=await recovered.page.evaluate(()=>window.selfconnect.nativeMesh(false));check('Dead terminal absent and replacement visible',!mesh.peers.some(p=>p.hwnd===victim.bound.hwnd&&p.pid===victim.bound.pid)&&mesh.registered,mesh);
 result.completedAt=new Date().toISOString();save();console.log(JSON.stringify(result));
 }catch(e){result.error=e.stack;save();console.error(e);}
 setInterval(()=>{},30000);
})();

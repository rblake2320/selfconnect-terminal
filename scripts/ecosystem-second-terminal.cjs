const fs=require('fs'),path=require('path'),{execFileSync}=require('child_process');
const {_electron}=require('playwright');
const root=path.resolve(__dirname,'..'),out=path.join(root,'docs/ecosystem-20260922');
const installed=JSON.parse(fs.readFileSync(path.join(out,'final-install.json'),'utf8').replace(/^\uFEFF/,''));
const profile=path.join(process.env.LOCALAPPDATA,'SelfConnect Terminal Profiles','second-terminal');
const env={...process.env,SELFCONNECT_USER_DATA_DIR:profile,SELFCONNECT_A2A_MODE:'off'};
delete env.ELECTRON_RUN_AS_NODE;delete env.VITE_DEV_SERVER_URL;
const result={at:new Date().toISOString(),executable:installed.executable,profile,checks:[]};
function check(name,ok,detail){result.checks.push({name,worked:!!ok,detail});if(!ok)throw Error(name);}
(async()=>{
 const app=await _electron.launch({executablePath:installed.executable,args:['--disable-gpu'],cwd:root,env});
 const page=await app.firstWindow();await page.waitForFunction(()=>!!window.selfconnect);
 try{
  const state=await page.evaluate(()=>window.selfconnect.nativeMesh(true));result.bound=state.self;
  check('Second installed window joins mesh',state.registered,state);
  check('Existing Claude terminal remains live alongside new window',state.peers.some(p=>p.hwnd===31982268&&p.pid===138772),state.peers);
  await page.getByRole('button',{name:'Refresh peers',exact:true}).click();
  const token='SCT_SECOND_'+Date.now();
  const command=`echo ${token}`;
  result.send=JSON.parse(execFileSync('python',[path.join(root,'scripts/selfconnect-peer.py'),'--hwnd',String(state.self.hwnd),'--pid',String(state.self.pid),'--text',command,'--submit'],{encoding:'utf8',timeout:30000}));
  await page.waitForTimeout(500);
  const history=await page.evaluate(async()=>{const s=await window.selfconnect.getState();return s;});
  result.read=JSON.parse(execFileSync('python',['-m','sc_cli','read','--hwnd',String(state.self.hwnd)],{encoding:'utf8',timeout:20000}));
  check('Guarded native send reaches second real shell',result.send.ok&&(result.read.text||'').split(token).length>=3,{token,text:result.read.text});
  check('Independent app session responds',!!history,history.sessionId);
  await page.screenshot({path:path.join(out,'second-terminal.png')});
 }catch(e){result.error=e.stack;}
 fs.writeFileSync(path.join(out,'second-terminal-results.json'),JSON.stringify(result,null,2));console.log(JSON.stringify({bound:result.bound,checks:result.checks.map(({name,worked})=>({name,worked})),error:result.error}));
 page.on('close',()=>process.exit(0));setInterval(()=>{},30000);
})().catch(e=>{console.error(e);process.exitCode=1;});

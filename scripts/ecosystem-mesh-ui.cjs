const fs=require('fs'),path=require('path'),os=require('os');
const {_electron}=require('playwright');
const out=path.resolve('docs/ecosystem-20260922/mesh-ui-results.json');
const env={...process.env,SELFCONNECT_USER_DATA_DIR:fs.mkdtempSync(path.join(os.tmpdir(),'sct-mesh-ui-')),SELFCONNECT_A2A_MODE:'off'};
delete env.ELECTRON_RUN_AS_NODE;delete env.VITE_DEV_SERVER_URL;
let app;const result={exe:process.env.SCT_TEST_EXE,checks:[]};
function check(name,ok,detail){result.checks.push({name,worked:!!ok,detail});if(!ok)throw Error(name);}
(async()=>{try{
 app=await _electron.launch({executablePath:result.exe,args:['--disable-gpu'],env});
 const page=await app.firstWindow();await page.waitForFunction(()=>!!window.selfconnect);
 await page.getByRole('button',{name:'Refresh peers',exact:true}).click();
 await page.getByText('This window:',{exact:false}).waitFor();
 const before=await page.evaluate(()=>window.selfconnect.nativeMesh(false));
 check('UI reads real native window identity',before.self.pid===(await app.evaluate(()=>process.pid))&&before.self.hwnd>0,before);
 await page.getByRole('button',{name:'Join mesh',exact:true}).click();
 await page.getByRole('button',{name:'Window registered',exact:true}).waitFor();
 const after=await page.evaluate(()=>window.selfconnect.nativeMesh(false));
 check('UI joins canonical registry with its actual window',after.registered&&after.peers.some(p=>p.pid===after.self.pid&&p.hwnd===after.self.hwnd),after);
 check('Observed existing peer agents',after.peers.some(p=>p.role.includes('claude-sct'))&&after.peers.some(p=>p.role.includes('codex-sct')),after.peers);
 const repeated=await page.evaluate(()=>window.selfconnect.nativeMesh(true));
 check('Repeat join retains identity',repeated.peers.find(p=>p.pid===after.self.pid).birthId===after.peers.find(p=>p.pid===after.self.pid).birthId,repeated.registered);
 const denied=await page.evaluate(async()=>{try{await window.selfconnect.nativeMesh('yes');return false;}catch{return true;}});
 check('Malformed IPC rejected',denied,'non-boolean join');
 check('Accounting and roles clearly scoped',await page.getByText('Internal app roles; these are not connected terminal agents.').isVisible()&&await page.getByText('App-managed context only; excludes Claude and Codex shell sessions.').isVisible(),'rendered scope labels');
 await page.screenshot({path:path.resolve('docs/ecosystem-20260922/mesh-ui.png')});
 }catch(e){result.error=e.stack;}finally{if(app)await app.close();fs.writeFileSync(out,JSON.stringify(result,null,2));console.log(JSON.stringify(result));process.exitCode=result.error?1:0;}})();

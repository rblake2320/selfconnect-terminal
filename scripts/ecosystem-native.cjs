const fs=require('fs'),path=require('path'),os=require('os'),{execFileSync}=require('child_process');
const {_electron}=require('playwright');
const root=path.resolve(__dirname,'..'),out=path.join(root,'docs/ecosystem-20260922');fs.mkdirSync(out,{recursive:true});
const work=fs.mkdtempSync(path.join(os.tmpdir(),'sct-core-'));
const installed=JSON.parse(fs.readFileSync(path.join(root,'docs/jev-20260922/install-receipt.json'),'utf8').replace(/^\uFEFF/,''));
const env={...process.env,SELFCONNECT_USER_DATA_DIR:path.join(work,'profile'),SELFCONNECT_A2A_MODE:'off'};
delete env.ELECTRON_RUN_AS_NODE;delete env.VITE_DEV_SERVER_URL;
const result={at:new Date().toISOString(),work,checks:[]};let app;
function cli(args){try{return JSON.parse(execFileSync('python',['-m','sc_cli',...args],{encoding:'utf8',timeout:20000,windowsHide:true}));}catch(e){try{return JSON.parse(String(e.stdout));}catch{return {ok:false,error:e.message};}}}
(async()=>{try{
 app=await _electron.launch({executablePath:process.env.SCT_TEST_EXE||installed.executable,args:['--disable-gpu'],env,cwd:work});const page=await app.firstWindow();await page.waitForFunction(()=>!!window.selfconnect);await page.locator('.xterm-helper-textarea').focus();
 const bound=await app.evaluate(({BrowserWindow})=>{const w=BrowserWindow.getAllWindows()[0];return {hwnd:Number(w.getNativeWindowHandle().readBigUInt64LE()),pid:process.pid,title:w.getTitle()};});
 const guardArgs=['--hwnd',String(bound.hwnd),'--expect-pid',String(bound.pid),'--expect-exe','SelfConnect Terminal.exe','--expect-class','Chrome_WidgetWin_1','--expect-title',bound.title,'--allow-non-terminal'];
 result.bound=bound;result.guard=cli(['guard',...guardArgs]);
 const wrong=[...guardArgs];wrong[wrong.indexOf('--expect-pid')+1]=String(bound.pid+1);
 result.denied=cli(['send',...wrong,'--allow-input','--text','echo WRONG>wrong.txt','--submit']);
 result.checks.push({name:'stale PID refused',worked:!result.denied.ok&&!fs.existsSync(path.join(work,'wrong.txt'))});
 result.registration=JSON.parse(execFileSync('python',['-m','sc_mesh_registry','register','--role','sct-installed-native-20260922','--agent','transport-probe','--profile','explore','--task','Owned installed terminal transport acceptance','--replace',...guardArgs],{encoding:'utf8',timeout:15000}));
 const token='SCT_CORE_'+Date.now();
 result.send=JSON.parse(execFileSync('python',[path.join(root,'scripts/selfconnect-peer.py'),'--hwnd',String(bound.hwnd),'--pid',String(bound.pid),'--title',bound.title,'--text',`echo ${token}>core-received.txt`,'--submit'],{encoding:'utf8',timeout:20000}));
 for(let n=0;n<40&&!fs.existsSync(path.join(work,'core-received.txt'));n++)await page.waitForTimeout(100);
 const file=path.join(work,'core-received.txt');result.checks.push({name:'guarded core send into installed SCT executes exact command',worked:fs.existsSync(file)&&fs.readFileSync(file,'utf8').trim()===token,file,actual:fs.existsSync(file)?fs.readFileSync(file,'utf8').trim():null});
 await page.screenshot({path:path.join(out,'native-send.png')});
 result.read=cli(['read','--hwnd',String(bound.hwnd)]);
 result.checks.push({name:'core readback includes challenge',worked:JSON.stringify(result.read).includes(token)});
 }catch(e){result.error=e.stack;}finally{if(app)await app.close();fs.writeFileSync(path.join(out,'native-results.json'),JSON.stringify(result,null,2));console.log(JSON.stringify({checks:result.checks,error:result.error}));process.exitCode=result.checks.length===3&&result.checks.every(c=>c.worked)?0:1;}})();

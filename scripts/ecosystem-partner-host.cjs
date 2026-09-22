// Hosts the owner's existing Claude SCT partner in the installed terminal.
const fs=require('fs'),path=require('path'),os=require('os');const {_electron}=require('playwright');
const root=path.resolve(__dirname,'..'),out=path.join(root,'docs/ecosystem-20260922');
const installed=JSON.parse(fs.readFileSync(path.join(out,'mesh-install-receipt.json'),'utf8').replace(/^\uFEFF/,''));
const profile=fs.mkdtempSync(path.join(os.tmpdir(),'sct-partner-profile-'));
const env={...process.env,SELFCONNECT_USER_DATA_DIR:profile,SELFCONNECT_A2A_MODE:'off'};delete env.ELECTRON_RUN_AS_NODE;delete env.VITE_DEV_SERVER_URL;
(async()=>{
 const app=await _electron.launch({executablePath:installed.executable,args:['--disable-gpu'],cwd:root,env});const page=await app.firstWindow();
 await page.waitForFunction(()=>!!window.selfconnect);await page.locator('.xterm-helper-textarea').focus();
 const bound=await app.evaluate(({BrowserWindow})=>{const w=BrowserWindow.getAllWindows()[0];return {hwnd:Number(w.getNativeWindowHandle().readBigUInt64LE()),pid:process.pid,title:w.getTitle()};});
 fs.writeFileSync(path.join(out,'partner-host.json'),JSON.stringify({...bound,profile,executable:installed.executable},null,2));
 page.on('close',()=>process.exit(0));
 const timer=setInterval(async()=>{if(fs.existsSync(path.join(out,'partner-host.stop'))){clearInterval(timer);await app.close();}},1000);
})().catch(e=>{console.error(e);process.exitCode=1});

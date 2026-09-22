/** Installed billing disclosure and denial through the actual renderer. No model calls. */
const fs=require('node:fs'),os=require('node:os'),path=require('node:path'),assert=require('node:assert/strict');
const {randomUUID}=require('node:crypto');const {_electron}=require('playwright');
const exe=process.env.SCT_TEST_EXE;if(!exe)throw Error('Set SCT_TEST_EXE');
const work=fs.mkdtempSync(path.join(os.tmpdir(),'sct-billing-ui-')),checks=[];let app;
const check=(name,condition)=>{assert.ok(condition,name);checks.push({name,outcome:'Worked'});};
(async()=>{try{
 const env={...process.env,SELFCONNECT_USER_DATA_DIR:path.join(work,'profile'),SELFCONNECT_LOCAL_ONLY:'1',SELFCONNECT_COMPUTER_PAID_API:'0',SELFCONNECT_A2A_MODE:'off'};
 for(const k of ['ELECTRON_RUN_AS_NODE','ANTHROPIC_API_KEY','VITE_DEV_SERVER_URL'])delete env[k];
 app=await _electron.launch({executablePath:exe,args:['--disable-gpu'],cwd:work,env});const page=await app.firstWindow();await page.waitForFunction(()=>!!window.selfconnect);
 check('paid desktop checkbox is off by default',!await page.getByRole('checkbox',{name:'Request separately billed model suggestions'}).isChecked());
 check('Jev billing notice is shown before any send',await page.getByText('Jev uses a separately billed API, not your CLI subscription.',{exact:false}).count()===1);
 await page.evaluate(()=>window.selfconnect.setPermissionMode('auto'));
 const pending=page.evaluate(c=>window.selfconnect.computerUse(c),{operation:'propose',sessionId:randomUUID(),observationId:randomUUID(),maxChargeUsd:.25});
 await page.locator('.approval-card').waitFor();
 check('approval header displays the paid request cap', (await page.locator('.approval-meta').innerText()).includes('$0.2500'));
 check('approval explicitly distinguishes API bill from subscription', (await page.locator('.approval-preview').innerText()).includes('SEPARATE API BILL'));
 await page.getByRole('button',{name:'Deny',exact:true}).click();const result=await pending;
 check('real Deny button blocks the proposal',result.ok===false&&result.blocked===true);
 const events=await page.evaluate(()=>window.selfconnect.replayEvents());
 check('denial creates no model request event',!events.some(e=>e.type==='computer_use.model.requested'));
 await page.screenshot({path:path.join(work,'billing-ui.png')});
}catch(e){checks.push({name:'harness completion',outcome:'Failed',detail:String(e.stack||e)});process.exitCode=1;}finally{
 if(app)await app.close();const report={exe,work,checks,providerRequests:0};fs.writeFileSync(path.join(__dirname,'../docs/ecosystem-20260922/computer-ui-billing-final.json'),JSON.stringify(report,null,2));console.log(JSON.stringify(report,null,2));
}})();

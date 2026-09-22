/** Installed Electron/asar billing acceptance. No windows, provider or API calls. */
const fs=require('node:fs'),path=require('node:path'),os=require('node:os'),assert=require('node:assert/strict');
if(!process.versions.electron){
 const {spawnSync}=require('node:child_process');
 const exe=process.env.SCT_TEST_EXE;if(!exe)throw Error('Set SCT_TEST_EXE to the installed executable');
 const r=spawnSync(exe,[__filename,path.join(path.dirname(exe),'resources','app.asar')],{env:{...process.env,ELECTRON_RUN_AS_NODE:'1'},encoding:'utf8',windowsHide:true});
 process.stdout.write(r.stdout||'');process.stderr.write(r.stderr||'');process.exit(r.status??1);
}
const root=process.argv[2],checks=[];
const {loadConfig}=require(path.join(root,'dist-electron/src/daemon/config.js'));
const {ComputerUseBilling}=require(path.join(root,'dist-electron/src/daemon/computer-use-billing.js'));
const {ComputerUseController}=require(path.join(root,'dist-electron/src/daemon/computer-use.js'));
const dir=fs.mkdtempSync(path.join(os.tmpdir(),'sct-installed-billing-'));
function check(name,fn){fn();checks.push({name,outcome:'Worked'});}
(async()=>{
 check('installed configuration defaults to no paid computer API and local-only',()=>{const c=loadConfig({APPDATA:dir});assert.equal(c.computerPaidEnabled,false);assert.equal(c.localOnly,true);});
 const ctl=new ComputerUseController('unused',dir,()=>{});
 const req={target:{hwnd:1,pid:1,exe:'unused',className:'unused',title:'unused'},objective:'refusal only',executionMode:'desktop_assist',billingMode:'paid_api',paidConsent:{provider:'anthropic',model:'claude-sonnet-5',sessionCapUsd:2,taskCapUsd:.5,projectCapUsd:25,priceInputPerMillion:2,priceOutputPerMillion:10,acknowledgeSeparateBilling:true}};
 await assert.rejects(ctl.start(req),/PAID_API_DISABLED/);checks.push({name:'installed controller refuses paid session without explicit runtime configuration',outcome:'Worked'});
 const file=path.join(dir,'budget.json'),b=new ComputerUseBilling(file),caps={projectCapUsd:.5,sessionCapUsd:.5,taskCapUsd:.5};
 const id=b.reserve('session',.3,caps);
 check('reservation survives a fresh billing instance',()=>assert.equal(new ComputerUseBilling(file).snapshot('session').sessionCommittedUsd,.3));
 check('cumulative task cap refuses next request',()=>assert.throws(()=>b.reserve('session',.3,caps),/BUDGET_EXCEEDED/));
 b.uncertain(id);check('unknown response retains full reservation',()=>assert.equal(b.snapshot('session').sessionCommittedUsd,.3));
 const id2=b.reserve('second',.1,caps);b.settle(id2,.2);
 check('observed reservation overrun locks all later requests',()=>assert.throws(()=>b.reserve('third',.01,caps),/BUDGET_EXCEEDED/));
 fs.writeFileSync(file,'truncated');check('corrupt billing data refuses requests',()=>assert.throws(()=>b.reserve('third',.01,caps)));
 console.log(JSON.stringify({artifact:root,work:dir,checks,providerRequests:0,desktopInputActions:0},null,2));
})().catch(e=>{console.error(e);process.exitCode=1;});

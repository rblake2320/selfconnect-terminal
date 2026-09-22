/** Exact native input outcomes on an owned fixture; no API calls. */
const fs=require('node:fs'),path=require('node:path'),os=require('node:os');
const {spawn}=require('node:child_process');const {_electron}=require('playwright');
const root=path.resolve(__dirname,'..'),work=fs.mkdtempSync(path.join(os.tmpdir(),'sct-input-'));
const file=path.join(work,'fixture.json'),checks=[],sleep=ms=>new Promise(r=>setTimeout(r,ms));
const exe=process.env.SCT_TEST_EXE;if(!exe)throw Error('Set SCT_TEST_EXE');
const read=()=>JSON.parse(fs.readFileSync(file,'utf8'));
const check=(name,ok,detail)=>checks.push({name,outcome:ok?'Worked':'Failed',detail});
let app,fixture;
(async()=>{try{
 const env={...process.env,SELFCONNECT_USER_DATA_DIR:path.join(work,'profile'),SELFCONNECT_LOCAL_ONLY:'1',SELFCONNECT_COMPUTER_PAID_API:'0',SELFCONNECT_A2A_MODE:'off'};delete env.ELECTRON_RUN_AS_NODE;delete env.ANTHROPIC_API_KEY;
 app=await _electron.launch({executablePath:exe,args:['--disable-gpu'],cwd:work,env});const page=await app.firstWindow();
 await page.waitForFunction(()=>!!window.selfconnect);
 fixture=spawn('python',[path.join(root,'scripts/computer-use-fixture.py'),file],{stdio:'ignore',windowsHide:false});fixture.unref();
 let target;for(let i=0;i<40&&!target;i++){await sleep(100);const wins=await page.evaluate(()=>window.selfconnect.computerUse({operation:'windows'}));target=wins.find(w=>w.pid===fixture.pid&&w.class_name==='TkTopLevel');}
 if(!target)throw Error('Owned fixture not found');target={hwnd:target.hwnd,pid:target.pid,exe:target.exe_name,className:target.class_name,title:target.title};
 await page.evaluate(()=>window.selfconnect.setPermissionMode('auto'));
 const paidToggle=page.getByRole('checkbox',{name:'Request separately billed model suggestions'});
 check('desktop UI defaults to paid mode off',!(await paidToggle.isChecked()),{});
 await page.getByRole('button',{name:'Find desktop windows'}).click();
 await page.getByLabel('Desktop target window').selectOption(String(target.hwnd));
 await paidToggle.check();
 check('paid UI requires separate billing acknowledgment before starting',await page.getByRole('button',{name:'Request desktop session',exact:true}).isDisabled(),{});
 await paidToggle.uncheck();
 await page.getByLabel('Desktop objective').fill('Owned fixture UI flow, no API');
 await page.getByRole('button',{name:'Request desktop session',exact:true}).click();
 await page.getByRole('button',{name:'Approve',exact:true}).click();
 await page.getByRole('button',{name:'Stop desktop session',exact:true}).waitFor();
 check('real UI start creates an approved subscription-only session',(await page.evaluate(()=>window.selfconnect.computerUse({operation:'list'}))).some(s=>s.request.billingMode==='subscription_only'&&s.status==='ACTIVE'),{});
 await page.getByRole('button',{name:'Stop desktop session',exact:true}).click();
 await page.waitForFunction(async()=> (await window.selfconnect.computerUse({operation:'list'})).every(s=>s.status==='STOPPED'));
 check('real UI stop ends the desktop session',true,{});
 const governed=async(command)=>{
  const pending=page.evaluate(c=>window.selfconnect.computerUse(c),command);let settled=false;pending.finally(()=>{settled=true;}).catch(()=>{});
  for(let i=0;i<100&&!settled;i++){const state=await page.evaluate(()=>window.selfconnect.getState());for(const a of state.approvals)if(a.status==='pending')await page.evaluate(id=>window.selfconnect.decideApproval(id,true),a.id);await sleep(30);}
  const r=await pending;if(!r.ok)throw Error(r.error||r.blockReason);return JSON.parse(r.output);
 };
 let session=await governed({operation:'start',request:{target,objective:'Verify exact keyboard, pointer and scroll effects',billingMode:'subscription_only',executionMode:'desktop_assist',maxActions:30,maxMinutes:5}});
 const act=async(action)=>{session=await governed({operation:'act',action:{...action,sessionId:session.id,sequence:session.sequence,...(session.observation?{observationId:session.observation.id}:{})}});await sleep(150);};
 await act({type:'observe'});await act({type:'focus'});
 await act({type:'type',text:'A'});await act({type:'keypress',keys:['enter']});await act({type:'type',text:'B'});
 check('Enter produces exactly one newline',read().text==='A\nB',read());
 await act({type:'keypress',keys:['ctrl+a']});await act({type:'type',text:'replacement'});
 check('Ctrl+A selects all, subsequent typing replaces all text',read().text==='replacement',read());
 await act({type:'keypress',keys:['space']});check('Space inserts a space',read().text.endsWith('replacement '),read());
 await act({type:'keypress',keys:['ctrl+a']});await act({type:'type',text:Array.from({length:60},(_,i)=>`line ${i}`).join('\n')});
 await act({type:'keypress',keys:['ctrl+home']});const top=read();check('Ctrl+Home reaches document start',top.cursor==='1.0',top.cursor);
 await act({type:'keypress',keys:['ctrl+end']});const bottom=read();check('Ctrl+End reaches document end',bottom.cursor==='60.7',bottom.cursor);
 await act({type:'keypress',keys:['pageup']});const up=read();check('PageUp moves toward earlier document content',up.yview[0]<bottom.yview[0],{before:bottom.yview,after:up.yview});
 await act({type:'keypress',keys:['pagedown']});const down=read();check('PageDown moves toward later document content',down.yview[0]>up.yview[0],{before:up.yview,after:down.yview});
 await act({type:'keypress',keys:['ctrl+home']});const beforeScroll=read();
 await act({type:'scroll',delta:5,point:{x:200,y:150}});const afterScroll=read();check('Positive scroll moves viewport down',afterScroll.yview[0]>beforeScroll.yview[0],{before:beforeScroll.yview,after:afterScroll.yview});
 await act({type:'scroll',delta:-5,point:{x:200,y:150}});const back=read();check('Negative scroll moves viewport up',back.yview[0]<afterScroll.yview[0],{before:afterScroll.yview,after:back.yview});
 const beforeClick=read().cursor;await act({type:'click',point:{x:130,y:130}});check('Click moves insertion cursor at the target point',read().cursor!==beforeClick,{before:beforeClick,after:read().cursor});
 await page.screenshot({path:path.join(work,'app.png')});await page.evaluate(id=>window.selfconnect.computerUse({operation:'stop',sessionId:id}),session.id);
}catch(e){checks.push({name:'harness completion',outcome:'Failed',detail:String(e.stack||e)});}finally{
 if(fixture){try{process.kill(fixture.pid);}catch{}}if(app)await app.close();
 const report={exe,work,checks,providerRequests:0};const out=process.env.SCT_INPUT_REPORT||path.join(root,'docs/ecosystem-20260922/computer-input-results.json');fs.writeFileSync(out,JSON.stringify(report,null,2));console.log(JSON.stringify(report,null,2));if(checks.some(c=>c.outcome==='Failed'))process.exitCode=1;
}})();

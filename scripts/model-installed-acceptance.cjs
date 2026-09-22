const fs=require('fs'),path=require('path'),os=require('os'),{_electron}=require('playwright');
const root=path.resolve(__dirname,'..');
const dir=fs.mkdtempSync(path.join(os.tmpdir(),'sct-model-acceptance-'));
const exe=process.env.SCT_TEST_EXE;if(!exe)throw Error('SCT_TEST_EXE required');
(async()=>{let app;try{
 const env={...process.env,SELFCONNECT_USER_DATA_DIR:path.join(dir,'profile'),SELFCONNECT_LOCAL_ONLY:'1',SELFCONNECT_A2A_MODE:'off'};delete env.ELECTRON_RUN_AS_NODE;
 app=await _electron.launch({executablePath:exe,cwd:root,env});const page=await app.firstWindow();await page.waitForFunction(()=>!!window.selfconnect);
 await page.evaluate(()=>{window.__modelOutput='';window.selfconnect.onPtyData(d=>window.__modelOutput+=d);});
 const command=`node "${path.join(root,'scripts/model-cli-probe.cjs')}" "${dir}"`;
 await page.evaluate(c=>window.selfconnect.ptyInput(c+'\r'),command);
 console.log(JSON.stringify({dir,exe}));
 await page.waitForFunction(()=>window.__modelOutput.includes('SCT_MODEL_MATRIX_DONE'),null,{timeout:2100000});
 fs.writeFileSync(path.join(dir,'pty-output.txt'),await page.evaluate(()=>window.__modelOutput));
 const rows=JSON.parse(fs.readFileSync(path.join(dir,'results.json'),'utf8'));console.log(JSON.stringify(rows,null,2));
 if(rows.some(r=>r.outcome!=='Worked'))process.exitCode=1;
}finally{if(app)await app.close();}})().catch(e=>{console.error(e);process.exitCode=1;});

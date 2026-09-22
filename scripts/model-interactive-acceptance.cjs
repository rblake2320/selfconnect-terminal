const fs=require('fs'),path=require('path'),os=require('os'),{_electron}=require('playwright');
const dir=fs.mkdtempSync(path.join(os.tmpdir(),'sct-interactive-model-'));
(async()=>{let app;try{
 const env={...process.env,SELFCONNECT_USER_DATA_DIR:path.join(dir,'profile'),SELFCONNECT_LOCAL_ONLY:'1',SELFCONNECT_A2A_MODE:'off'};delete env.ELECTRON_RUN_AS_NODE;
 app=await _electron.launch({executablePath:process.env.SCT_TEST_EXE,cwd:os.homedir(),env});const p=await app.firstWindow();await p.waitForFunction(()=>!!window.selfconnect);
 await p.exposeFunction('recordModelOutput',d=>fs.appendFileSync(path.join(dir,'output.txt'),d));
 await p.evaluate(()=>{window.__o='';window.selfconnect.onPtyData(d=>{window.__o+=d;window.recordModelOutput(d);});});
 await p.evaluate(()=>window.selfconnect.ptyInput('where codex & codex --version\r'));
 await p.waitForFunction(()=>window.__o.includes('codex-cli 0.155.1'));
 await p.evaluate(()=>{window.__o='';window.selfconnect.ptyInput('codex --no-alt-screen -m gpt-6-astra "What is 719 plus 823? Reply only with the decimal result. Do not use tools."\r');});
 console.log(JSON.stringify({dir}));
 await p.waitForFunction(()=>window.__o.includes('1542'),null,{timeout:120000});
 const raw=await p.evaluate(()=>window.__o);fs.writeFileSync(path.join(dir,'output.txt'),raw);
 const result={outcome:'Worked',scenario:'Normal interactive codex launch from home with existing user config returns computed answer through installed PTY',expected:'1542',oldVersionError:raw.includes('requires a newer version')};
 if(result.oldVersionError)throw Error('version refusal remained');
 fs.writeFileSync(path.join(dir,'result.json'),JSON.stringify(result,null,2));console.log(JSON.stringify(result));
 await p.evaluate(()=>window.selfconnect.ptyInput('\x03\x03'));
}finally{if(app)await app.close();}})().catch(e=>{console.error(e);process.exitCode=1;});

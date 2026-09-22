// Runs inside SCT's PTY. No API-key fallback; existing subscription logins only.
const fs=require('fs'),path=require('path'),os=require('os'),{spawnSync}=require('child_process');
const dir=process.argv[2]; if(!dir)throw Error('evidence directory required');
const env={...process.env};
for(const key of ['OPENAI_API_KEY','ANTHROPIC_API_KEY','ANTHROPIC_AUTH_TOKEN','GEMINI_API_KEY','GOOGLE_API_KEY','GOOGLE_GENAI_USE_VERTEXAI','CLAUDECODE'])delete env[key];
const models=JSON.parse(fs.readFileSync(path.join(os.homedir(),'.codex/models_cache.json'),'utf8')).models.filter(m=>m.visibility==='list').map(m=>m.slug);
const prompt='Reply with exactly SCT_MODEL_REPLY_OK. Do not use any tools.';
let jobs=models.map(model=>({cli:'codex',model,args:['exec','--ignore-user-config','--skip-git-repo-check','--ephemeral','--sandbox','read-only','--model',model,'--json',prompt]}));
for(const model of ['sonnet','opus','haiku'])jobs.push({cli:'claude',model,args:['-p',prompt,'--model',model,'--output-format','json','--tools','','--strict-mcp-config','--setting-sources','']});
jobs.push({cli:'gemini',model:'default',args:['-p',prompt,'--output-format','json','--extensions','none']});
if(process.env.SCT_PROBE_AGY_ONLY==='1'){
 const agy=path.join(process.env.LOCALAPPDATA,'agy/bin/agy.exe');
 const list=spawnSync(agy,['models'],{env,encoding:'utf8',timeout:30000});
 if(list.status!==0)throw Error('Cannot list authenticated Antigravity models');
 jobs=list.stdout.split(/\r?\n/).filter(l=>l.includes('\t')).map(l=>l.split('\t')[0]).map(model=>({cli:'agy',model,args:['-p',prompt,'--model',model,'--mode','plan','--output-format','json','--print-timeout','90s']}));
 if(!jobs.length)throw Error('No Antigravity models returned');
}
const results=[];
for(const job of jobs){
 const start=Date.now();
 const shim=job.cli==='agy'?path.join(process.env.LOCALAPPDATA,'agy/bin/agy.exe'):spawnSync('where.exe',[job.cli+'.cmd'],{encoding:'utf8'}).stdout.trim().split(/\r?\n/)[0];
 const prefix=path.dirname(shim);
 const entry=job.cli==='agy'?shim:path.join(prefix,'node_modules',job.cli==='codex'?'@openai/codex/bin/codex.js':job.cli==='claude'?'@anthropic-ai/claude-code/bin/claude.exe':'@google/gemini-cli/bundle/gemini.js');
 const native=['claude','agy'].includes(job.cli);
 const r=spawnSync(native?entry:process.execPath,native?job.args:[entry,...job.args],{cwd:dir,env,encoding:'utf8',timeout:150000,maxBuffer:8*1024*1024,windowsHide:true});
 const raw=(r.stdout||'')+'\n'+(r.stderr||'');
 fs.writeFileSync(path.join(dir,job.cli+'-'+job.model+'.log'),raw);
 let reply='';try{if(job.cli==='codex'){for(const l of (r.stdout||'').split('\n')){try{const e=JSON.parse(l);if(e.type==='item.completed'&&e.item?.type==='agent_message')reply=e.item.text;}catch{}}}else{const d=JSON.parse(r.stdout);reply=d.result||d.response||'';}}catch{}
 const row={cli:job.cli,model:job.model,exit:r.status,elapsedMs:Date.now()-start,outcome:r.status===0&&reply.trim()==='SCT_MODEL_REPLY_OK'?'Worked':'Failed',reply,error:r.error?.message};results.push(row);
 fs.writeFileSync(path.join(dir,'results.json'),JSON.stringify(results,null,2));console.log(JSON.stringify(row));
}
console.log('SCT_MODEL_MATRIX_DONE');
if(results.some(r=>r.outcome!=='Worked'))process.exitCode=1;

// Local-only inventory: detect PATH shadowing before debugging a model/provider.
const fs=require('fs'),path=require('path'),{spawnSync}=require('child_process');
const packages={codex:'@openai/codex',claude:'@anthropic-ai/claude-code',gemini:'@google/gemini-cli'};
function inventory(env=process.env){
 return Object.entries(packages).map(([cli,pkg])=>{
  const found=spawnSync('where.exe',[cli+'.cmd'],{env,encoding:'utf8',windowsHide:true});
  const installations=[...new Set((found.stdout||'').trim().split(/\r?\n/).filter(Boolean))].map(shim=>{
   try{return{shim,version:JSON.parse(fs.readFileSync(path.join(path.dirname(shim),'node_modules',pkg,'package.json'),'utf8')).version};}
   catch{return{shim,version:null};}
  });
  const versions=new Set(installations.map(i=>i.version));
  return{cli,selected:installations[0]||null,installations,outcome:!installations.length?'Missing':versions.has(null)?'Unreadable':versions.size>1?'Version conflict':'Consistent'};
 });
}
if(require.main===module){const rows=inventory();console.log(JSON.stringify(rows,null,2));if(rows.some(r=>['Version conflict','Unreadable'].includes(r.outcome)))process.exitCode=1;}
module.exports={inventory};

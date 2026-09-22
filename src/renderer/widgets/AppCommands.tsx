import React,{useState} from 'react';
export function AppCommands():React.JSX.Element {
 const [command,setCommand]=useState('/help');const [output,setOutput]=useState('');const [busy,setBusy]=useState(false);
 return <details className="app-commands"><summary>SelfConnect commands</summary><form onSubmit={async e=>{e.preventDefault();if(/^\/resume(?:\s|$)/.test(command.trim())){setOutput('Use View history in Sessions to read saved output. A saved snapshot cannot restore a running shell or CLI agent.');return;}setBusy(true);try{const r=await window.selfconnect.slashRun(command);setOutput(r.output);}catch(err){setOutput((err as Error).message);}finally{setBusy(false);}}}>
 <label htmlFor="app-command">App command</label><input id="app-command" value={command} onChange={e=>setCommand(e.target.value)} placeholder="/help"/><button className="btn" disabled={busy}>Run app command</button>
 </form><p className="muted">The main terminal sends all input directly to your shell or CLI agent.</p>{output&&<pre className="app-command-output">{output}</pre>}</details>;
}

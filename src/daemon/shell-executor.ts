import { spawn, execFile } from 'node:child_process';
import { redact } from './redactor';

export function terminalEnvironment(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  for (const name of ['JEV_API_KEY','TYPESAFE_API_KEY','ANTHROPIC_API_KEY','OPENAI_COMPAT_API_KEY','SEARCH_API_KEY','SC_JEV_KEY_FILE']) delete env[name];
  return env;
}

/** Governed one-shot commands have a real exit result, bounded output and lifetime. */
export function runShellCommand(command: string, cwd: string, timeoutMs = 30000): Promise<string> {
  return new Promise((resolve,reject) => {
    const child = spawn(command, { shell: true, cwd, windowsHide: true, env:terminalEnvironment(), stdio:['ignore','pipe','pipe'] });
    let output=''; let failure=''; let finished=false;
    const stop = (reason: string) => {
      failure=reason;
      if (process.platform==='win32' && child.pid) execFile('taskkill.exe',['/PID',String(child.pid),'/T','/F'],{windowsHide:true},()=>{});
      else child.kill('SIGKILL');
    };
    const timer=setTimeout(()=>stop(`Shell command timed out after ${timeoutMs}ms`),timeoutMs);
    const append=(data:Buffer)=>{output+=data.toString();if(output.length>1024*1024){output=output.slice(0,1024*1024);stop('Shell output exceeded 1 MiB');}};
    child.stdout.on('data',append);child.stderr.on('data',append);
    child.on('error',()=>{if(finished)return;finished=true;clearTimeout(timer);reject(new Error('Shell process could not start.'));});
    child.on('close',(code,signal)=>{if(finished)return;finished=true;clearTimeout(timer);const safe=redact(output).redacted;
      if(failure||code!==0)reject(new Error(`${failure || `Shell exited ${code ?? signal}`}${safe?'\n'+safe:''}`));
      else resolve(safe || '(exit 0; no output)');
    });
  });
}

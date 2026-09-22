// Launch a real CLI agent inside the installed terminal's PTY, preserving JSON output.
const fs=require('fs'),path=require('path'),{spawn}=require('child_process');
const lane=process.argv[2],resume=process.argv[3]==='resume';
const root=path.resolve(__dirname,'..'),out=path.join(root,'docs/ecosystem-20260922');
const config=JSON.parse(fs.readFileSync(path.join(out,'team4-config.json'),'utf8'));
const prompts={
 analyst:'You are the analyst in an authorized four-agent installed SelfConnect Terminal test. Read docs/ecosystem-20260922/team4-plan.md and final-mcp-results.json. Use Write to create team4-analyst.json in that folder with your independently counted worked/failed checks and challenge SCT_FOUR_PEERS_20260922. Then finish. Do not spawn agents or edit source.',
 victim:'You are the recovery worker in an authorized four-agent SelfConnect terminal crash test. Read docs/ecosystem-20260922/team4-plan.md and team4-analyst.json. Write team4-checkpoint.json in that folder containing the analyst challenge exactly, your own task description, and nextAction: read analyst survivor receipt after restart. After writing, use Bash to run python -c "import time; time.sleep(45)". The test will crash your terminal during this wait; this is expected. Do not edit source or spawn agents.',
 survivor:'Continue the four-agent test. Read docs/ecosystem-20260922/team4-crash.json and team4-checkpoint.json. Write team4-survivor.json there containing the exact challenge, crashedPid from the crash receipt, and independently observed fact that you are continuing in your original session after the other terminal died. Do not edit source or spawn agents.',
 recovery:'Your terminal was deliberately crashed during the authorized test. This is a resume of your previous session. Read docs/ecosystem-20260922/team4-survivor.json and team4-checkpoint.json. Write team4-recovered.json there with the same challenge, the prior nextAction, a summary of the survivor output, and what context you recovered from your resumed transcript. Do not claim automatic recovery: lead explicitly relaunched and resumed you. Do not edit source or spawn agents.'};
const role=lane==='survivor'?'analyst':lane==='recovery'?'victim':lane;
const args=['-p',prompts[lane],'--output-format','json','--permission-mode','auto','--allowedTools','Read','Write','Bash(python *)',resume?'--resume':'--session-id',config[role]];
const stream=fs.createWriteStream(path.join(out,`team4-${lane}-cli.json`));
const child=spawn(path.join(process.env.APPDATA,'npm/node_modules/@anthropic-ai/claude-code/bin/claude.exe'),args,{cwd:root,stdio:['ignore','pipe','pipe'],windowsHide:true});
child.stdout.on('data',b=>{process.stdout.write(b);stream.write(b);});child.stderr.on('data',b=>process.stderr.write(b));
child.on('close',code=>{stream.end();console.log(`TEAM4_${lane}_EXIT ${code}`);process.exitCode=code||0;});

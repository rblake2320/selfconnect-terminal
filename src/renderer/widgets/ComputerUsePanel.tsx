import React,{useState} from 'react';
import type {DesktopSession} from '../../daemon/computer-use';
type Target={hwnd:number;pid:number;title:string;exe_name:string;class_name:string};
export function ComputerUsePanel():React.JSX.Element{
 const [targets,setTargets]=useState<Target[]>([]),[chosen,setChosen]=useState(''),[objective,setObjective]=useState('Inspect the approved window'),[session,setSession]=useState<DesktopSession|null>(null),[image,setImage]=useState(''),[error,setError]=useState(''),[busy,setBusy]=useState(false),[paid,setPaid]=useState(false),[consent,setConsent]=useState(false),[proposal,setProposal]=useState<Record<string,unknown>|null>(null),[action,setAction]=useState('observe'),[value,setValue]=useState('');
 async function invoke(raw:unknown){setBusy(true);setError('');try{
  const result=await window.selfconnect.computerUse(raw) as {ok:boolean;output:string;error?:string;blockReason?:string};
  if(!result.ok)throw Error(result.error||result.blockReason||'Desktop action refused');
  const parsed=JSON.parse(result.output);const next=(parsed.session??parsed) as DesktopSession;setSession(next);setProposal(parsed.action??null);
  if(next.observation)setImage(await window.selfconnect.computerUse({operation:'image',sessionId:next.id}) as string);
 }catch(e){setError((e as Error).message);}finally{setBusy(false);}}
 async function refresh(){setError('');try{setTargets(await window.selfconnect.computerUse({operation:'windows'}) as Target[]);}catch(e){setError((e as Error).message);}}
 function start(){const t=targets.find(t=>String(t.hwnd)===chosen);if(!t)return;setImage('');void invoke({operation:'start',request:{target:{hwnd:t.hwnd,pid:t.pid,exe:t.exe_name,className:t.class_name,title:t.title},objective,maxActions:10,maxMinutes:5,executionMode:'desktop_assist',billingMode:paid?'paid_api':'subscription_only',...(paid?{paidConsent:{provider:'anthropic',model:'claude-sonnet-5',sessionCapUsd:2,taskCapUsd:.5,projectCapUsd:25,priceInputPerMillion:2,priceOutputPerMillion:10,acknowledgeSeparateBilling:consent}}:{})}});}
 function act(){if(!session)return;let extra:Record<string,unknown>={};if(action==='type')extra={text:value};if(action==='keypress')extra={keys:[value]};if(action==='wait')extra={waitMs:Number(value)};if(action==='scroll')extra={delta:Number(value)};if(action==='click'){const [x,y]=value.split(',').map(Number);extra={point:{x,y}};}
  void invoke({operation:'act',action:{type:action,sessionId:session.id,sequence:session.sequence,...(session.observation?{observationId:session.observation.id}:{}),...extra}});
 }
 async function stop(){if(!session)return;try{setSession(await window.selfconnect.computerUse({operation:'stop',sessionId:session.id}) as DesktopSession);}catch(e){setError((e as Error).message);}}
 return <section className="card"><div className="card-title">Desktop assist</div>
  <p className="muted">Local execution by default. Actions require approval. Model suggestions are optional and separately billed when explicitly enabled.</p>
  <p><strong>Paid API: {paid?'REQUESTED � separately billed':'OFF'}.</strong> No automatic paid fallback.</p>
  <label><input type="checkbox" checked={paid} onChange={e=>{setPaid(e.target.checked);setConsent(false);}}/> Request separately billed model suggestions</label>
  {paid&&<><p className="muted">Requires the administrator setting SELFCONNECT_COMPUTER_PAID_API=1 and a separate API key. Anthropic claude-sonnet-5: $2 input / $10 output per million tokens, plus screenshot and toolset input (about 4,590 tokens). Task cap $0.50; session $2; project $25. Each request needs approval; conservative reservations are not a provider invoice guarantee.</p><label><input type="checkbox" checked={consent} onChange={e=>setConsent(e.target.checked)}/> I understand API usage is separately billed and authorize these caps for this session.</label></>}

  <button className="btn" disabled={busy} onClick={()=>void refresh()}>Find desktop windows</button>
  <select aria-label="Desktop target window" value={chosen} onChange={e=>setChosen(e.target.value)} style={{width:'100%'}}><option value="">Choose one window</option>{targets.map(t=><option key={t.hwnd} value={t.hwnd}>{t.title} · {t.exe_name} · {t.hwnd}</option>)}</select>
  <input aria-label="Desktop objective" value={objective} onChange={e=>setObjective(e.target.value)} style={{width:'100%'}}/>
  <button className="btn" disabled={busy||!chosen||(paid&&!consent)} onClick={start}>Request desktop session</button>
  {session&&<><p className="mono">{session.status} · action {session.sequence}/{session.request.maxActions}<br/>HWND {session.request.target.hwnd} · PID {session.request.target.pid}<br/>Model API spend: ${session.paidSpendUsd.toFixed(4)}</p>
  <button className="btn" onClick={()=>void stop()}>Stop desktop session</button>
  {session.request.billingMode==='paid_api'&&<button className="btn" disabled={busy||!session.observation||session.status!=='ACTIVE'} onClick={()=>void invoke({operation:'propose',sessionId:session.id,observationId:session.observation?.id,maxChargeUsd:.25})}>Request paid suggestion (up to $0.25)</button>}
  {proposal&&<><pre style={{whiteSpace:'pre-wrap'}}>{JSON.stringify(proposal,null,2)}</pre><button className="btn" disabled={busy} onClick={()=>void invoke({operation:'act',action:proposal})}>Request approval for suggested action</button></>}
  <select aria-label="Desktop action" value={action} onChange={e=>setAction(e.target.value)}>{['observe','focus','click','type','keypress','scroll','wait','finish'].map(a=><option key={a}>{a}</option>)}</select>
  <textarea aria-label="Desktop action value" value={value} onChange={e=>setValue(e.target.value)} placeholder="Text; click x,y; key combo; scroll count; wait milliseconds" style={{width:'100%'}}/>
  <button className="btn" disabled={busy||session.status!=='ACTIVE'} onClick={act}>{busy?'Awaiting approval / execution':'Request action'}</button>
  <p className="muted">Observe first. Coordinates use the full captured window. Captures may contain sensitive content. They stay local unless you approve a paid suggestion. No clipboard or file upload actions.</p>
  {image&&<img src={image} alt="Approved desktop window observation" style={{width:'100%'}}/>}</>}
  {error&&<p role="alert" className="bad">{error}</p>}
 </section>;
}

import React,{useState} from 'react';
import type {NativeMeshState} from '../../shared/native-mesh';
export function NativeMeshPanel():React.JSX.Element{
 const [state,setState]=useState<NativeMeshState|null>(null),[busy,setBusy]=useState(false),[error,setError]=useState('');
 async function load(join:boolean){setBusy(true);setError('');try{setState(await window.selfconnect.nativeMesh(join));}catch(e){setError((e as Error).message);}finally{setBusy(false);}}
 return <section className="card"><div className="card-title">SelfConnect mesh</div>
 <p className="muted">Live windows from your installed SelfConnect Core registry.</p>
 <button className="btn" disabled={busy} onClick={()=>void load(false)}>Refresh peers</button>{' '}
 <button className="btn" disabled={busy||!!state?.registered} onClick={()=>void load(true)}>{state?.registered?'Window registered':'Join mesh'}</button>
 {error&&<p role="alert">{error}</p>}
 {state&&<><p className="mono">This window: {state.self.hwnd} · PID {state.self.pid}</p>
 <p className="muted">Observed {new Date(state.observedAt).toLocaleTimeString()}. Recheck identity before sending.</p>
 {state.peers.map(p=><details key={p.birthId}><summary>{p.role} · {p.status}</summary><p className="mono">{p.birthId}<br/>HWND {p.hwnd} · PID {p.pid}<br/>{p.title}<br/>{p.exe} · {p.className}</p></details>)}
 {!state.peers.length&&<p className="muted">No registered live peer windows found.</p>}</>}
 </section>;
}

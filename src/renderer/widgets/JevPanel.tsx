import React, { useEffect, useState } from 'react';
import { JEV_STATUS, JEV_ACTIONS, type JevSnapshot, type JevAnalysis } from '../../shared/jev';

export function JevPanel({localOnly, sessionId, onLocalOnly}: {localOnly:boolean;sessionId:string;onLocalOnly:(value:boolean)=>Promise<void>}): React.JSX.Element {
  const [snapshot,setSnapshot]=useState<JevSnapshot|null>(null);
  const [result,setResult]=useState<JevAnalysis|null>(null);
  const [busy,setBusy]=useState(false);const [error,setError]=useState('');
  useEffect(()=>{setSnapshot(null);setResult(null);setError('');},[sessionId]);
  async function preview(){setError('');setResult(null);setBusy(true);try{setSnapshot(await window.selfconnect.jevPreview());}catch(e){setError((e as Error).message);}finally{setBusy(false);}}
  async function analyze(){if(!snapshot)return;setError('');setBusy(true);try{setResult(await window.selfconnect.jevAnalyze(snapshot.id));}catch(e){setError((e as Error).message);}finally{setBusy(false);}}
  return <section className="widget jev-panel" aria-label="Jev assistant">
    <div className="jev-heading"><h2>Jev assistant</h2><span className="jev-tag">On demand</span></div>
    <p className="muted">Understand an error, spot a waiting prompt, or choose your next check.</p>
    {localOnly && <div className="jev-notice">Local-only mode is on. <button className="btn" onClick={()=>void onLocalOnly(false).catch(e=>setError(e.message))}>Enable cloud assistance</button></div>}
    <button className="btn jev-primary" disabled={busy} onClick={()=>void preview()}>Preview recent output</button>
    {snapshot && <>
      <label className="jev-preview-label" htmlFor="jev-preview">Only this redacted excerpt will be sent to TypeSafe</label>
      <textarea id="jev-preview" className="jev-preview mono" value={snapshot.text} readOnly rows={7}/>
      <p className="muted">{snapshot.text.length.toLocaleString()} characters · {snapshot.redactions} redactions · {new Date(snapshot.capturedAt).toLocaleTimeString()}</p>
      {!snapshot.configured && <p role="alert">Jev key is not configured on this computer.</p>}
      <button className="btn jev-primary" disabled={busy||!!result||localOnly||!snapshot.configured||!snapshot.text.trim()} onClick={()=>void analyze()}>{busy?'Analyzing…':result?'Refresh preview for another reading':'Send shown output to Jev'}</button>
    </>}
    {error && <div role="alert" className="jev-error">{error}</div>}
    {result && <div className="jev-result" role="status">
      <strong>{result.uncertain?'Uncertain reading':JEV_STATUS[result.status]}</strong>
      <p>{result.uncertain?JEV_ACTIONS.inspect_more:JEV_ACTIONS[result.action]}</p>
      <p className="muted">Advisory reading of the snapshot; no commands executed.</p>
      <p className="muted">Jev usage is shown in tokens below; its charges are not included in Cost Kernel.</p>
      <details><summary>Analysis details</summary><p>{JEV_STATUS[result.status]} · confidence {(result.statusConfidence*100).toFixed(0)}%</p><p>Suggested step confidence {(result.actionConfidence*100).toFixed(0)}%</p><p>{result.model} · {result.inputTokens.toLocaleString()} input / {result.outputTokens.toLocaleString()} output tokens · {result.elapsedMs} ms{result.cached?' · reused result':''}</p></details>
    </div>}
  </section>;
}

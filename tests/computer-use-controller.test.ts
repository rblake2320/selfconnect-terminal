import {describe,it,expect,vi} from 'vitest';
import {mkdtempSync,writeFileSync,readFileSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {createHash,randomUUID} from 'node:crypto';
const fake=vi.hoisted(()=>({call:vi.fn(),bound:.1}));
vi.mock('../src/daemon/computer-use-model',()=>({ANTHROPIC_COMPUTER_USE_MODELS:{'claude-sonnet-5':{inputPerMillion:2,outputPerMillion:10}},AnthropicComputerUseAdapter:class{
 provider='anthropic';refusalReason(){return null;}estimateRequestCostUsd(){return fake.bound;}
 proposeActions(input:unknown){return fake.call(input);}
}}));
import {ComputerUseController} from '../src/daemon/computer-use';
const request={target:{hwnd:1,pid:1,exe:'fixture.exe',className:'fixture',title:'fixture'},objective:'test',maxActions:10,maxMinutes:5,executionMode:'desktop_assist',billingMode:'paid_api',paidConsent:{provider:'anthropic',model:'claude-sonnet-5',sessionCapUsd:2,taskCapUsd:.5,projectCapUsd:25,priceInputPerMillion:2,priceOutputPerMillion:10,acknowledgeSeparateBilling:true}};
async function setup(enabled=true){
 const dir=mkdtempSync(join(tmpdir(),'sct-controller-')),charges:number[]=[],events:unknown[]=[];let local=false;
 const file=join(dir,'billing.json');const ctl=new ComputerUseController('unused',dir,(type,payload)=>events.push({type,payload}),0,{enabled,apiKey:'fixture',billingFile:file,localOnly:()=>local,perCallCapUsd:.25,onCharge:c=>charges.push(c)});
 const s=await ctl.start(request);const bytes=Buffer.from('fixture pixels'),artifact='a'.repeat(32)+'.png';writeFileSync(join(dir,artifact),bytes);
 ctl.get(s.id).observation={id:randomUUID(),artifact,sha256:createHash('sha256').update(bytes).digest('hex'),width:10,height:10,capturedAt:Date.now()};
 return {ctl,id:s.id,obs:ctl.get(s.id).observation!.id,charges,events,file,local:()=>{local=true;}};
}
describe('desktop controller paid boundary (substituted adapter; no live API)',()=>{
 it('refuses paid sessions without explicit enablement',async()=>{fake.call.mockClear();await expect(setup(false)).rejects.toThrow('PAID_API_DISABLED');expect(fake.call).not.toHaveBeenCalled();});
 it('refuses understated price consent before any request',async()=>{const f=await setup();fake.call.mockClear();await expect(f.ctl.start({...request,paidConsent:{...request.paidConsent,priceInputPerMillion:.01}})).rejects.toThrow('disclose');expect(fake.call).not.toHaveBeenCalled();});
 it('reserves durable cost before calling adapter and settles measured usage',async()=>{const f=await setup();fake.call.mockImplementation(async()=>{expect(JSON.parse(readFileSync(f.file,'utf8')).entries[0].status).toBe('reserved');return {actions:[],usage:{inputTokens:2,outputTokens:3,estimatedCostUsd:.02}};});await f.ctl.propose(f.id,f.obs,.25);expect(f.charges).toEqual([.02]);expect(f.ctl.get(f.id).paidSpendUsd).toBe(.02);});
 it('rechecks local-only and screenshot freshness without calling adapter',async()=>{const f=await setup();fake.call.mockClear();await expect(f.ctl.propose(f.id,randomUUID(),.25)).rejects.toThrow('STALE');f.local();await expect(f.ctl.propose(f.id,f.obs,.25)).rejects.toThrow('PAID_API_DISABLED');expect(fake.call).not.toHaveBeenCalled();});
 it('charges ambiguous failures and blocks task-cap exhaustion',async()=>{const f=await setup();fake.call.mockRejectedValue(Error('network timeout'));for(let i=0;i<5;i++)await expect(f.ctl.propose(f.id,f.obs,.25)).rejects.toThrow('network timeout');await expect(f.ctl.propose(f.id,f.obs,.25)).rejects.toThrow('BUDGET_EXCEEDED');expect(f.charges.reduce((a,b)=>a+b,0)).toBe(.5);});
 it('stops subsequent requests after observed overrun',async()=>{const f=await setup();fake.call.mockResolvedValue({actions:[],usage:{inputTokens:1,outputTokens:1,estimatedCostUsd:.2}});await expect(f.ctl.propose(f.id,f.obs,.25)).rejects.toThrow('BUDGET_EXCEEDED');expect(f.ctl.get(f.id).status).toBe('BUDGET_EXCEEDED');expect(f.charges).toEqual([.2]);});
 it('discards proposals when stopped during request; retains billed usage',async()=>{const f=await setup();fake.call.mockImplementation(async()=>{f.ctl.stop(f.id);return {actions:[],usage:{inputTokens:1,outputTokens:1,estimatedCostUsd:.02}};});await expect(f.ctl.propose(f.id,f.obs,.25)).rejects.toThrow('stopped');expect(f.charges).toEqual([.02]);});
});

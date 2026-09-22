import {randomUUID,createHash} from 'node:crypto';
import {mkdirSync,readFileSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {z} from 'zod';
import {ComputerSessionRequestSchema,ComputerActionSchema,validateComputerAction,type ComputerAction,type ComputerSessionRequest} from '../shared/computer-use';
import {McpClient} from '../mcp/client';
import {StdioChannel} from '../mcp/stdio-channel';
import {AnthropicComputerUseAdapter,ANTHROPIC_COMPUTER_USE_MODELS} from './computer-use-model';
import {ComputerUseBilling} from './computer-use-billing';

const ObservationSchema=z.object({artifact:z.string().regex(/^[a-f0-9]{32}\.png$/),sha256:z.string().regex(/^[a-f0-9]{64}$/),width:z.number().int().positive().max(6000),height:z.number().int().positive().max(4000),capturedAt:z.number()}).strict();
export type DesktopObservation=z.infer<typeof ObservationSchema>&{id:string};
export type DesktopSession={id:string;request:ComputerSessionRequest;createdAt:number;expiresAt:number;sequence:number;status:string;observation:DesktopObservation|null;lastChanged:boolean|null;paidSpendUsd:number;noChangeCount:number};
export const ComputerToolInputSchema=z.discriminatedUnion('operation',[
 z.object({operation:z.literal('start'),request:ComputerSessionRequestSchema}).strict(),
 z.object({operation:z.literal('act'),action:ComputerActionSchema}).strict(),
 z.object({operation:z.literal('propose'),sessionId:z.string().uuid(),observationId:z.string().uuid(),maxChargeUsd:z.number().finite().positive().max(.25)}).strict(),
]);
export type DesktopPaidOptions={enabled:boolean;apiKey:string;billingFile:string;localOnly:()=>boolean;perCallCapUsd:number;onCharge:(cost:number,uncertain:boolean,usage?:{inputTokens:number;outputTokens:number})=>void};
type EventWriter=(phase:string,payload:unknown)=>void;
export class ComputerUseController{
 private sessions=new Map<string,DesktopSession>();
 private client:McpClient|undefined;
 private busy=false;
 constructor(private readonly driverFile:string,private readonly evidenceDir:string,private readonly audit:EventWriter,private readonly approvalWindow=0,private readonly paid?:DesktopPaidOptions){}
 private async driver(){
  if(!this.client){
   mkdirSync(this.evidenceDir,{recursive:true,mode:0o700});
   const client=new McpClient(new StdioChannel({command:'python',args:[this.driverFile],env:{SCT_COMPUTER_EVIDENCE:this.evidenceDir,SCT_APPROVAL_WINDOW:String(this.approvalWindow)}}),30000);
   try{await client.initialize();this.client=client;}catch(e){client.close();throw e;}
  }
  return this.client;
 }
 list(){return [...this.sessions.values()].map(s=>structuredClone(s));}
 get(id:string){const s=this.sessions.get(id);if(!s)throw Error('Unknown desktop session');return s;}
 async start(raw:unknown){
  const request=ComputerSessionRequestSchema.parse(raw);
  // A separate billing-enabled model path must authorize and reserve every request.
  if(request.billingMode==='paid_api'&&(!this.paid?.enabled||this.paid.localOnly()))throw Error('PAID_API_DISABLED: explicit configuration and cloud permission are required.');
  if(request.billingMode==='paid_api'){
   const consent=request.paidConsent!,price=ANTHROPIC_COMPUTER_USE_MODELS[consent.model];
   if(!price||consent.priceInputPerMillion<price.inputPerMillion||consent.priceOutputPerMillion<price.outputPerMillion)throw Error('Billing consent must name a supported model and disclose at least its configured list rates.');
   if(!this.paid?.apiKey)throw Error('No separately billed API key configured');
  }
  const now=Date.now(),id=randomUUID();
  const s:DesktopSession={id,request,createdAt:now,expiresAt:now+request.maxMinutes*60000,sequence:1,status:'ACTIVE',observation:null,lastChanged:null,paidSpendUsd:0,noChangeCount:0};
  this.sessions.set(id,s);this.audit('session.approved',{sessionId:id,target:request.target,executionMode:request.executionMode,billingMode:request.billingMode,maxActions:request.maxActions,expiresAt:s.expiresAt});
  return structuredClone(s);
 }
 stop(id:string){const s=this.get(id);s.status='STOPPED';mkdirSync(this.evidenceDir,{recursive:true,mode:0o700});writeFileSync(join(this.evidenceDir,'stop-'+createHash('sha256').update(id).digest('hex')),'stopped');this.audit('session.terminated',{sessionId:id,reason:'operator stop'});return structuredClone(s);}
 private valid(s:DesktopSession,action:ComputerAction){
  if(s.status!=='ACTIVE')throw Error(`Session ${s.status}`);
  if(Date.now()>s.expiresAt){s.status='EXPIRED';throw Error('Session expired');}
  const verdict=validateComputerAction(action,{sessionId:s.id,expectedSequence:s.sequence,latestObservationId:s.observation?.id??null,width:s.observation?.width??0,height:s.observation?.height??0,maxActions:s.request.maxActions});
  if(!verdict.ok)throw Error(verdict.reason);
  if(action.type!=='observe'&&s.observation&&Date.now()-s.observation.capturedAt>60000)throw Error('STALE_OBSERVATION: observe again before acting');
 }
 async act(raw:unknown){
  const action=ComputerActionSchema.parse(raw),s=this.get(action.sessionId);this.valid(s,action);
  if(this.busy)throw Error('Another desktop action is in progress');
  this.busy=true;
  try{
   const client=await this.driver();this.valid(s,action);
   this.audit('action.validated',{sessionId:s.id,sequence:action.sequence,type:action.type,observationId:action.observationId,actionHash:createHash('sha256').update(JSON.stringify(action)).digest('hex')});
   const result=z.object({executed:z.literal(true),before:ObservationSchema,observation:ObservationSchema,stateChanged:z.boolean(),foreground:z.boolean()}).strict().parse(JSON.parse(await client.callTool('computer_step',{target:s.request.target,action,expected_observation:s.observation?{width:s.observation.width,height:s.observation.height}:null})));
   if(s.status==='STOPPED')throw Error('STOPPED: inspect the target for any partial action');
   const observation={...result.observation,id:randomUUID()};
   const pixels=readFileSync(join(this.evidenceDir,observation.artifact));
   if(createHash('sha256').update(pixels).digest('hex')!==observation.sha256)throw Error('Observation artifact hash mismatch');
   s.observation=observation;s.lastChanged=result.stateChanged;s.sequence++;
   if(['click','type','keypress','scroll'].includes(action.type)){s.noChangeCount=result.stateChanged?0:s.noChangeCount+1;if(s.noChangeCount>=3)s.status='NO_STATE_CHANGE';}
   if(action.type==='finish')s.status='COMPLETED';
   this.audit('action.executed',{sessionId:s.id,sequence:action.sequence,type:action.type,executed:true});
   this.audit('observation.captured',{sessionId:s.id,observation});
   this.audit('state.verified',{sessionId:s.id,changed:result.stateChanged,verification:'pixel hash difference only',foreground:result.foreground,status:s.status});
   return structuredClone(s);
  }catch(e){
   const reason=(e as Error).message;
   if(!reason.includes('STALE_OBSERVATION')){
    s.status=reason.includes('WINDOW_LOST')?'WINDOW_LOST':s.status==='STOPPED'?'STOPPED':'FAILED';
    mkdirSync(this.evidenceDir,{recursive:true,mode:0o700});
    writeFileSync(join(this.evidenceDir,'stop-'+createHash('sha256').update(s.id).digest('hex')),'failed; inspect any partial action');
   }
   this.audit('session.terminated',{sessionId:s.id,reason,status:s.status});throw e;
  }finally{this.busy=false;}
 }
 image(id:string){const s=this.get(id);if(!s.observation)throw Error('No observation');const bytes=readFileSync(join(this.evidenceDir,s.observation.artifact));if(bytes.length>8*1024*1024)throw Error('Image too large');return 'data:image/png;base64,'+bytes.toString('base64');}
 async propose(id:string,observationId:string,maxChargeUsd:number){
  const s=this.get(id),p=this.paid,c=s.request.paidConsent;
  if(!p?.enabled||p.localOnly()||s.request.billingMode!=='paid_api'||!c)throw Error('PAID_API_DISABLED: no separately billed request authorized.');
  if(this.busy)throw Error('Another desktop operation is in progress');
  if(s.status!=='ACTIVE'||Date.now()>s.expiresAt)throw Error('Session is not active');
  if(!s.observation||s.observation.id!==observationId||Date.now()-s.observation.capturedAt>60000)throw Error('STALE_OBSERVATION: observe again');
  if(!Number.isFinite(maxChargeUsd)||maxChargeUsd<=0||maxChargeUsd>Math.min(.25,p.perCallCapUsd))throw Error('Invalid per-request cap');
  const turns=this.modelTurns.get(id)??0;if(turns>=30)throw Error('MAX_TURNS_REACHED');
  const billing=new ComputerUseBilling(p.billingFile),snapshot=billing.snapshot(id);
  const adapter=new AnthropicComputerUseAdapter({enabled:p.enabled,apiKey:p.apiKey,model:c.model,consent:c,localOnly:p.localOnly});
  const bytes=readFileSync(join(this.evidenceDir,s.observation.artifact));
  if(bytes.length>8*1024*1024||createHash('sha256').update(bytes).digest('hex')!==s.observation.sha256)throw Error('Observation artifact changed');
  const input={objective:s.request.objective,observation:{screenshotBase64:bytes.toString('base64'),width:s.observation.width,height:s.observation.height},history:[],allowedActions:['observe','click','type','keypress','scroll','wait','finish'],remainingActions:s.request.maxActions-s.sequence+1,remainingSpendUsd:Math.min(maxChargeUsd,c.taskCapUsd-snapshot.sessionCommittedUsd,c.sessionCapUsd-snapshot.sessionCommittedUsd,c.projectCapUsd-snapshot.projectCommittedUsd),session:{sessionId:id,nextSequence:s.sequence,observationId}};
  const refusal=adapter.refusalReason(input);if(refusal)throw Error(refusal);
  const reservation=adapter.estimateRequestCostUsd(input);
  if(!Number.isFinite(reservation)||reservation<=0||reservation>maxChargeUsd)throw Error('BUDGET_EXCEEDED: reservation exceeds approved request cap.');
  this.busy=true;let receipt:string|undefined;
  try{
   receipt=billing.reserve(id,reservation,{projectCapUsd:c.projectCapUsd,sessionCapUsd:c.sessionCapUsd,taskCapUsd:c.taskCapUsd});s.paidSpendUsd=billing.snapshot(id).sessionCommittedUsd;
   this.audit('model.requested',{sessionId:id,provider:adapter.provider,model:c.model,observationId,reservedUsd:reservation,cumulativeCommittedUsd:s.paidSpendUsd,usageKnown:false});
   this.modelTurns.set(id,turns+1);
   const result=await adapter.proposeActions(input);
   const settlement=billing.settle(receipt,result.usage.estimatedCostUsd);receipt=undefined;
   p.onCharge(result.usage.estimatedCostUsd,false,result.usage);s.paidSpendUsd=billing.snapshot(id).sessionCommittedUsd;
   this.audit('model.result',{sessionId:id,model:c.model,usage:result.usage,cumulativeCommittedUsd:s.paidSpendUsd,stopReason:result.stopReason});
   if(settlement.breached){s.status='BUDGET_EXCEEDED';throw Error('BUDGET_EXCEEDED: actual usage exceeded reservation; further calls locked.');}
   if(s.status!=='ACTIVE'||Date.now()>s.expiresAt)throw Error('Session stopped or expired during model request; proposal discarded.');
   // A fresh observation follows every execution. Only the first proposal is
   // actionable; never execute an unobserved remainder of a model batch.
   const proposed=result.actions[0];if(proposed){const parsed=ComputerActionSchema.parse(proposed);this.valid(s,parsed);}
   return {session:structuredClone(s),action:proposed??null,stopReason:result.stopReason,usage:result.usage};
  }catch(e){if(receipt){billing.uncertain(receipt);s.paidSpendUsd=billing.snapshot(id).sessionCommittedUsd;p.onCharge(reservation,true);this.audit('model.result',{sessionId:id,outcome:'unknown',reservedUsd:reservation,cumulativeCommittedUsd:s.paidSpendUsd});}throw e;}finally{this.busy=false;}
 }
 private modelTurns=new Map<string,number>();
 close(){for(const s of this.sessions.values())if(s.status==='ACTIVE')this.stop(s.id);this.client?.close();this.client=undefined;}
}

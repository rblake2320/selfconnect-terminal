import {randomUUID} from 'node:crypto';
import {closeSync,existsSync,fsyncSync,mkdirSync,openSync,readFileSync,renameSync,unlinkSync,writeFileSync} from 'node:fs';
import {dirname} from 'node:path';
import {z} from 'zod';
const Money=z.number().finite().nonnegative();
const Entry=z.object({id:z.string(),sessionId:z.string(),reservedUsd:Money,chargedUsd:Money,status:z.enum(['reserved','settled','unknown']),at:z.number()}).strict();
const Store=z.object({version:z.literal(1),breached:z.boolean(),entries:z.array(Entry)}).strict();
type State=z.infer<typeof Store>;
export type BillingCaps={projectCapUsd:number;sessionCapUsd:number;taskCapUsd:number};
/** Cross-process, durable pre-request reservations. An ambiguous failed request
 * keeps its entire reserved amount; crash/restart never resets the project spend.
 * A stale lock fails closed and requires reconciliation, not automatic deletion.
 */
export class ComputerUseBilling{
 constructor(readonly file:string){}
 private read():State {return existsSync(this.file)?Store.parse(JSON.parse(readFileSync(this.file,'utf8'))):{version:1,breached:false,entries:[]};}
 private edit<T>(fn:(state:State)=>T):T{
  mkdirSync(dirname(this.file),{recursive:true,mode:0o700});let fd:number;
  try{fd=openSync(this.file+'.lock','wx',0o600);}catch{throw Error('Billing state is locked; reconcile any interrupted writer before proceeding.');}
  try{
   const state=this.read(),result=fn(state);const tmp=this.file+'.'+randomUUID()+'.tmp';const data=openSync(tmp,'wx',0o600);
   try{writeFileSync(data,JSON.stringify(state));fsyncSync(data);}finally{closeSync(data);}renameSync(tmp,this.file);return result;
  }finally{closeSync(fd);unlinkSync(this.file+'.lock');}
 }
 snapshot(sessionId?:string){const s=this.read();return {projectCommittedUsd:s.entries.reduce((a,e)=>a+e.chargedUsd,0),sessionCommittedUsd:s.entries.filter(e=>e.sessionId===sessionId).reduce((a,e)=>a+e.chargedUsd,0),uncertainRequests:s.entries.filter(e=>e.status!=='settled').length,breached:s.breached};}
 reserve(sessionId:string,upperBoundUsd:number,caps:BillingCaps):string{
  z.object({projectCapUsd:Money.gt(0).max(25),sessionCapUsd:Money.gt(0).max(2),taskCapUsd:Money.gt(0).max(.5)}).strict().parse(caps);Money.gt(0).parse(upperBoundUsd);
  return this.edit(s=>{
   if(s.breached)throw Error('BUDGET_EXCEEDED: observed usage exceeded a reservation; billing is locked.');
   const project=s.entries.reduce((a,e)=>a+e.chargedUsd,0),session=s.entries.filter(e=>e.sessionId===sessionId).reduce((a,e)=>a+e.chargedUsd,0);
   if(project+upperBoundUsd>caps.projectCapUsd||session+upperBoundUsd>caps.sessionCapUsd||session+upperBoundUsd>caps.taskCapUsd)throw Error('BUDGET_EXCEEDED: no request sent.');
   const id=randomUUID();s.entries.push({id,sessionId,reservedUsd:upperBoundUsd,chargedUsd:upperBoundUsd,status:'reserved',at:Date.now()});return id;
  });
 }
 settle(id:string,costUsd:number){Money.parse(costUsd);return this.edit(s=>{const e=s.entries.find(e=>e.id===id);if(!e||e.status!=='reserved')throw Error('Unknown or finalized billing reservation');e.status='settled';e.chargedUsd=costUsd;if(costUsd>e.reservedUsd+1e-9)s.breached=true;return {breached:s.breached};});}
 uncertain(id:string){return this.edit(s=>{const e=s.entries.find(e=>e.id===id);if(e?.status==='reserved')e.status='unknown';});}
}

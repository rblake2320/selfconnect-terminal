import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {z} from 'zod';
import type {NativeMeshState,NativePeer} from '../src/shared/native-mesh';
const exec=promisify(execFile);
const windowSchema=z.object({hwnd:z.number().int(),pid:z.number().int(),title:z.string(),exe_name:z.string(),class_name:z.string()});
const peerSchema=windowSchema.extend({role:z.string(),birth_id:z.string(),status:z.string()});
async function python(args:string[]):Promise<unknown>{
 try{const r=await exec('python',args,{windowsHide:true,timeout:10000,maxBuffer:1024*1024});return JSON.parse(r.stdout);}
 catch{throw new Error('SelfConnect Core is unavailable. Install its Python package and check python -m sc_cli doctor --json.');}
}
export async function nativeMeshState(self:NativeMeshState['self'],join=false):Promise<NativeMeshState>{
 const registry=z.object({agents:z.array(peerSchema)}).parse(await python(['-m','sc_mesh_registry','list','--json']));
 const windows=z.array(windowSchema).parse(await python(['-m','sc_cli','windows','--json','--limit','1000']));
 const peers:NativePeer[]=registry.agents.flatMap(p=>{
  const live=windows.find(w=>w.hwnd===p.hwnd&&w.pid===p.pid&&w.exe_name.toLowerCase()===p.exe_name.toLowerCase()&&w.class_name===p.class_name);
  return live?[{role:p.role,birthId:p.birth_id,hwnd:p.hwnd,pid:p.pid,title:live.title,exe:live.exe_name,className:live.class_name,status:p.status}]:[];
 });
 const registered=peers.some(p=>p.hwnd===self.hwnd&&p.pid===self.pid);
 if(join&&!registered){
  const live=windows.find(w=>w.hwnd===self.hwnd&&w.pid===self.pid);
  if(!live)throw new Error('This terminal window could not be found by SelfConnect Core.');
  const result=z.object({ok:z.boolean()}).parse(await python(['-m','sc_mesh_registry','register','--role',`sct-window-${self.pid}-${self.hwnd}`,'--hwnd',String(self.hwnd),'--agent','terminal','--profile','explore','--task','User-connected SelfConnect Terminal','--expect-pid',String(self.pid),'--expect-exe',live.exe_name,'--expect-class',live.class_name,'--expect-title',live.title,'--allow-non-terminal']));
  if(!result.ok)throw new Error('SelfConnect Core refused this window registration.');
  return nativeMeshState(self);
 }
 return {self,peers,registered,observedAt:Date.now()};
}

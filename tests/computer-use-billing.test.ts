import {describe,it,expect} from 'vitest';
import {mkdtempSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {ComputerUseBilling} from '../src/daemon/computer-use-billing';
const caps={projectCapUsd:1,sessionCapUsd:.5,taskCapUsd:.5};
function file(){return join(mkdtempSync(join(tmpdir(),'sct-billing-')),'budget.json');}
describe('durable desktop paid-call reservations',()=>{
 it('reserves before execution, persists across instances and refuses overspend',()=>{const f=file(),a=new ComputerUseBilling(f);a.reserve('s',.3,caps);const b=new ComputerUseBilling(f);expect(()=>b.reserve('s',.3,caps)).toThrow('BUDGET_EXCEEDED');expect(b.snapshot('s').sessionCommittedUsd).toBe(.3);});
 it('unknown outcomes remain charged at reservation rather than becoming free retries',()=>{const a=new ComputerUseBilling(file()),id=a.reserve('s',.4,caps);a.uncertain(id);expect(()=>a.reserve('s',.2,caps)).toThrow();expect(a.snapshot('s').uncertainRequests).toBe(1);});
 it('settles verified usage and never settles twice',()=>{const a=new ComputerUseBilling(file()),id=a.reserve('s',.4,caps);a.settle(id,.1);expect(a.snapshot('s').sessionCommittedUsd).toBe(.1);expect(()=>a.settle(id,0)).toThrow();});
 it('locks all later calls if actual usage exceeds the conservative reservation',()=>{const a=new ComputerUseBilling(file()),id=a.reserve('s',.1,caps);expect(a.settle(id,.2).breached).toBe(true);expect(()=>a.reserve('new',.1,caps)).toThrow('BUDGET_EXCEEDED');});
 it('rejects NaN, negative and unbounded limits',()=>{const a=new ComputerUseBilling(file());expect(()=>a.reserve('s',NaN,caps)).toThrow();expect(()=>a.reserve('s',-.2,caps)).toThrow();expect(()=>a.reserve('s',.1,{...caps,projectCapUsd:26})).toThrow();});
 it('corruption and interrupted writer lock fail closed',()=>{const f=file(),a=new ComputerUseBilling(f);writeFileSync(f,'broken');expect(()=>a.reserve('s',.1,caps)).toThrow();writeFileSync(f+'.lock','held');expect(()=>a.reserve('s',.1,caps)).toThrow('locked');});
});

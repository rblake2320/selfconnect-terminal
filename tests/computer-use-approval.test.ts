import {it,expect} from 'vitest';
import {mkdtempSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {Daemon} from '../src/daemon/daemon';
import {loadConfig} from '../src/daemon/config';

it('the real approval state discloses paid desktop request cost instead of showing $0',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'sct-billing-approval-')),cfg=loadConfig({APPDATA:dir});
 for(const key of Object.keys(cfg))if(/(Path|Dir|File)$/.test(key))(cfg as unknown as Record<string,unknown>)[key]=join(dir,key);
 cfg.a2aMode='off';const daemon=new Daemon(cfg,dir);daemon.setPermissionMode('auto');
 const pending=daemon.computerInvoke({operation:'propose',sessionId:randomUUID(),observationId:randomUUID(),maxChargeUsd:.25});
 const approval=daemon.approvals.list()[0];
 expect(approval.estimatedCostUsd).toBe(.25);expect(approval.provider).toBe('anthropic');
 expect(approval.preview?.summary).toContain('SEPARATE API BILL');
 daemon.approvals.decide(approval.id,false);
 expect((await pending).blocked).toBe(true);
 expect(daemon.ledger.all().filter(e=>e.type==='computer_use.model.requested')).toHaveLength(0);
});

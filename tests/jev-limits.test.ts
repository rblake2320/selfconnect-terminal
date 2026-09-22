import {describe,it,expect} from 'vitest';
import {JevAssistant,cleanJevText,jevHash} from '../src/daemon/jev';
describe('Jev network and preview bounds',()=>{
 it('rejects a streaming response over 64 KiB',async()=>{
  const client=new JevAssistant({apiKey:'unit-only-private-key',keyFile:'',model:'jev-test',timeoutMs:1000},async()=>new Response('x'.repeat(65537)));
  await expect(client.analyze({id:'test',sessionId:'test',capturedAt:Date.now(),text:'error',hash:jevHash('error'),redactions:0,configured:true},()=>true)).rejects.toThrow('oversized');
 });
 it('makes ConPTY blank repaint padding visible without losing the latest diagnostic',()=>{
  const clean=cleanJevText('\n'.repeat(300)+'Error: missing file\nPS C:\\work>');
  expect(clean.text.startsWith('Error: missing file')).toBe(true);
  expect(clean.text.length).toBeLessThan(8001);
 });
});

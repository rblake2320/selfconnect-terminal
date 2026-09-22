import {describe,it,expect} from 'vitest';
import {McpClient} from '../src/mcp/client';
import {StdioChannel} from '../src/mcp/stdio-channel';
import {loadMcpConfig} from '../src/mcp/config';
import {mkdtempSync,writeFileSync,rmSync} from 'node:fs';
import {join} from 'node:path';import {tmpdir} from 'node:os';
describe('real MCP subprocess fault barriers',()=>{
 it('missing executable rejects without crashing the parent',async()=>{
  const c=new McpClient(new StdioChannel({command:'sct_missing_mcp_executable_20260922'}));
  try{await expect(c.initialize()).rejects.toThrow(/could not start/);}finally{c.close();}
 });
 it('silent live subprocess times out within the configured bound',async()=>{
  const c=new McpClient(new StdioChannel({command:process.execPath,args:['-e','process.stdin.resume();setInterval(()=>{},1000)']}),100);
  try{await expect(c.initialize()).rejects.toThrow(/timed out/);}finally{c.close();}
 });
 it('honors initialized notification and rejects real tool isError results',async()=>{
  const js=`let ready=false;require('readline').createInterface({input:process.stdin}).on('line',l=>{const m=JSON.parse(l);if(m.method==='notifications/initialized'){ready=true;return;}const result=m.method==='initialize'?{protocolVersion:'2024-11-05',capabilities:{tools:{}}}:m.method==='tools/list'?{tools:ready?[{name:'bad',description:'failure',inputSchema:{type:'object'}}]:[]}:{isError:true,content:[{type:'text',text:'actual tool failure'}]};process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:m.id,result})+'\\n');});`;
  const c=new McpClient(new StdioChannel({command:process.execPath,args:['-e',js]}));
  try{await c.initialize();expect(await c.listTools()).toHaveLength(1);await expect(c.callTool('bad',{})).rejects.toThrow('actual tool failure');}finally{c.close();}
 });
 it('reports malformed configuration instead of pretending there are no servers',()=>{
  const dir=mkdtempSync(join(tmpdir(),'sct-mcp-config-'));try{const file=join(dir,'mcp.json');writeFileSync(file,'{bad');expect(()=>loadMcpConfig(file)).toThrow(/Invalid MCP configuration/);}finally{rmSync(dir,{recursive:true,force:true});}
 });
});

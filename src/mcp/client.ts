import {
  JsonRpcResponseSchema,
  encode,
  type RpcChannel,
} from './protocol';
import type { McpTool } from '../shared/contracts';

/**
 * MCP CLIENT: JSON-RPC 2.0 over a newline-delimited channel (stdio to a child
 * process in production, or a paired in-memory channel in tests). The daemon
 * wraps callTool() with policy gating + redaction + audit; this class is the
 * pure protocol client.
 */
export class McpClient {
  private nextId = 1;
  private pending = new Map<number | string, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
  private buffer = '';

  constructor(private readonly channel: RpcChannel, private readonly timeoutMs = 15000) {
    channel.onMessage((line) => this.onLine(line));
    channel.onError?.(error=>{for(const p of this.pending.values())p.reject(error);this.pending.clear();});
  }

  private onLine(chunk: string): void {
    this.buffer += chunk;
    let idx: number;
    while ((idx = this.buffer.indexOf('\n')) >= 0) {
      const line = this.buffer.slice(0, idx).trim();
      this.buffer = this.buffer.slice(idx + 1);
      if (!line) continue;
      this.dispatch(line);
    }
    // A frame may have arrived without a trailing newline (paired channel).
    if (this.buffer.trim()) {
      const maybe = this.buffer.trim();
      try {
        JSON.parse(maybe);
        this.buffer = '';
        this.dispatch(maybe);
      } catch {
        // wait for more
      }
    }
  }

  private dispatch(line: string): void {
    let res;
    try {
      res = JsonRpcResponseSchema.parse(JSON.parse(line));
    } catch {
      return;
    }
    const p = this.pending.get(res.id);
    if (!p) return;
    this.pending.delete(res.id);
    if (res.error) p.reject(new Error(res.error.message));
    else p.resolve(res.result);
  }

  private request<T>(method: string, params?: unknown): Promise<T> {
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      const timer=setTimeout(()=>{this.pending.delete(id);reject(new Error(`MCP ${method} timed out after ${this.timeoutMs}ms`));},this.timeoutMs);
      this.pending.set(id, { resolve: value=>{clearTimeout(timer);resolve(value as T);}, reject:error=>{clearTimeout(timer);reject(error);} });
      try{this.channel.send(encode({ jsonrpc: '2.0', id, method, params }));}
      catch(error){this.pending.delete(id);clearTimeout(timer);reject(error);}
    });
  }

  async initialize(): Promise<unknown> {
    const result=await this.request('initialize', {
      protocolVersion: '2024-11-05',
      clientInfo: { name: 'selfconnect-client', version: '2.0.0' },
      capabilities: {},
    });
    this.channel.send(JSON.stringify({jsonrpc:'2.0',method:'notifications/initialized'})+'\n');
    return result;
  }

  async listTools(): Promise<McpTool[]> {
    const res = await this.request<{ tools: McpTool[] }>('tools/list');
    if(!res||!Array.isArray(res.tools))throw new Error('MCP returned an invalid tools list.');
    return res.tools;
  }

  async callTool(name: string, args: unknown): Promise<string> {
    const res = await this.request<{ isError?:boolean;content?: { type: string; text?: string }[] }>('tools/call', {
      name,
      arguments: args,
    });
    const parts = res?.content ?? [];
    if(res?.isError)throw new Error(parts.map(p=>p.text??'').join('')||'MCP tool reported an error.');
    return parts.map((p) => p.text ?? '').join('');
  }

  close(): void {
    for(const p of this.pending.values())p.reject(new Error('MCP client closed.'));
    this.pending.clear();
    this.channel.close();
  }
}

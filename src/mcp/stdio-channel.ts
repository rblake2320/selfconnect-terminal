import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import type { RpcChannel } from './protocol';
import type { McpServerConfig } from './config';

/**
 * Spawns a child MCP server process and exposes its stdio as an RpcChannel
 * (newline-delimited JSON-RPC). Used by the daemon MCP client in production.
 */
export class StdioChannel implements RpcChannel {
  private child: ChildProcessWithoutNullStreams;
  private handlers: ((line: string) => void)[] = [];
  private errors: ((error: Error) => void)[] = [];
  private failure: Error | null = null;

  constructor(cfg: McpServerConfig) {
    this.child = spawn(cfg.command, cfg.args ?? [], {
      env: { ...process.env, ...(cfg.env ?? {}) },
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    });
    const fail=(message:string)=>{if(this.failure)return;this.failure=new Error(message);for(const h of this.errors)h(this.failure);};
    this.child.on('error',()=>fail('MCP server process could not start. Check its command and configuration.'));
    this.child.on('exit',(code)=>fail(`MCP server exited (${code}).`));
    this.child.stdin.on('error',()=>fail('MCP server input pipe closed.'));
    this.child.stderr.resume();
    let buf = '';
    this.child.stdout.setEncoding('utf8');
    this.child.stdout.on('data', (chunk: string) => {
      buf += chunk;
      if(buf.length>1024*1024){fail('MCP server response exceeded 1 MiB.');this.child.kill();return;}
      let idx: number;
      while ((idx = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, idx);
        buf = buf.slice(idx + 1);
        if (line.trim()) this.handlers.forEach((h) => h(line + '\n'));
      }
    });
  }

  send(line: string): void {
    if(this.failure)throw this.failure;
    this.child.stdin.write(line.endsWith('\n') ? line : line + '\n');
  }

  onMessage(handler: (line: string) => void): void {
    this.handlers.push(handler);
  }
  onError(handler: (error:Error)=>void): void { this.errors.push(handler);if(this.failure)handler(this.failure); }

  close(): void {
    try {
      this.child.kill();
    } catch {
      // already gone
    }
  }
}

/** Build a channel over the current process's own stdin/stdout (server mode). */
export function processStdioChannel(): RpcChannel {
  const handlers: ((line: string) => void)[] = [];
  let buf = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (chunk: string) => {
    buf += chunk;
    let idx: number;
    while ((idx = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, idx);
      buf = buf.slice(idx + 1);
      if (line.trim()) handlers.forEach((h) => h(line + '\n'));
    }
  });
  return {
    send: (line) => process.stdout.write(line.endsWith('\n') ? line : line + '\n'),
    onMessage: (h) => handlers.push(h),
    close: () => {},
  };
}

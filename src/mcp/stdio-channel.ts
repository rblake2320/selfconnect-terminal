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

  constructor(cfg: McpServerConfig) {
    this.child = spawn(cfg.command, cfg.args ?? [], {
      env: { ...process.env, ...(cfg.env ?? {}) },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let buf = '';
    this.child.stdout.setEncoding('utf8');
    this.child.stdout.on('data', (chunk: string) => {
      buf += chunk;
      let idx: number;
      while ((idx = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, idx);
        buf = buf.slice(idx + 1);
        if (line.trim()) this.handlers.forEach((h) => h(line + '\n'));
      }
    });
  }

  send(line: string): void {
    this.child.stdin.write(line.endsWith('\n') ? line : line + '\n');
  }

  onMessage(handler: (line: string) => void): void {
    this.handlers.push(handler);
  }

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

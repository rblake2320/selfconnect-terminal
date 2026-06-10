import { z } from 'zod';
import type { McpTool } from '../shared/contracts';
import {
  JsonRpcRequestSchema,
  encode,
  type JsonRpcResponse,
  type RpcChannel,
} from './protocol';

/**
 * MCP SERVER mode: exposes SelfConnect as a read-only MCP server over a
 * newline-delimited JSON-RPC channel (stdio in production via the CLI). The
 * server NEVER executes shell commands — only read-only governance tools.
 */

export interface McpServerHandlers {
  ledgerVerify(): Promise<string> | string;
  ledgerQuery(args: { sessionId?: string; type?: string; limit?: number }): Promise<string> | string;
  sessionList(): Promise<string> | string;
  costReport(): Promise<string> | string;
  redactText(text: string): Promise<string> | string;
  reviewRequest(mode: string): Promise<string> | string;
}

const TOOLS: McpTool[] = [
  { name: 'ledger_verify', description: 'Verify the audit ledger hash chain.', inputSchema: { type: 'object', properties: {} } },
  {
    name: 'ledger_query',
    description: 'Query ledger entries by sessionId/type/limit.',
    inputSchema: {
      type: 'object',
      properties: { sessionId: { type: 'string' }, type: { type: 'string' }, limit: { type: 'number' } },
    },
  },
  { name: 'session_list', description: 'List past sessions.', inputSchema: { type: 'object', properties: {} } },
  { name: 'cost_report', description: 'Report session and avoided spend.', inputSchema: { type: 'object', properties: {} } },
  {
    name: 'redact_text',
    description: 'Redact secrets from text.',
    inputSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] },
  },
  {
    name: 'review_request',
    description: 'Run a read-only governed review.',
    inputSchema: { type: 'object', properties: { mode: { type: 'string' } }, required: ['mode'] },
  },
];

const CallParams = z.object({ name: z.string(), arguments: z.unknown().optional() });

export class McpServer {
  constructor(
    private readonly channel: RpcChannel,
    private readonly handlers: McpServerHandlers,
  ) {
    channel.onMessage((line) => void this.handle(line));
  }

  static toolList(): McpTool[] {
    return TOOLS.slice();
  }

  private reply(id: JsonRpcResponse['id'], result: unknown): void {
    this.channel.send(encode({ jsonrpc: '2.0', id, result }));
  }

  private fail(id: JsonRpcResponse['id'], code: number, message: string): void {
    this.channel.send(encode({ jsonrpc: '2.0', id, error: { code, message } }));
  }

  private async handle(line: string): Promise<void> {
    const trimmed = line.trim();
    if (!trimmed) return;
    let req;
    try {
      req = JsonRpcRequestSchema.parse(JSON.parse(trimmed));
    } catch {
      return; // ignore malformed
    }
    try {
      switch (req.method) {
        case 'initialize':
          this.reply(req.id, {
            protocolVersion: '2024-11-05',
            serverInfo: { name: 'selfconnect', version: '2.0.0' },
            capabilities: { tools: {} },
          });
          return;
        case 'tools/list':
          this.reply(req.id, { tools: TOOLS });
          return;
        case 'tools/call': {
          const { name, arguments: args } = CallParams.parse(req.params);
          const text = await this.dispatch(name, args ?? {});
          this.reply(req.id, { content: [{ type: 'text', text }] });
          return;
        }
        default:
          this.fail(req.id, -32601, `method not found: ${req.method}`);
      }
    } catch (err) {
      this.fail(req.id, -32603, err instanceof Error ? err.message : String(err));
    }
  }

  private async dispatch(name: string, args: unknown): Promise<string> {
    const a = (args ?? {}) as Record<string, unknown>;
    switch (name) {
      case 'ledger_verify':
        return String(await this.handlers.ledgerVerify());
      case 'ledger_query':
        return String(
          await this.handlers.ledgerQuery({
            sessionId: a.sessionId as string | undefined,
            type: a.type as string | undefined,
            limit: a.limit as number | undefined,
          }),
        );
      case 'session_list':
        return String(await this.handlers.sessionList());
      case 'cost_report':
        return String(await this.handlers.costReport());
      case 'redact_text':
        return String(await this.handlers.redactText(String(a.text ?? '')));
      case 'review_request':
        return String(await this.handlers.reviewRequest(String(a.mode ?? 'full')));
      default:
        throw new Error(`unknown tool: ${name}`);
    }
  }
}

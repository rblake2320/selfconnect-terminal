import { z } from 'zod';

/**
 * Minimal hand-rolled JSON-RPC 2.0 with newline-delimited framing. Both the
 * MCP client and server use this. Messages are Zod-validated at the boundary.
 */

export const JsonRpcRequestSchema = z.object({
  jsonrpc: z.literal('2.0'),
  id: z.union([z.number(), z.string()]),
  method: z.string(),
  params: z.unknown().optional(),
});
export type JsonRpcRequest = z.infer<typeof JsonRpcRequestSchema>;

export const JsonRpcResponseSchema = z.object({
  jsonrpc: z.literal('2.0'),
  id: z.union([z.number(), z.string()]),
  result: z.unknown().optional(),
  error: z
    .object({ code: z.number(), message: z.string(), data: z.unknown().optional() })
    .optional(),
});
export type JsonRpcResponse = z.infer<typeof JsonRpcResponseSchema>;

/** A bidirectional newline-delimited message channel. */
export interface RpcChannel {
  send(line: string): void;
  onMessage(handler: (line: string) => void): void;
  close(): void;
}

/** In-memory paired channels for in-process client<->server tests. */
export function createPairedChannels(): { a: RpcChannel; b: RpcChannel } {
  const aHandlers: ((line: string) => void)[] = [];
  const bHandlers: ((line: string) => void)[] = [];
  const a: RpcChannel = {
    send: (line) => queueMicrotask(() => bHandlers.forEach((h) => h(line))),
    onMessage: (h) => aHandlers.push(h),
    close: () => {},
  };
  const b: RpcChannel = {
    send: (line) => queueMicrotask(() => aHandlers.forEach((h) => h(line))),
    onMessage: (h) => bHandlers.push(h),
    close: () => {},
  };
  return { a, b };
}

export function encode(msg: JsonRpcRequest | JsonRpcResponse): string {
  return JSON.stringify(msg) + '\n';
}

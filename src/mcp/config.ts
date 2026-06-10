import { existsSync, readFileSync } from 'node:fs';
import { z } from 'zod';

/** mcp-servers.json: { servers: { name: { command, args?, env? } } } */
export const McpServerConfigSchema = z.object({
  command: z.string(),
  args: z.array(z.string()).optional(),
  env: z.record(z.string()).optional(),
});
export type McpServerConfig = z.infer<typeof McpServerConfigSchema>;

export const McpServersFileSchema = z.object({
  servers: z.record(McpServerConfigSchema),
});
export type McpServersFile = z.infer<typeof McpServersFileSchema>;

export function loadMcpConfig(path: string): McpServersFile {
  if (!existsSync(path)) return { servers: {} };
  try {
    return McpServersFileSchema.parse(JSON.parse(readFileSync(path, 'utf8')));
  } catch {
    return { servers: {} };
  }
}

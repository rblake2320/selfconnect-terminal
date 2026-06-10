import type { McpTool } from '../shared/contracts';
import { McpClient } from '../mcp/client';
import { loadMcpConfig, type McpServersFile } from '../mcp/config';
import { StdioChannel } from '../mcp/stdio-channel';
import { redact } from './redactor';

/**
 * Daemon-side MCP client manager. Loads mcp-servers.json, lazily spawns server
 * child processes, and exposes list/call. Governance (redaction of outbound
 * args, approval gating, ledger audit) is applied here / by the daemon caller.
 */
export class McpManager {
  private config: McpServersFile;
  private clients = new Map<string, McpClient>();

  constructor(configPath: string) {
    this.config = loadMcpConfig(configPath);
  }

  /** For tests: register a pre-built client over a paired channel. */
  registerClient(name: string, client: McpClient): void {
    this.clients.set(name, client);
  }

  serverNames(): string[] {
    return Object.keys(this.config.servers);
  }

  private async client(server: string): Promise<McpClient> {
    const existing = this.clients.get(server);
    if (existing) return existing;
    const cfg = this.config.servers[server];
    if (!cfg) throw new Error(`unknown MCP server: ${server}`);
    const client = new McpClient(new StdioChannel(cfg));
    await client.initialize();
    this.clients.set(server, client);
    return client;
  }

  async listTools(server: string): Promise<McpTool[]> {
    const c = await this.client(server);
    return c.listTools();
  }

  /**
   * Call a tool. ALL outbound args pass through the redactor first. Returns the
   * redaction count + text result so the daemon can audit mcp.call/mcp.result.
   */
  async callTool(
    server: string,
    tool: string,
    args: unknown,
  ): Promise<{ result: string; redactions: number; redactedArgs: unknown }> {
    const c = await this.client(server);
    const raw = JSON.stringify(args ?? {});
    const { redacted, total } = redact(raw);
    let redactedArgs: unknown;
    try {
      redactedArgs = JSON.parse(redacted);
    } catch {
      redactedArgs = args;
    }
    const result = await c.callTool(tool, redactedArgs);
    return { result, redactions: total, redactedArgs };
  }

  closeAll(): void {
    for (const c of this.clients.values()) c.close();
    this.clients.clear();
  }
}

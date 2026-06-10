import { describe, it, expect } from 'vitest';
import { McpServer } from '../src/mcp/server';
import { McpClient } from '../src/mcp/client';
import { createPairedChannels } from '../src/mcp/protocol';

function makePair() {
  const { a, b } = createPairedChannels();
  const server = new McpServer(b, {
    ledgerVerify: () => JSON.stringify({ ok: true, entries: 3 }),
    ledgerQuery: (args) => JSON.stringify({ query: args, rows: [] }),
    sessionList: () => JSON.stringify([{ sessionId: 's1' }]),
    costReport: () => JSON.stringify({ sessionSpendUsd: 0.5 }),
    redactText: (text) => `redacted:${text.replace(/sk-[A-Za-z0-9]+/g, '***')}`,
    reviewRequest: (mode) => `review(${mode})`,
  });
  const client = new McpClient(a);
  return { server, client };
}

describe('MCP in-process roundtrip', () => {
  it('initializes and lists the read-only tool surface', async () => {
    const { client } = makePair();
    await client.initialize();
    const tools = await client.listTools();
    const names = tools.map((t) => t.name).sort();
    expect(names).toEqual(
      ['cost_report', 'ledger_query', 'ledger_verify', 'redact_text', 'review_request', 'session_list'].sort(),
    );
  });

  it('calls ledger_verify and returns the handler text', async () => {
    const { client } = makePair();
    await client.initialize();
    const out = await client.callTool('ledger_verify', {});
    expect(JSON.parse(out)).toEqual({ ok: true, entries: 3 });
  });

  it('passes arguments through to redact_text', async () => {
    const { client } = makePair();
    await client.initialize();
    const out = await client.callTool('redact_text', { text: 'key sk-ABCDEF123' });
    expect(out).toContain('***');
    expect(out).not.toContain('sk-ABCDEF123');
  });

  it('static toolList advertises exactly the read-only tools (no shell)', () => {
    const names = McpServer.toolList().map((t) => t.name);
    expect(names).not.toContain('bash');
    expect(names).not.toContain('shell');
    expect(names).toContain('ledger_verify');
  });

  it('rejects an unknown tool with a JSON-RPC error', async () => {
    const { client } = makePair();
    await client.initialize();
    await expect(client.callTool('rm_rf', {})).rejects.toThrow(/unknown tool/);
  });
});

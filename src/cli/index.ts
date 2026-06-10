#!/usr/bin/env node
/**
 * `selfconnect` headless CLI.
 *
 * A thin command surface over the governed Daemon core (via the SDK). Every
 * command runs through the SAME path as the Electron app: identity-stamped bus
 * -> policy -> approvals -> redaction -> hash-chained ledger. Provider keys are
 * read from the daemon .env only; the CLI never prints or transmits them.
 *
 * Usage:
 *   selfconnect help
 *   selfconnect state                 print the aggregate UI state as JSON
 *   selfconnect verify                verify the audit ledger hash chain
 *   selfconnect sessions              list resumable sessions
 *   selfconnect review <mode>         run the review agent
 *   selfconnect tools                 list governed tools
 *   selfconnect slash "/cost"        run a slash command
 *   selfconnect mcp serve             run as a read-only MCP server (stdio)
 *   selfconnect ledger verify         verify hash chain AND checkpoint signatures
 *   selfconnect passport export|verify [file]
 *   selfconnect evidence export [sessionId] [out.zip]
 *   selfconnect replay export [sessionId] [out.screplay] | verify <file>
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { SelfConnectClient } from '../sdk/index';
import { zipStore, bundleFiles } from '../daemon/evidence';
import { verifyReplayBundle } from '../daemon/replay';
import { verifyPassport, verifyReveal } from '../daemon/passport';
import { ReplayBundleSchema, PassportSchema } from '../shared/contracts';

function print(line: string): void {
  process.stdout.write(line.endsWith('\n') ? line : line + '\n');
}

function usage(): void {
  print(
    [
      'selfconnect — governed agent execution surface (headless CLI)',
      '',
      'Commands:',
      '  help                    show this help',
      '  state                   print aggregate UI state (JSON)',
      '  verify                  verify the audit ledger hash chain',
      '  sessions                list resumable sessions',
      '  review <mode>           run the review agent (optimize|bugs|architecture|security|next-steps|full)',
      '  tools                   list governed tools',
      '  slash <line>            run a slash command, e.g. slash "/cost"',
      '  mcp serve               run as a read-only MCP server over stdio',
      '  ledger verify           verify hash chain AND every checkpoint signature',
      '  ledger export [--ietf]  export the audit trail (native or IETF conformance)',
      '  passport export|verify  export or verify a signed work-history passport',
      '  evidence export [sid]   write a compliance evidence bundle (.zip)',
      '  replay export|verify    write or verify a signed .screplay session bundle',
    ].join('\n'),
  );
}

async function runMcpServe(client: SelfConnectClient): Promise<void> {
  const { McpServer } = await import('../mcp/server');
  const { processStdioChannel } = await import('../mcp/stdio-channel');
  const d = client.daemon;
  // Read-only handlers: the MCP server NEVER executes shell or mutating tools.
  new McpServer(processStdioChannel(), {
    ledgerVerify: () => JSON.stringify(d.verifyLedger()),
    ledgerQuery: (args) => {
      let entries = d.ledger.all().slice();
      if (args.sessionId) entries = entries.filter((e) => e.sessionId === args.sessionId);
      if (args.type) entries = entries.filter((e) => e.type === args.type);
      const limit = args.limit ?? 20;
      return entries
        .slice(-limit)
        .map((e) => `#${e.seq} ${e.type} ${e.hash.slice(0, 12)}`)
        .join('\n');
    },
    sessionList: () => JSON.stringify(d.listSessions()),
    costReport: () => JSON.stringify(d.snapshot().cost),
    redactText: (text) => d.redactPreview(text),
    reviewRequest: async (mode) => (await d.runReview(mode as never)).content,
  });
  // Keep the process alive on stdin.
  process.stdin.resume();
}

export async function main(argv: string[]): Promise<number> {
  const [cmd, ...rest] = argv;
  const client = new SelfConnectClient();

  switch (cmd) {
    case undefined:
    case 'help':
    case '-h':
    case '--help':
      usage();
      return 0;

    case 'state':
      print(JSON.stringify(client.state(), null, 2));
      return 0;

    case 'verify': {
      const status = client.verifyLedger();
      print(JSON.stringify(status, null, 2));
      return status.ok ? 0 : 1;
    }

    case 'sessions':
      print(JSON.stringify(client.listSessions(), null, 2));
      return 0;

    case 'review': {
      const mode = (rest[0] ?? 'full') as never;
      try {
        const r = await client.review(mode);
        print(r.content);
        return 0;
      } catch (err) {
        print(`review blocked: ${err instanceof Error ? err.message : String(err)}`);
        return 1;
      }
    }

    case 'tools':
      print(JSON.stringify(client.listTools(), null, 2));
      return 0;

    case 'slash': {
      const line = rest.join(' ');
      if (!line) {
        print('usage: selfconnect slash "<line>"');
        return 1;
      }
      const result = await client.slash(line);
      print(result.output);
      return result.ok ? 0 : 1;
    }

    case 'mcp': {
      if (rest[0] === 'serve') {
        await runMcpServe(client);
        return 0; // server stays alive via stdin.resume()
      }
      print('usage: selfconnect mcp serve');
      return 1;
    }

    case 'ledger': {
      if (rest[0] === 'verify') {
        const report = client.daemon.verifyLedgerFull();
        print(JSON.stringify(report, null, 2));
        return report.chainOk && report.checkpointsOk ? 0 : 1;
      }
      if (rest[0] === 'export') {
        const flags = rest.slice(1).filter((a) => a.startsWith('--'));
        const args = rest.slice(1).filter((a) => !a.startsWith('--'));
        const conformance = flags.includes('--ietf') ? 'ietf' : 'native';
        const trail = client.daemon.exportAuditTrail(args[0], conformance);
        const out = args[1];
        const json = JSON.stringify(trail, null, 2);
        if (out) {
          writeFileSync(out, json, 'utf8');
          print(`wrote ${conformance} audit trail to ${out}`);
        } else {
          print(json);
        }
        return 0;
      }
      print('usage: selfconnect ledger verify | ledger export [--ietf] [sessionId] [out.json]');
      return 1;
    }

    case 'passport': {
      const sub = rest[0];
      if (sub === 'export') {
        // Seal a checkpoint first so the passport covers a signed head.
        client.daemon.sealCheckpoint();
        const p = client.daemon.exportPassport();
        const out = rest[1];
        if (out) writeFileSync(out, JSON.stringify(p, null, 2), 'utf8');
        print(out ? `wrote passport to ${out}` : JSON.stringify(p, null, 2));
        return 0;
      }
      if (sub === 'verify') {
        const file = rest[1];
        if (!file) {
          print('usage: selfconnect passport verify <file>');
          return 1;
        }
        const parsed = PassportSchema.safeParse(JSON.parse(readFileSync(file, 'utf8')));
        if (!parsed.success) {
          print('passport: invalid file format');
          return 1;
        }
        const v = verifyPassport(parsed.data);
        print(`passport ${parsed.data.agentId}: ${v.ok ? 'VALID' : 'INVALID'} — ${v.reason}`);
        void verifyReveal; // available for reveal verification
        return v.ok ? 0 : 1;
      }
      print('usage: selfconnect passport export|verify [file]');
      return 1;
    }

    case 'evidence': {
      if (rest[0] !== 'export') {
        print('usage: selfconnect evidence export [sessionId] [out.zip]');
        return 1;
      }
      client.daemon.sealCheckpoint();
      const sessionId = rest[1];
      const bundle = client.daemon.exportEvidence(sessionId);
      const out = rest[2] ?? `evidence-${bundle.sessionId}.zip`;
      writeFileSync(out, zipStore(bundleFiles(bundle)));
      print(`wrote evidence bundle to ${out} (entries=${bundle.report.entries}, checkpoints=${bundle.report.checkpoints}, chainOk=${bundle.report.chainOk}, checkpointsOk=${bundle.report.checkpointsOk})`);
      return 0;
    }

    case 'replay': {
      const sub = rest[0];
      if (sub === 'export') {
        client.daemon.sealCheckpoint();
        const sessionId = rest[1];
        const bundle = client.daemon.exportReplay(sessionId);
        const out = rest[2] ?? `${bundle.sessionId}.screplay`;
        writeFileSync(out, JSON.stringify(bundle, null, 2), 'utf8');
        print(`wrote replay bundle to ${out} (${bundle.events.length} events, ${bundle.checkpoints.length} checkpoints)`);
        return 0;
      }
      if (sub === 'verify') {
        const file = rest[1];
        if (!file) {
          print('usage: selfconnect replay verify <file>');
          return 1;
        }
        const parsed = ReplayBundleSchema.safeParse(JSON.parse(readFileSync(file, 'utf8')));
        if (!parsed.success) {
          print('replay: invalid bundle format');
          return 1;
        }
        const v = verifyReplayBundle(parsed.data);
        print(JSON.stringify(v, null, 2));
        return v.ok ? 0 : 1;
      }
      print('usage: selfconnect replay export|verify [file]');
      return 1;
    }

    default:
      print(`unknown command: ${cmd}`);
      usage();
      return 1;
  }
}

// Only auto-run when invoked as a script (not when imported by tests/SDK).
if (require.main === module) {
  main(process.argv.slice(2))
    .then((code) => {
      if (code !== 0) process.exitCode = code;
    })
    .catch((err) => {
      process.stderr.write(`${err instanceof Error ? err.stack : String(err)}\n`);
      process.exitCode = 1;
    });
}

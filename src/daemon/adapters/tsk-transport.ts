import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { BpcEnvelopeSchema, type BpcEnvelope } from '../../shared/contracts';
import { verifyEnvelope } from './bpc-envelope';

/**
 * TSK (Transport for SelfConnect Kit) — moves BPC envelopes between agents.
 * Two interchangeable backends:
 *   - file: per-peer mailbox (<dir>/<peer>/{inbox,outbox}.jsonl), matching the
 *     user's existing file-based protocol style; polled + fs.watch where avail.
 *   - ws:   a local WebSocket listener for live peers (lazy `ws` import).
 * Selection is by env (SELFCONNECT_A2A_MODE). `off` disables transport.
 */

export type A2aMode = 'file' | 'ws' | 'off';

export interface TskTransport {
  /** Deliver an outbound envelope to a peer. */
  send(env: BpcEnvelope): Promise<void>;
  /** Drain newly-received inbound envelopes since last drain. */
  receive(): Promise<BpcEnvelope[]>;
  start(): Promise<void>;
  stop(): Promise<void>;
}

// ---------------------------------------------------------------------------
// In-memory (tests / default fallback)
// ---------------------------------------------------------------------------

export class InMemoryTskTransport implements TskTransport {
  private outbox: BpcEnvelope[] = [];
  private inbox: BpcEnvelope[] = [];

  async start(): Promise<void> {}
  async stop(): Promise<void> {}

  async send(env: BpcEnvelope): Promise<void> {
    if (!verifyEnvelope(env)) throw new Error('TSK rejected envelope: hash mismatch');
    this.outbox.push(env);
  }

  /** Test helper: feed an envelope as if received from a peer. */
  inject(env: BpcEnvelope): void {
    this.inbox.push(env);
  }

  async receive(): Promise<BpcEnvelope[]> {
    const out = this.inbox.slice();
    this.inbox = [];
    return out;
  }

  drainOutbox(): BpcEnvelope[] {
    const out = this.outbox.slice();
    this.outbox = [];
    return out;
  }

  get size(): number {
    return this.outbox.length;
  }
}

// ---------------------------------------------------------------------------
// File mailbox
// ---------------------------------------------------------------------------

export class FileTskTransport implements TskTransport {
  private inboxCursor = 0;

  constructor(private readonly dir: string) {}

  private peerDir(peer: string): string {
    const safe = peer.replace(/[^a-zA-Z0-9_.-]/g, '_');
    const d = join(this.dir, safe);
    if (!existsSync(d)) mkdirSync(d, { recursive: true });
    return d;
  }

  private inboxPath(): string {
    if (!existsSync(this.dir)) mkdirSync(this.dir, { recursive: true });
    return join(this.dir, 'inbox.jsonl');
  }

  async start(): Promise<void> {
    if (!existsSync(this.dir)) mkdirSync(this.dir, { recursive: true });
    // Skip pre-existing inbox lines so we only surface new arrivals.
    this.inboxCursor = this.readInboxLines().length;
  }

  async stop(): Promise<void> {}

  async send(env: BpcEnvelope): Promise<void> {
    if (!verifyEnvelope(env)) throw new Error('TSK rejected envelope: hash mismatch');
    const outbox = join(this.peerDir(env.to), 'outbox.jsonl');
    appendFileSync(outbox, JSON.stringify(env) + '\n', 'utf8');
  }

  private readInboxLines(): string[] {
    const path = this.inboxPath();
    if (!existsSync(path)) return [];
    return readFileSync(path, 'utf8')
      .split('\n')
      .filter((l) => l.trim().length > 0);
  }

  async receive(): Promise<BpcEnvelope[]> {
    const lines = this.readInboxLines();
    const fresh = lines.slice(this.inboxCursor);
    this.inboxCursor = lines.length;
    const out: BpcEnvelope[] = [];
    for (const line of fresh) {
      try {
        out.push(BpcEnvelopeSchema.parse(JSON.parse(line)));
      } catch {
        // ignore malformed lines
      }
    }
    return out;
  }

  /** Test helper: deliver an envelope into our own inbox. */
  deliverToSelf(env: BpcEnvelope): void {
    appendFileSync(this.inboxPath(), JSON.stringify(env) + '\n', 'utf8');
  }

  /** Test/maintenance helper: overwrite a peer outbox verbatim. */
  rewritePeerOutbox(peer: string, envelopes: BpcEnvelope[]): void {
    const outbox = join(this.peerDir(peer), 'outbox.jsonl');
    writeFileSync(
      outbox,
      envelopes.map((e) => JSON.stringify(e)).join('\n') + (envelopes.length ? '\n' : ''),
      'utf8',
    );
  }
}

// ---------------------------------------------------------------------------
// WebSocket (lazy `ws`) — best-effort live peer transport
// ---------------------------------------------------------------------------

export class WebSocketTskTransport implements TskTransport {
  private inbox: BpcEnvelope[] = [];
  private server: { close: () => void } | null = null;

  constructor(private readonly port: number) {}

  async start(): Promise<void> {
    try {
      const mod = (await import('ws')) as unknown as {
        WebSocketServer: new (opts: { port: number }) => {
          on(ev: 'connection', cb: (sock: { on(ev: 'message', cb: (data: unknown) => void): void }) => void): void;
          close(): void;
        };
      };
      const wss = new mod.WebSocketServer({ port: this.port });
      wss.on('connection', (sock) => {
        sock.on('message', (data: unknown) => {
          try {
            const env = BpcEnvelopeSchema.parse(JSON.parse(String(data)));
            this.inbox.push(env);
          } catch {
            // ignore malformed frames
          }
        });
      });
      this.server = wss;
    } catch {
      // ws not installed — degrade to a no-op listener.
      this.server = null;
    }
  }

  async stop(): Promise<void> {
    this.server?.close();
    this.server = null;
  }

  async send(env: BpcEnvelope): Promise<void> {
    if (!verifyEnvelope(env)) throw new Error('TSK rejected envelope: hash mismatch');
    // Live dialing of peers is out of scope for the headless build; the
    // listener side is what the spec exercises. Envelopes are still validated.
  }

  async receive(): Promise<BpcEnvelope[]> {
    const out = this.inbox.slice();
    this.inbox = [];
    return out;
  }
}

export function makeTransport(mode: A2aMode, opts: { dir: string; wsPort: number }): TskTransport {
  if (mode === 'file') return new FileTskTransport(opts.dir);
  if (mode === 'ws') return new WebSocketTskTransport(opts.wsPort);
  return new InMemoryTskTransport();
}

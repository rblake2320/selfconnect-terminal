import {
  type A2aKind,
  type A2aPeer,
  type BpcEnvelope,
  type Identity,
  type MeteringReceipt,
  type RiskFinding,
  type Signature,
} from '../shared/contracts';
import { redact } from './redactor';
import {
  BPC_GENESIS,
  sealEnvelope,
  verifyChain,
} from './adapters/bpc-envelope';
import { verifySignature } from './agent-keys';
import { makeTransport, type A2aMode, type TskTransport } from './adapters/tsk-transport';

export interface A2aOptions {
  mode: A2aMode;
  dir: string;
  wsPort: number;
  allowlist: string[];
  /** Sign an envelope hash with the sender's identity key (B2.1). */
  signHash?: (hash: string) => Signature;
}

interface PeerState {
  peer: string;
  lastSeenAt: number | null;
  sent: number;
  received: number;
  chainOk: boolean;
  outChain: BpcEnvelope[];
  inChain: BpcEnvelope[];
}

export interface SendResult {
  envelope: BpcEnvelope;
  redactions: number;
}

/**
 * A2A manager: per-peer BPC hash chains over a pluggable TSK transport.
 * Governance:
 *   - outbound payloads ALWAYS pass the redactor;
 *   - sending to a non-allowlisted peer OR any 'handoff' requires approval
 *     (the caller — the daemon — enforces the approval gate; this manager
 *     reports requiresApproval);
 *   - inbound envelopes are chain-verified; a broken chain yields a HIGH finding.
 */
export class A2aManager {
  private transport: TskTransport;
  private peers = new Map<string, PeerState>();
  private allow: Set<string>;
  private signHash?: (hash: string) => Signature;

  constructor(opts: A2aOptions) {
    this.transport = makeTransport(opts.mode, { dir: opts.dir, wsPort: opts.wsPort });
    this.allow = new Set(opts.allowlist.filter((p) => p.trim().length > 0));
    this.signHash = opts.signHash;
  }

  /** Inject (or replace) the envelope signer after construction. */
  setSigner(signHash: (hash: string) => Signature): void {
    this.signHash = signHash;
  }

  async start(): Promise<void> {
    await this.transport.start();
  }

  async stop(): Promise<void> {
    await this.transport.stop();
  }

  /** For tests: inject a transport (e.g. an in-memory or shared file mailbox). */
  setTransport(transport: TskTransport): void {
    this.transport = transport;
  }

  isAllowlisted(peer: string): boolean {
    return this.allow.has(peer);
  }

  /** Does this send need human approval before transmission? */
  requiresApproval(peer: string, kind: A2aKind): boolean {
    return kind === 'handoff' || !this.isAllowlisted(peer);
  }

  private peer(name: string): PeerState {
    let p = this.peers.get(name);
    if (!p) {
      p = {
        peer: name,
        lastSeenAt: null,
        sent: 0,
        received: 0,
        chainOk: true,
        outChain: [],
        inChain: [],
      };
      this.peers.set(name, p);
    }
    return p;
  }

  /**
   * Seal + transmit an envelope. Redaction is applied to the payload's text
   * representation ALWAYS. Returns the sealed envelope and redaction count.
   */
  async send(
    from: Identity,
    peer: string,
    kind: A2aKind,
    payload: unknown,
    receipt?: MeteringReceipt,
  ): Promise<SendResult> {
    const p = this.peer(peer);
    const raw = typeof payload === 'string' ? payload : JSON.stringify(payload);
    const { redacted, total } = redact(raw);
    const prevHash = p.outChain.length ? p.outChain[p.outChain.length - 1].hash : BPC_GENESIS;
    const envelope = sealEnvelope({
      from,
      to: peer,
      kind,
      payload: redacted,
      prevHash,
      receipt,
      signHash: this.signHash,
    });
    p.outChain.push(envelope);
    p.sent += 1;
    await this.transport.send(envelope);
    return { envelope, redactions: total };
  }

  /**
   * Drain inbound envelopes from the transport, verify each peer chain, and
   * return the parsed messages plus any broken-chain findings.
   */
  async poll(): Promise<{ received: BpcEnvelope[]; findings: RiskFinding[] }> {
    const incoming = await this.transport.receive();
    const findings: RiskFinding[] = [];
    for (const env of incoming) {
      const fromPeer = env.from.agentId;
      const p = this.peer(fromPeer);
      p.inChain.push(env);
      p.received += 1;
      p.lastSeenAt = Date.now();
      const check = verifyChain(p.inChain);
      p.chainOk = check.ok;
      if (!check.ok) {
        findings.push({
          command: `a2a:${fromPeer}`,
          severity: 'high',
          reason: `A2A chain from peer ${fromPeer} broken at envelope ${check.brokenAt}`,
          pattern: 'bpc-chain',
        });
      }
      // B2.1: if the envelope is signed, the signature must verify over its
      // hash. A present-but-invalid signature is an impersonation attempt.
      if (env.signature && !verifySignature(env.hash, env.signature)) {
        p.chainOk = false;
        findings.push({
          command: `a2a:${fromPeer}`,
          severity: 'high',
          reason: `A2A envelope ${env.id} from ${fromPeer} has an INVALID signature (impersonation)`,
          pattern: 'bpc-signature',
        });
      }
    }
    return { received: incoming, findings };
  }

  peerList(): A2aPeer[] {
    return [...this.peers.values()].map((p) => ({
      peer: p.peer,
      lastSeenAt: p.lastSeenAt,
      sent: p.sent,
      received: p.received,
      chainOk: p.chainOk,
      allowlisted: this.isAllowlisted(p.peer),
    }));
  }

  inboxPreview(limit = 10): BpcEnvelope[] {
    const all: BpcEnvelope[] = [];
    for (const p of this.peers.values()) all.push(...p.inChain);
    return all.sort((a, b) => b.ts - a.ts).slice(0, limit);
  }
}

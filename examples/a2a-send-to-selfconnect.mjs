#!/usr/bin/env node
// SelfConnect A2A — external-agent example (file-mailbox mode).
//
// Builds a valid BPC/1.0 envelope, appends it to SelfConnect's shared inbox
// (<a2aDir>/inbox.jsonl), then polls the per-peer reply mailbox
// (<a2aDir>/<peer>/outbox.jsonl). Pure Node — no SelfConnect imports — so any
// external agent (e.g. Claude Code) can run it directly.
//
// The envelope hash MUST be computed over the exact canonical form the daemon
// uses (src/daemon/adapters/bpc-envelope.ts -> canonical()):
//   JSON.stringify({ bpc, id, from, to, ts, kind, payload, prevHash })
// in that key order, with payload ?? null. tests/example-a2a-envelope.test.ts
// cross-checks buildEnvelope() against the daemon's real sealEnvelope so this
// stays in lockstep with the app.
//
// Usage:
//   SELFCONNECT_A2A_DIR=./data/a2a \
//   node examples/a2a-send-to-selfconnect.mjs --peer claude-code --text "hello from Claude Code"
//
// Optional signing (Ed25519) — pass a hex private+public key pair. A *valid*
// signature proves "holder of this key signed this hash"; it does NOT by itself
// make the peer trusted. Trust comes from the daemon allowlist
// (SELFCONNECT_A2A_ALLOWLIST) and/or a delegation grant rooted at a human.
// A present-but-INVALID signature is flagged HIGH (impersonation) by the daemon.

import { createHash, randomUUID, sign as edSign, createPrivateKey, createPublicKey } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

export const BPC_GENESIS = '0'.repeat(64);

/** Exact daemon canonical form — key order matters for the hash. */
export function canonical(e) {
  return JSON.stringify({
    bpc: e.bpc,
    id: e.id,
    from: e.from,
    to: e.to,
    ts: e.ts,
    kind: e.kind,
    payload: e.payload ?? null,
    prevHash: e.prevHash,
  });
}

export function hashEnvelope(base) {
  return createHash('sha256').update(canonical(base)).digest('hex');
}

const SPKI_ED25519_PREFIX = '302a300506032b6570032100';

function signHashEd25519(hash, privateKeyHex, publicKeyHex) {
  const der = Buffer.from('302e020100300506032b657004220420' + privateKeyHex, 'hex');
  const key = createPrivateKey({ key: der, format: 'der', type: 'pkcs8' });
  const sigHex = edSign(null, Buffer.from(hash, 'utf8'), key).toString('hex');
  // Derive signer's public key hex if not supplied.
  let pubHex = publicKeyHex;
  if (!pubHex) {
    const spki = createPublicKey(key).export({ format: 'der', type: 'spki' });
    pubHex = Buffer.from(spki).toString('hex').slice(SPKI_ED25519_PREFIX.length);
  }
  return { signer: 'external', publicKeyHex: pubHex, sigHex, alg: 'ed25519' };
}

/**
 * Build a sealed BPC envelope. `from.agentId` is the peer key the daemon tracks
 * (a2a-manager.poll keys peers by env.from.agentId), so set it to your peer id.
 */
export function buildEnvelope({
  peerId,
  to,
  text,
  kind = 'msg',
  prevHash = BPC_GENESIS,
  ts = Date.now(),
  privateKeyHex,
  publicKeyHex,
}) {
  const base = {
    bpc: '1.0',
    id: `bpc_${randomUUID()}`,
    from: { sessionId: `sess_${peerId}`, runId: `run_${randomUUID()}`, agentId: peerId },
    to,
    ts,
    kind,
    payload: text,
    prevHash,
  };
  const hash = hashEnvelope(base);
  const env = { ...base, hash };
  if (privateKeyHex) env.signature = signHashEd25519(hash, privateKeyHex, publicKeyHex);
  return env;
}

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) out[a.slice(2)] = argv[++i];
  }
  return out;
}

function readJsonl(path) {
  if (!existsSync(path)) return [];
  return readFileSync(path, 'utf8')
    .split('\n')
    .filter((l) => l.trim().length > 0)
    .map((l) => {
      try {
        return JSON.parse(l);
      } catch {
        return null;
      }
    })
    .filter(Boolean);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const dir = process.env.SELFCONNECT_A2A_DIR || './data/a2a';
  const peer = args.peer || 'claude-code';
  const to = args.to || 'system'; // logical daemon-side recipient label
  const text = args.text || 'hello from an external agent';

  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });

  // Chain onto our own previously-sent envelopes (per-peer hash chain). The
  // daemon verifies our inbound chain starting at BPC_GENESIS, so track prevHash
  // across sends. Here we read what WE put in the shared inbox for this peer.
  const inbox = join(dir, 'inbox.jsonl');
  const mine = readJsonl(inbox).filter((e) => e?.from?.agentId === peer);
  const prevHash = mine.length ? mine[mine.length - 1].hash : BPC_GENESIS;

  const env = buildEnvelope({
    peerId: peer,
    to,
    text,
    prevHash,
    privateKeyHex: process.env.SELFCONNECT_EXAMPLE_PRIVKEY_HEX,
    publicKeyHex: process.env.SELFCONNECT_EXAMPLE_PUBKEY_HEX,
  });

  appendFileSync(inbox, JSON.stringify(env) + '\n', 'utf8');
  console.log(`[sent] id=${env.id} -> ${inbox}`);
  console.log(`[sent] peer(from.agentId)=${peer} prevHash=${prevHash.slice(0, 12)}… hash=${env.hash.slice(0, 12)}…`);
  console.log(`[sent] signed=${Boolean(env.signature)}`);
  console.log('Now run /a2a poll in SelfConnect to ingest it, then watch the reply mailbox below.');

  // Poll the per-peer outbox the daemon writes its replies to.
  const sanitized = peer.replace(/[^a-zA-Z0-9_.-]/g, '_');
  const outbox = join(dir, sanitized, 'outbox.jsonl');
  const seen = readJsonl(outbox).length;
  console.log(`[reply] watching ${outbox} (currently ${seen} envelope(s))`);

  const deadlineMs = Number(args.wait || 30000);
  const started = Date.now();
  while (Date.now() - started < deadlineMs) {
    const replies = readJsonl(outbox);
    if (replies.length > seen) {
      for (const r of replies.slice(seen)) {
        console.log(`[reply] id=${r.id} kind=${r.kind} payload=${JSON.stringify(r.payload)}`);
      }
      return;
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
  console.log('[reply] no reply within wait window (the daemon must be running and you must /a2a send back to this peer).');
}

// Run only when executed directly (not when imported by the test).
const invokedDirectly = process.argv[1] && process.argv[1].endsWith('a2a-send-to-selfconnect.mjs');
if (invokedDirectly) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}

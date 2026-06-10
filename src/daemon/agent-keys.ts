import {
  generateKeyPairSync,
  sign as edSign,
  verify as edVerify,
  createPublicKey,
  createPrivateKey,
  type KeyObject,
} from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import type { AgentPublicKey, Signature } from '../shared/contracts';

/**
 * Daemon-only Ed25519 keystore (B2.1). Every agentId gets a keypair the first
 * time it is referenced; the PRIVATE key is written to ./data/keys/<agentId>.pem
 * and NEVER leaves the daemon — no contract, IPC payload, or renderer state ever
 * carries it. Only the raw 32-byte public key (hex) is exported, so envelopes,
 * checkpoints, passports, and delegation certs can be verified by third parties.
 *
 * Ed25519 is used directly via node:crypto (`generateKeyPairSync('ed25519')`,
 * detached `sign`/`verify` with a null digest algorithm). Signatures and public
 * keys cross boundaries as hex strings.
 */

const SPKI_ED25519_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');

/** Extract the raw 32-byte public key from a KeyObject as hex. */
function rawPublicHex(key: KeyObject): string {
  const spki = key.export({ type: 'spki', format: 'der' });
  // SPKI for Ed25519 is a fixed 12-byte header + 32-byte key.
  return Buffer.from(spki.subarray(spki.length - 32)).toString('hex');
}

/** Rebuild a public KeyObject from a raw 32-byte hex public key. */
export function publicKeyFromHex(hex: string): KeyObject {
  const raw = Buffer.from(hex, 'hex');
  if (raw.length !== 32) throw new Error(`bad ed25519 public key length: ${raw.length}`);
  const der = Buffer.concat([SPKI_ED25519_PREFIX, raw]);
  return createPublicKey({ key: der, format: 'der', type: 'spki' });
}

interface KeyEntry {
  agentId: string;
  privateKey: KeyObject;
  publicKey: KeyObject;
  publicKeyHex: string;
  createdAt: number;
}

export interface KeyCreation {
  pub: AgentPublicKey;
  created: boolean;
}

export class AgentKeystore {
  private keys = new Map<string, KeyEntry>();

  constructor(private readonly dir: string) {
    if (!existsSync(this.dir)) mkdirSync(this.dir, { recursive: true });
    this.load();
  }

  private load(): void {
    let files: string[] = [];
    try {
      files = readdirSync(this.dir).filter((f) => f.endsWith('.pem'));
    } catch {
      return;
    }
    for (const f of files) {
      const agentId = f.replace(/\.pem$/, '');
      try {
        const pem = readFileSync(join(this.dir, f), 'utf8');
        const privateKey = createPrivateKeyFromPem(pem);
        const publicKey = createPublicKey(privateKey);
        const meta = readMeta(join(this.dir, `${agentId}.json`));
        this.keys.set(agentId, {
          agentId,
          privateKey,
          publicKey,
          publicKeyHex: rawPublicHex(publicKey),
          createdAt: meta?.createdAt ?? Date.now(),
        });
      } catch {
        // skip unreadable key
      }
    }
  }

  /** Ensure an agent has a keypair, minting one on first reference. */
  ensure(agentId: string): KeyCreation {
    const existing = this.keys.get(agentId);
    if (existing) {
      return { pub: this.toPublic(existing), created: false };
    }
    const { privateKey, publicKey } = generateKeyPairSync('ed25519');
    const createdAt = Date.now();
    const entry: KeyEntry = {
      agentId,
      privateKey,
      publicKey,
      publicKeyHex: rawPublicHex(publicKey),
      createdAt,
    };
    this.keys.set(agentId, entry);
    try {
      const pem = privateKey.export({ type: 'pkcs8', format: 'pem' }) as string;
      writeFileSync(join(this.dir, `${agentId}.pem`), pem, { mode: 0o600 });
      writeFileSync(join(this.dir, `${agentId}.json`), JSON.stringify({ createdAt }), 'utf8');
    } catch {
      // best-effort persistence; in-memory key still usable this session
    }
    return { pub: this.toPublic(entry), created: true };
  }

  has(agentId: string): boolean {
    return this.keys.has(agentId);
  }

  publicKeyHex(agentId: string): string {
    return this.ensure(agentId).pub.publicKeyHex;
  }

  toPublicKey(agentId: string): AgentPublicKey {
    return this.toPublic(this.keys.get(agentId) ?? this.ensureEntry(agentId));
  }

  /** All known public keys (for evidence/replay bundles). */
  allPublicKeys(): AgentPublicKey[] {
    return [...this.keys.values()].map((e) => this.toPublic(e));
  }

  /** Sign a canonical message string with an agent's key (minting if needed). */
  sign(agentId: string, message: string): Signature {
    const entry = this.ensureEntry(agentId);
    const sigHex = edSign(null, Buffer.from(message, 'utf8'), entry.privateKey).toString('hex');
    return {
      signer: agentId,
      publicKeyHex: entry.publicKeyHex,
      sigHex,
      alg: 'ed25519',
    };
  }

  private ensureEntry(agentId: string): KeyEntry {
    this.ensure(agentId);
    return this.keys.get(agentId)!;
  }

  private toPublic(e: KeyEntry): AgentPublicKey {
    return { agentId: e.agentId, publicKeyHex: e.publicKeyHex, createdAt: e.createdAt };
  }
}

/**
 * Verify a detached signature against its embedded public key. Stateless: the
 * signature carries the signer's public key, so any party (CLI, third party,
 * browser bundle viewer) can verify without the keystore.
 */
export function verifySignature(message: string, signature: Signature): boolean {
  try {
    const pub = publicKeyFromHex(signature.publicKeyHex);
    return edVerify(null, Buffer.from(message, 'utf8'), pub, Buffer.from(signature.sigHex, 'hex'));
  } catch {
    return false;
  }
}

function createPrivateKeyFromPem(pem: string): KeyObject {
  return createPrivateKey({ key: pem, format: 'pem', type: 'pkcs8' });
}

function readMeta(path: string): { createdAt: number } | null {
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as { createdAt: number };
  } catch {
    return null;
  }
}

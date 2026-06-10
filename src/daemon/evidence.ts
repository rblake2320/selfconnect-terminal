import { createHash } from 'node:crypto';
import {
  type AgentPublicKey,
  type LedgerCheckpoint,
  type LedgerEntry,
  type VerificationReport,
} from '../shared/contracts';

/**
 * Compliance evidence bundle (Section B). A self-contained, offline-verifiable
 * package for one session: the ledger slice, the signed checkpoints covering
 * it, the public keys needed to verify every signature, and a verification
 * report. Packaged as a store-only (uncompressed) ZIP so an auditor can open it
 * with any tool — no extra dependency, deterministic bytes, D7-compliant.
 */

export interface EvidenceBundle {
  sessionId: string;
  generatedAt: number;
  events: LedgerEntry[];
  checkpoints: LedgerCheckpoint[];
  publicKeys: AgentPublicKey[];
  report: VerificationReport;
}

export interface EvidenceInput {
  sessionId: string;
  events: LedgerEntry[];
  checkpoints: LedgerCheckpoint[];
  publicKeys: AgentPublicKey[];
  chainOk: boolean;
  checkpointsOk: boolean;
  brokenAt: number | null;
  generatedAt?: number;
}

export function buildEvidenceBundle(input: EvidenceInput): EvidenceBundle {
  const generatedAt = input.generatedAt ?? Date.now();
  const report: VerificationReport = {
    chainOk: input.chainOk,
    checkpointsOk: input.checkpointsOk,
    entries: input.events.length,
    checkpoints: input.checkpoints.length,
    brokenAt: input.brokenAt,
    generatedAt,
  };
  return {
    sessionId: input.sessionId,
    generatedAt,
    events: input.events,
    checkpoints: input.checkpoints,
    publicKeys: input.publicKeys,
    report,
  };
}

/** The named JSON members of an evidence bundle, for zip packaging. */
export function bundleFiles(bundle: EvidenceBundle): Record<string, string> {
  return {
    'ledger.jsonl': bundle.events.map((e) => JSON.stringify(e)).join('\n') + (bundle.events.length ? '\n' : ''),
    'checkpoints.jsonl': bundle.checkpoints.map((c) => JSON.stringify(c)).join('\n') + (bundle.checkpoints.length ? '\n' : ''),
    'pubkeys.json': JSON.stringify(bundle.publicKeys, null, 2),
    'verification-report.json': JSON.stringify(bundle.report, null, 2),
    'manifest.json': JSON.stringify({ sessionId: bundle.sessionId, generatedAt: bundle.generatedAt }, null, 2),
  };
}

// --- Store-only ZIP encoder (no compression, no external deps) -------------

function crc32(buf: Buffer): number {
  let crc = 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    crc ^= buf[i];
    for (let k = 0; k < 8; k++) {
      crc = crc & 1 ? (crc >>> 1) ^ 0xedb88320 : crc >>> 1;
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

interface ZipEntry {
  name: string;
  data: Buffer;
  crc: number;
  offset: number;
}

/**
 * Build a minimal, valid ZIP archive (STORE method) from a name→content map.
 * Deterministic given identical inputs (no timestamps embedded).
 */
export function zipStore(files: Record<string, string>): Buffer {
  const chunks: Buffer[] = [];
  const entries: ZipEntry[] = [];
  let offset = 0;

  for (const [name, content] of Object.entries(files)) {
    const data = Buffer.from(content, 'utf8');
    const nameBuf = Buffer.from(name, 'utf8');
    const crc = crc32(data);

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0); // local file header sig
    local.writeUInt16LE(20, 4); // version needed
    local.writeUInt16LE(0, 6); // flags
    local.writeUInt16LE(0, 8); // method = store
    local.writeUInt16LE(0, 10); // mod time
    local.writeUInt16LE(0, 12); // mod date
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18); // compressed size
    local.writeUInt32LE(data.length, 22); // uncompressed size
    local.writeUInt16LE(nameBuf.length, 26);
    local.writeUInt16LE(0, 28); // extra len

    entries.push({ name, data, crc, offset });
    chunks.push(local, nameBuf, data);
    offset += local.length + nameBuf.length + data.length;
  }

  const central: Buffer[] = [];
  let centralSize = 0;
  for (const e of entries) {
    const nameBuf = Buffer.from(e.name, 'utf8');
    const hdr = Buffer.alloc(46);
    hdr.writeUInt32LE(0x02014b50, 0); // central dir sig
    hdr.writeUInt16LE(20, 4); // version made by
    hdr.writeUInt16LE(20, 6); // version needed
    hdr.writeUInt16LE(0, 8); // flags
    hdr.writeUInt16LE(0, 10); // method
    hdr.writeUInt16LE(0, 12); // mod time
    hdr.writeUInt16LE(0, 14); // mod date
    hdr.writeUInt32LE(e.crc, 16);
    hdr.writeUInt32LE(e.data.length, 20);
    hdr.writeUInt32LE(e.data.length, 24);
    hdr.writeUInt16LE(nameBuf.length, 28);
    hdr.writeUInt16LE(0, 30); // extra
    hdr.writeUInt16LE(0, 32); // comment
    hdr.writeUInt16LE(0, 34); // disk number
    hdr.writeUInt16LE(0, 36); // internal attrs
    hdr.writeUInt32LE(0, 38); // external attrs
    hdr.writeUInt32LE(e.offset, 42); // local header offset
    central.push(hdr, nameBuf);
    centralSize += hdr.length + nameBuf.length;
  }

  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0); // EOCD sig
  eocd.writeUInt16LE(0, 4); // disk
  eocd.writeUInt16LE(0, 6); // disk with central dir
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(centralSize, 12);
  eocd.writeUInt32LE(offset, 16); // central dir offset
  eocd.writeUInt16LE(0, 20); // comment len

  return Buffer.concat([...chunks, ...central, eocd]);
}

/** Stable digest of the evidence content (for logging / cross-checks). */
export function bundleDigest(bundle: EvidenceBundle): string {
  const files = bundleFiles(bundle);
  const h = createHash('sha256');
  for (const name of Object.keys(files).sort()) {
    h.update(name).update('\0').update(files[name]).update('\0');
  }
  return h.digest('hex');
}

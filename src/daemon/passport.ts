import { createHash } from 'node:crypto';
import {
  type LedgerEntry,
  type MerkleReveal,
  type MerkleProofStep,
  type Passport,
  type PassportSummary,
  type Signature,
} from '../shared/contracts';
import { verifySignature } from './agent-keys';

/**
 * Agent passport (B2.3): a third-party-verifiable, signed summary of an agent's
 * work history, backed by a Merkle hash-tree over its ledger events.
 *
 * The signed `merkleRoot` commits to every covered event without disclosing any
 * content. A holder can selectively REVEAL individual events with a Merkle
 * inclusion proof — the verifier confirms the leaf belongs under the signed
 * root, learning only what was disclosed. The summary counts (tool calls,
 * spend, risk findings, approvals) are signed alongside the root, so they
 * cannot be inflated without the agent's private key. This is the seed of
 * agent reputation/insurability: provable history, content-private by default.
 */

function sha256(s: string): string {
  return createHash('sha256').update(s).digest('hex');
}

/** Stable per-event leaf hash (commits to the event without re-deriving it). */
export function leafHash(entry: LedgerEntry): string {
  return sha256(JSON.stringify({ seq: entry.seq, type: entry.type, hash: entry.hash }));
}

/**
 * Build a Merkle tree from leaf hashes. Odd nodes are promoted (duplicated) at
 * each level — a standard, deterministic construction. Returns the root and the
 * per-level node arrays for proof generation.
 */
export function buildMerkle(leaves: string[]): { root: string; levels: string[][] } {
  if (leaves.length === 0) {
    const root = sha256('');
    return { root, levels: [['']] };
  }
  const levels: string[][] = [leaves.slice()];
  let level = leaves.slice();
  while (level.length > 1) {
    const next: string[] = [];
    for (let i = 0; i < level.length; i += 2) {
      const left = level[i];
      const right = i + 1 < level.length ? level[i + 1] : level[i];
      next.push(sha256(left + right));
    }
    levels.push(next);
    level = next;
  }
  return { root: level[0], levels };
}

/** Generate an inclusion proof for leaf `index` from the tree levels. */
export function merkleProof(levels: string[][], index: number): MerkleProofStep[] {
  const proof: MerkleProofStep[] = [];
  let idx = index;
  for (let l = 0; l < levels.length - 1; l++) {
    const level = levels[l];
    const isRight = idx % 2 === 1;
    const siblingIdx = isRight ? idx - 1 : idx + 1;
    const sibling = siblingIdx < level.length ? level[siblingIdx] : level[idx];
    proof.push({ hash: sibling, left: isRight });
    idx = Math.floor(idx / 2);
  }
  return proof;
}

/** Recompute a root from a leaf hash + its proof (used by verifiers). */
export function rootFromProof(leaf: string, proof: MerkleProofStep[]): string {
  let acc = leaf;
  for (const step of proof) {
    acc = step.left ? sha256(step.hash + acc) : sha256(acc + step.hash);
  }
  return acc;
}

export function summarize(entries: LedgerEntry[]): PassportSummary {
  const sessions = new Set<string>();
  let toolCalls = 0;
  let riskFindings = 0;
  let approvalsRequested = 0;
  let approvalsResolved = 0;
  let spendUsd = 0;
  for (const e of entries) {
    if (e.sessionId) sessions.add(e.sessionId);
    if (e.type === 'tool.call') toolCalls += 1;
    if (e.type === 'risk.detected') riskFindings += 1;
    if (e.type === 'approval.requested') approvalsRequested += 1;
    if (e.type === 'approval.resolved') approvalsResolved += 1;
    if (e.type === 'cost.update') {
      const p = e.payload as { sessionSpendUsd?: number } | undefined;
      if (p && typeof p.sessionSpendUsd === 'number') spendUsd = Math.max(spendUsd, p.sessionSpendUsd);
    }
  }
  return {
    sessions: sessions.size,
    toolCalls,
    spendUsd,
    riskFindings,
    approvalsRequested,
    approvalsResolved,
    events: entries.length,
  };
}

/** Canonical message a passport signs (root + counts). */
export function passportMessage(p: Omit<Passport, 'signature'>): string {
  return JSON.stringify({
    version: p.version,
    agentId: p.agentId,
    issuedAt: p.issuedAt,
    summary: p.summary,
    merkleRoot: p.merkleRoot,
    leafCount: p.leafCount,
  });
}

export interface PassportArtifact {
  passport: Passport;
  /** Leaf hashes in order (kept by the issuer to produce reveals on demand). */
  leaves: string[];
  levels: string[][];
}

/** Build + sign a passport over the given ledger entries. */
export function buildPassport(
  agentId: string,
  entries: LedgerEntry[],
  sign: (msg: string) => Signature,
  issuedAt = Date.now(),
): PassportArtifact {
  const leaves = entries.map(leafHash);
  const { root, levels } = buildMerkle(leaves);
  const unsigned: Omit<Passport, 'signature'> = {
    version: 1,
    agentId,
    issuedAt,
    summary: summarize(entries),
    merkleRoot: root,
    leafCount: leaves.length,
  };
  const passport: Passport = { ...unsigned, signature: sign(passportMessage(unsigned)) };
  return { passport, leaves, levels };
}

/** Produce a selective reveal for one leaf index. */
export function revealLeaf(
  artifact: PassportArtifact,
  index: number,
  content?: string,
): MerkleReveal {
  return {
    index,
    leafHash: artifact.leaves[index],
    content,
    proof: merkleProof(artifact.levels, index),
  };
}

export interface PassportVerification {
  ok: boolean;
  signatureOk: boolean;
  reason: string;
}

/** Verify a passport's signature (third party, no keystore needed). */
export function verifyPassport(passport: Passport): PassportVerification {
  const signatureOk = verifySignature(passportMessage(passport), passport.signature);
  if (!signatureOk) return { ok: false, signatureOk, reason: 'passport signature invalid' };
  if (passport.signature.signer !== passport.agentId) {
    return { ok: false, signatureOk, reason: 'passport signed by a different agent than it claims' };
  }
  return { ok: true, signatureOk, reason: 'passport signature valid' };
}

/** Verify a selective reveal against a signed passport's root. */
export function verifyReveal(passport: Passport, reveal: MerkleReveal): boolean {
  return rootFromProof(reveal.leafHash, reveal.proof) === passport.merkleRoot;
}

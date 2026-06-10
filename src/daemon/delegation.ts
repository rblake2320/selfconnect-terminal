import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, appendFileSync } from 'node:fs';
import { dirname } from 'node:path';
import {
  DelegationCertSchema,
  type DataClass,
  type DelegationCert,
  type DelegationScope,
  type DelegationVerdict,
  type Signature,
} from '../shared/contracts';
import { verifySignature } from './agent-keys';

/**
 * Delegation certificates (B2.2): a human→agent→subagent authority chain.
 *
 * A root grant is authorized by a human (issuer === 'human', parent === null,
 * humanApproved === true) and is signed by the system identity at the human's
 * direction (approved via the ApprovalsPanel at session start). Each further
 * grant is signed by the issuing agent's identity key and points at its parent
 * by hash. The daemon REFUSES any tool/A2A action whose grantee's chain does
 * not terminate at a human root, or whose effective scope is missing/expired/
 * over-tools/over-budget/over-class. ("Who authorized this?" — answerable
 * forever from the ledger + the cert store.)
 *
 * Scope composes by INTERSECTION down the chain: a child can never hold more
 * authority than its parent (tools subset, min budget, earliest expiry, data
 * classes subset).
 */

export const HUMAN_ROOT = 'human';

/** Canonical message a certificate signs (excludes the hash + signature). */
export function certMessage(c: Omit<DelegationCert, 'hash' | 'signature'>): string {
  return JSON.stringify({
    issuer: c.issuer,
    grantee: c.grantee,
    scope: c.scope,
    parent: c.parent,
    issuedAt: c.issuedAt,
    humanApproved: c.humanApproved,
  });
}

export function certHash(msg: string): string {
  return createHash('sha256').update(msg).digest('hex');
}

function intersectScopes(parent: DelegationScope, child: DelegationScope): DelegationScope {
  const tools = parent.tools.includes('*')
    ? child.tools
    : child.tools.includes('*')
      ? parent.tools
      : child.tools.filter((t) => parent.tools.includes(t));
  const dataClasses = parent.dataClasses.filter((d) => child.dataClasses.includes(d));
  const expiries = [parent.expiresAt, child.expiresAt].filter((e) => e > 0);
  const budgets = [parent.spendBudgetUsd, child.spendBudgetUsd].filter((b) => b > 0);
  return {
    tools,
    dataClasses,
    expiresAt: expiries.length ? Math.min(...expiries) : 0,
    spendBudgetUsd: budgets.length ? Math.min(...budgets) : 0,
  };
}

export interface ActionCheck {
  tool?: string;
  spendUsd?: number;
  dataClass?: DataClass;
  now?: number;
}

export class DelegationRegistry {
  private byHash = new Map<string, DelegationCert>();

  constructor(private readonly path: string) {
    const dir = dirname(this.path);
    if (dir && !existsSync(dir)) mkdirSync(dir, { recursive: true });
    this.load();
  }

  private load(): void {
    if (!existsSync(this.path)) return;
    const raw = readFileSync(this.path, 'utf8');
    for (const line of raw.split('\n').filter((l) => l.trim().length > 0)) {
      const parsed = DelegationCertSchema.safeParse(JSON.parse(line));
      if (parsed.success) this.byHash.set(parsed.data.hash, parsed.data);
    }
  }

  private persist(cert: DelegationCert): void {
    try {
      appendFileSync(this.path, JSON.stringify(cert) + '\n', 'utf8');
    } catch {
      // best-effort
    }
  }

  /**
   * Issue a certificate from `issuer` to `grantee`. `sign` signs with the
   * issuer's identity key. A root grant passes parent === null and
   * humanApproved === true (issuer is HUMAN_ROOT).
   */
  issue(input: {
    issuer: string;
    grantee: string;
    scope: DelegationScope;
    parent: string | null;
    humanApproved?: boolean;
    sign: (msg: string) => Signature;
    issuedAt?: number;
  }): DelegationCert {
    const base = {
      issuer: input.issuer,
      grantee: input.grantee,
      scope: input.scope,
      parent: input.parent,
      issuedAt: input.issuedAt ?? Date.now(),
      humanApproved: input.humanApproved ?? false,
    };
    const msg = certMessage(base);
    const hash = certHash(msg);
    const cert: DelegationCert = { ...base, hash, signature: input.sign(msg) };
    this.byHash.set(hash, cert);
    this.persist(cert);
    return cert;
  }

  get(hash: string): DelegationCert | undefined {
    return this.byHash.get(hash);
  }

  all(): DelegationCert[] {
    return [...this.byHash.values()];
  }

  /** Latest valid (signature-checked) cert whose grantee is this agent. */
  latestFor(grantee: string): DelegationCert | undefined {
    return this.all()
      .filter((c) => c.grantee === grantee)
      .sort((a, b) => b.issuedAt - a.issuedAt)[0];
  }

  /**
   * Walk a certificate's parent chain, verifying each link's signature and the
   * content hash, until reaching a human root. Returns the effective
   * (intersected) scope or a steering reason on failure.
   */
  verifyChain(startHash: string, now = Date.now()): DelegationVerdict {
    const chain: string[] = [];
    let current = this.byHash.get(startHash);
    if (!current) return { ok: false, reason: 'no delegation certificate for this action', chain };

    let effective: DelegationScope | null = null;
    const seen = new Set<string>();

    while (current) {
      if (seen.has(current.hash)) return { ok: false, reason: 'delegation chain has a cycle', chain };
      seen.add(current.hash);
      chain.push(current.hash);

      // Content hash integrity.
      const msg = certMessage(current);
      if (certHash(msg) !== current.hash) {
        return { ok: false, reason: `certificate ${current.hash.slice(0, 12)} content does not match its hash`, chain };
      }
      // Signature integrity.
      if (!verifySignature(msg, current.signature)) {
        return { ok: false, reason: `certificate ${current.hash.slice(0, 12)} has an invalid signature`, chain };
      }
      // Expiry.
      if (current.scope.expiresAt > 0 && now > current.scope.expiresAt) {
        return { ok: false, reason: `delegation ${current.hash.slice(0, 12)} expired`, chain };
      }

      effective = effective ? intersectScopes(current.scope, effective) : current.scope;

      if (current.parent === null) {
        // Must be a human-approved root.
        if (current.issuer !== HUMAN_ROOT || !current.humanApproved) {
          return { ok: false, reason: 'delegation chain does not terminate at a human root grant', chain };
        }
        return { ok: true, reason: 'verified to human root', effectiveScope: effective ?? current.scope, chain };
      }

      const parent = this.byHash.get(current.parent);
      if (!parent) {
        return { ok: false, reason: `missing parent certificate ${current.parent.slice(0, 12)}`, chain };
      }
      // The issuer of a child must be the grantee of its parent.
      if (current.issuer !== parent.grantee) {
        return { ok: false, reason: 'broken authority link: child issuer is not parent grantee', chain };
      }
      current = parent;
    }
    return { ok: false, reason: 'delegation chain did not reach a root', chain };
  }

  /**
   * Authorize a concrete action for an agent: find its latest grant, verify the
   * chain to a human root, then check tool/budget/data-class against the
   * effective scope. Returns a verdict whose `reason` doubles as steering text.
   */
  authorize(grantee: string, action: ActionCheck): DelegationVerdict {
    const cert = this.latestFor(grantee);
    if (!cert) {
      return { ok: false, reason: `no delegation grant for ${grantee}; ask the human to /grant`, chain: [] };
    }
    const verdict = this.verifyChain(cert.hash, action.now);
    if (!verdict.ok || !verdict.effectiveScope) return verdict;

    const scope = verdict.effectiveScope;
    if (action.tool && !scope.tools.includes('*') && !scope.tools.includes(action.tool)) {
      return { ok: false, reason: `tool '${action.tool}' is outside the delegated scope`, effectiveScope: scope, chain: verdict.chain };
    }
    if (action.spendUsd && scope.spendBudgetUsd > 0 && action.spendUsd > scope.spendBudgetUsd) {
      return { ok: false, reason: `action cost $${action.spendUsd.toFixed(4)} exceeds delegated budget $${scope.spendBudgetUsd.toFixed(4)}`, effectiveScope: scope, chain: verdict.chain };
    }
    if (action.dataClass && !scope.dataClasses.includes(action.dataClass)) {
      return { ok: false, reason: `data class '${action.dataClass}' is outside the delegated scope`, effectiveScope: scope, chain: verdict.chain };
    }
    return verdict;
  }
}

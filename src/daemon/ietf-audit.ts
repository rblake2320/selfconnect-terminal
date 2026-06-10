import type { LedgerEntry, EventType } from '../shared/contracts';

/**
 * IETF draft-sharif-agent-audit-trail-00 conformance mapping.
 *
 * A sensible, self-authored mapping of SelfConnect ledger entries onto an
 * agent-audit-trail-style event record. We do NOT fetch the draft; the field
 * names below follow the draft's described structure (a hash-linked sequence
 * of audit events, each with an action category, actor, target, and outcome).
 * The mapping is exposed only when the conformance flag is set so the native
 * ledger shape stays authoritative for everything else.
 */

/** draft-sharif action categories we map our event types onto. */
export type IetfAction =
  | 'invoke' // tool / capability invocation
  | 'communicate' // agent-to-agent / external messaging
  | 'decide' // routing / policy decisions
  | 'authorize' // delegation / approval / grant lifecycle
  | 'attest' // signing, checkpoints, passports, evidence
  | 'observe' // terminal / context / cost telemetry
  | 'lifecycle'; // run / agent / session start-stop

export interface IetfAuditEvent {
  /** draft: monotonically increasing record index within the trail. */
  recordId: number;
  /** draft: RFC3339 timestamp. */
  time: string;
  /** draft: coarse action category. */
  action: IetfAction;
  /** draft: native event type, preserved for round-trips. */
  eventType: EventType;
  /** draft: the acting principal (agent identity). */
  actor: { id: string; type: 'agent' | 'human' | 'system' };
  /** draft: optional logical grouping (our session/run). */
  context: { sessionId?: string; runId?: string };
  /** draft: free-form, redaction-safe attributes. */
  attributes: unknown;
  /** draft: hash linkage for tamper evidence. */
  hash: string;
  prevHash: string;
}

/** Map a native event type to a draft action category. */
export function ietfAction(type: EventType): IetfAction {
  switch (type) {
    case 'tool.call':
    case 'tool.result':
    case 'tool.blocked':
    case 'mcp.call':
    case 'mcp.result':
      return 'invoke';
    case 'a2a.sent':
    case 'a2a.received':
    case 'a2a.chain_broken':
      return 'communicate';
    case 'route.decision':
    case 'policy.block':
      return 'decide';
    case 'approval.requested':
    case 'approval.resolved':
    case 'grant.root':
    case 'delegation.issued':
    case 'delegation.denied':
      return 'authorize';
    case 'envelope.signed':
    case 'signature.verified':
    case 'signature.invalid':
    case 'checkpoint.signed':
    case 'checkpoint.created':
    case 'checkpoint.restored':
    case 'identity.key_created':
    case 'passport.exported':
    case 'passport.verified':
    case 'evidence.exported':
    case 'replay.exported':
    case 'ledger.append':
    case 'ledger.verify':
      return 'attest';
    case 'run.start':
    case 'run.end':
    case 'agent.spawn':
    case 'agent.exit':
    case 'terminal.spawn':
    case 'terminal.exit':
    case 'session.snapshot':
    case 'session.resumed':
      return 'lifecycle';
    default:
      return 'observe';
  }
}

function actorType(agentId: string | undefined): 'agent' | 'human' | 'system' {
  if (!agentId) return 'system';
  if (agentId === 'human') return 'human';
  // The system agent is named 'system' or stamped 'agent_system[_<suffix>]'.
  if (agentId === 'system' || /(^|_)system(_|$)/.test(agentId)) return 'system';
  return 'agent';
}

/** Map one native ledger entry to a draft-conformant audit event. */
export function toIetfAuditEvent(entry: LedgerEntry): IetfAuditEvent {
  return {
    recordId: entry.seq,
    time: new Date(entry.ts).toISOString(),
    action: ietfAction(entry.type),
    eventType: entry.type,
    actor: { id: entry.agentId ?? 'system', type: actorType(entry.agentId) },
    context: { sessionId: entry.sessionId, runId: entry.runId },
    attributes: entry.payload ?? {},
    hash: entry.hash,
    prevHash: entry.prevHash,
  };
}

/** Map a whole ledger slice to a draft-conformant audit trail. */
export function toIetfAuditTrail(entries: LedgerEntry[]): IetfAuditEvent[] {
  return entries.map(toIetfAuditEvent);
}

/** The field/category mapping table, for documentation + the conformance report. */
export const IETF_MAPPING_TABLE: { native: string; ietf: string; note: string }[] = [
  { native: 'seq', ietf: 'recordId', note: 'monotonic index within the trail' },
  { native: 'ts (epoch ms)', ietf: 'time (RFC3339)', note: 'converted to ISO-8601' },
  { native: 'type', ietf: 'action + eventType', note: 'coarse category + preserved native type' },
  { native: 'agentId', ietf: 'actor.id / actor.type', note: 'human/system/agent inferred' },
  { native: 'sessionId, runId', ietf: 'context', note: 'logical grouping' },
  { native: 'payload', ietf: 'attributes', note: 'redaction-safe, free-form' },
  { native: 'hash, prevHash', ietf: 'hash, prevHash', note: 'tamper-evident linkage' },
];

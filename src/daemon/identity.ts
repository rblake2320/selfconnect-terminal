import { randomUUID } from 'node:crypto';
import type { Identity } from '../shared/contracts';

/**
 * Identity factory. Produces the sessionId/runId/agentId stamps that HARD
 * SECURITY RULE 12 requires on every non-output event. A session spans the app
 * lifetime; runs are minted per governed operation; agents are minted per
 * spawned actor (shell, review, router).
 */
export class IdentityRegistry {
  readonly sessionId: string;
  private agentIds = new Map<string, string>();

  constructor(sessionId?: string) {
    this.sessionId = sessionId ?? `sess_${randomUUID()}`;
  }

  /** Stable agent id keyed by logical name (e.g. "shell", "review"). */
  agent(name: string): string {
    let id = this.agentIds.get(name);
    if (!id) {
      id = `agent_${name}_${randomUUID().slice(0, 8)}`;
      this.agentIds.set(name, id);
    }
    return id;
  }

  /** Fresh run id for a single governed operation. */
  newRun(): string {
    return `run_${randomUUID()}`;
  }

  /** Build a full identity stamp for a given agent + run. */
  stamp(agentName: string, runId: string): Identity {
    return {
      sessionId: this.sessionId,
      runId,
      agentId: this.agent(agentName),
    };
  }
}

export function newEventId(): string {
  return `evt_${randomUUID()}`;
}

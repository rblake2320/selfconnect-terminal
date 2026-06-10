import type { AgentInfo, AgentRole, AgentState } from '../shared/contracts';

/**
 * Agent Mesh state. Tracks spawned agents, their runs, and blocked-on-approval
 * state for the dock widget. Future BPC/TSK hooks will register remote agents
 * here too.
 */
export class AgentMesh {
  private agents = new Map<string, AgentInfo>();

  register(agentId: string, role: AgentRole, readOnly: boolean): void {
    this.agents.set(agentId, { agentId, role, state: 'idle', runId: null, readOnly });
  }

  setState(agentId: string, state: AgentState, runId: string | null = null): void {
    const a = this.agents.get(agentId);
    if (!a) return;
    a.state = state;
    a.runId = runId;
  }

  snapshot(): AgentInfo[] {
    return [...this.agents.values()];
  }
}

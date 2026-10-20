import type { Projection } from '#/store/index';

export const SESSION_LOG = 'session';
export const AGENT_LOG_PREFIX = 'agents/';

export interface AgentOrigin {
  readonly agentId: string;
  readonly version: number;
}

export interface AgentInit {
  readonly source?: string;
}

export interface AgentInfo extends AgentInit {
  readonly forkedFrom?: AgentOrigin;
}

export type SessionEvent = AgentInfo & {
  readonly type: 'agent.registered';
  readonly agentId: string;
};

export interface SessionState {
  readonly agents: Readonly<Record<string, AgentInfo>>;
}

export function sessionProjection(): Projection<SessionState, SessionEvent> {
  return {
    initial: () => ({ agents: {} }),
    reduce: (state, { event }) => {
      const info: AgentInfo = { source: event.source, forkedFrom: event.forkedFrom };
      return { agents: { ...state.agents, [event.agentId]: info } };
    },
  };
}

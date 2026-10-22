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

export interface SessionMeta {
  readonly title?: string;
  readonly metadata?: Record<string, unknown>;
}

export type SessionEvent =
  | (AgentInfo & {
      readonly type: 'agent.registered';
      readonly agentId: string;
    })
  | (SessionMeta & {
      readonly type: 'session.meta_updated';
    });

export interface SessionState {
  readonly agents: Readonly<Record<string, AgentInfo>>;
  readonly meta: SessionMeta;
}

export function sessionProjection(): Projection<SessionState, SessionEvent> {
  return {
    initial: () => ({ agents: {}, meta: {} }),
    reduce: (state, { event }) => {
      if (event.type === 'agent.registered') {
        const info: AgentInfo = { source: event.source, forkedFrom: event.forkedFrom };
        return { ...state, agents: { ...state.agents, [event.agentId]: info } };
      }
      if (event.type === 'session.meta_updated') {
        const title = event.title ?? state.meta.title;
        const metadata =
          event.metadata !== undefined ? { ...state.meta.metadata, ...event.metadata } : state.meta.metadata;
        if (title === state.meta.title && metadata === state.meta.metadata) return state;
        return { ...state, meta: { title, metadata } };
      }
      return state;
    },
  };
}

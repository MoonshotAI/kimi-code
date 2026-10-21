import {
  MAIN_AGENT_ID,
  type Agent,
  type AgentInit,
  type Session,
} from '@moonshot-ai/agent-core/session/index';

import { agentCaps, createAgentRuntime, type AgentRuntime, type EnsureAgentOptions } from '#/runtime/agents';

export interface OpenAgentOptions extends EnsureAgentOptions {
  readonly init?: AgentInit;
}

export interface EnsuredAgent {
  readonly agent: Agent;
  readonly runtime: AgentRuntime;
}

export interface AppSession extends Session {
  ensureAgent(agentId?: string, opts?: OpenAgentOptions): Promise<EnsuredAgent>;
  forkAgent(sourceId: string, agentId: string, opts?: OpenAgentOptions): Promise<EnsuredAgent>;
  agentRuntime(agentId: string): AgentRuntime | undefined;
}

export function createAppSession(session: Session): AppSession {
  const runtimes = new Map<string, AgentRuntime>();
  const runtimeOf = (agentId: string, opts: EnsureAgentOptions = {}): AgentRuntime => {
    let runtime = runtimes.get(agentId);
    if (runtime === undefined) {
      runtime = createAgentRuntime(agentId, opts);
      runtimes.set(agentId, runtime);
    }
    return runtime;
  };
  return {
    get id() {
      return session.id;
    },
    get source() {
      return session.source;
    },
    get lifecycle() {
      return session.lifecycle;
    },
    get log() {
      return session.log;
    },
    get since() {
      return session.since;
    },
    get roster() {
      return session.roster;
    },
    get blobs() {
      return session.blobs;
    },
    get liveAgents() {
      return session.liveAgents;
    },
    open: (agentId, caps, init) => session.open(agentId, caps, init),
    fork: (sourceId, agentId, caps, init) => session.fork(sourceId, agentId, caps, init),
    undo: (agentId, turns) => session.undo(agentId, turns),
    status: () => session.status(),
    closeAgent: (agentId) => session.closeAgent(agentId),
    close: () => session.close(),
    ensureAgent: async (agentId = MAIN_AGENT_ID, opts = {}) => {
      const runtime = runtimeOf(agentId, opts);
      const live = session.liveAgents.get(agentId);
      if (live !== undefined) return { agent: live, runtime };
      return { agent: await session.open(agentId, agentCaps(runtime, opts), opts.init), runtime };
    },
    forkAgent: async (sourceId, agentId, opts = {}) => {
      const runtime = runtimeOf(agentId, opts);
      const agent = await session.fork(sourceId, agentId, agentCaps(runtime, opts), { source: opts.init?.source });
      return { agent, runtime };
    },
    agentRuntime: (agentId) => runtimes.get(agentId),
  };
}

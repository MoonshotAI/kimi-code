import {
  MAIN_AGENT_ID,
  type Agent,
  type AgentInit,
  type Session,
} from '@moonshot-ai/agent-core/session/index';

import type { CertainToken, FacadeToken } from '#/composition-api/index';
import type { UnitNode } from '#/composition-api/runtime';
import { agentCaps, createAgentRuntime, type AgentRuntime, type EnsureAgentOptions } from '#/runtime/agents';

export interface OpenAgentOptions extends EnsureAgentOptions {
  readonly init?: AgentInit;
}

export interface EnsuredAgent {
  readonly agent: Agent;
  readonly runtime: AgentRuntime;
  resolve<T>(token: CertainToken<T>): T;
  resolve<T>(token: FacadeToken<T>): T | undefined;
}

export interface AppSession extends Session {
  ensureAgent(agentId?: string, opts?: OpenAgentOptions): Promise<EnsuredAgent>;
  forkAgent(sourceId: string, agentId: string, opts?: OpenAgentOptions): Promise<EnsuredAgent>;
  agentRuntime(agentId: string): AgentRuntime | undefined;
  resolve<T>(token: CertainToken<T>): T;
  resolve<T>(token: FacadeToken<T>): T | undefined;
}

const sessionUnits = new WeakMap<AppSession, UnitNode>();
const agentUnits = new WeakMap<Agent, UnitNode>();

export function bindSessionUnit(session: AppSession, node: UnitNode): () => void {
  sessionUnits.set(session, node);
  return () => {
    if (sessionUnits.get(session) === node) sessionUnits.delete(session);
  };
}

export function bindAgentUnit(agent: Agent, node: UnitNode): () => void {
  agentUnits.set(agent, node);
  return () => {
    if (agentUnits.get(agent) === node) agentUnits.delete(agent);
  };
}

export function createAppSession(session: Session, ready: () => Promise<void>): AppSession {
  const runtimes = new Map<string, AgentRuntime>();
  const runtimeOf = (agentId: string, opts: EnsureAgentOptions = {}): AgentRuntime => {
    let runtime = runtimes.get(agentId);
    if (runtime === undefined) {
      runtime = createAgentRuntime(agentId, opts);
      runtimes.set(agentId, runtime);
    }
    return runtime;
  };
  const agentResolve = (agent: Agent): EnsuredAgent['resolve'] =>
    ((token: CertainToken<unknown> | FacadeToken<unknown>) => {
      const node = agentUnits.get(agent);
      if (node === undefined) {
        throw new Error(`agent '${agent.id}' of session '${session.id}' is not open`);
      }
      return token.kind === 'facade' ? node.resolve(token) : node.resolve(token);
    }) as EnsuredAgent['resolve'];
  const appSession: AppSession = {
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
    blobs: (prefix) => session.blobs(prefix),
    get liveAgents() {
      return session.liveAgents;
    },
    open: (agentId, caps, init) => session.open(agentId, caps, init),
    fork: (sourceId, agentId, caps, init) => session.fork(sourceId, agentId, caps, init),
    undo: (agentId, turns) => session.undo(agentId, turns),
    update: (patch) => session.update(patch),
    status: () => session.status(),
    closeAgent: (agentId) => session.closeAgent(agentId),
    close: () => session.close(),
    ensureAgent: async (agentId = MAIN_AGENT_ID, opts = {}) => {
      const runtime = runtimeOf(agentId, opts);
      const live = session.liveAgents.get(agentId);
      if (live !== undefined) {
        await ready();
        return { agent: live, runtime, resolve: agentResolve(live) };
      }
      const agent = await session.open(agentId, agentCaps(runtime, opts), opts.init);
      await ready();
      return { agent, runtime, resolve: agentResolve(agent) };
    },
    forkAgent: async (sourceId, agentId, opts = {}) => {
      const runtime = runtimeOf(agentId, opts);
      const agent = await session.fork(sourceId, agentId, agentCaps(runtime, opts), { source: opts.init?.source });
      await ready();
      return { agent, runtime, resolve: agentResolve(agent) };
    },
    agentRuntime: (agentId) => runtimes.get(agentId),
    resolve: ((token: CertainToken<unknown> | FacadeToken<unknown>) => {
      const node = sessionUnits.get(appSession);
      if (node === undefined) throw new Error(`session '${session.id}' is not open`);
      return token.kind === 'facade' ? node.resolve(token) : node.resolve(token);
    }) as AppSession['resolve'],
  };
  return appSession;
}

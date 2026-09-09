import type { ActorRefFrom } from '#/xstate2';

import { loadAgentState, type LoadedAgentState } from '#/agent/replay';
import { persistAgent, type AgentPersistence } from '#/persist/agent';
import type { Branch } from '#/store/branch';
import type { Tree } from '#/store/tree';

import type { AgentActorRef, createSessionMachine } from '#/session/machine';

type SessionActor = ActorRefFrom<ReturnType<typeof createSessionMachine>>;

export interface PersistSessionOptions {
  states?: (agentId: string) => Record<string, () => unknown>;
  branches?: ReadonlyMap<string, string>;
  onError?: (error: unknown) => void;
}

export interface SessionPersistence {
  flush(): Promise<void>;
  dispose(): void;
}

export interface LoadedSessionAgent extends LoadedAgentState {
  agentId: string;
  branch: string;
}

export interface LoadedSessionState {
  agents: LoadedSessionAgent[];
  meta?: unknown;
}

interface AgentHandle {
  persistence: AgentPersistence;
  branch: Branch;
}

export const SESSION_LOG_BRANCH = '_session';
export const SESSION_AGENT_OPEN_ENTRY_TYPE = 'agent.open';
export const SESSION_META_ENTRY_TYPE = 'session.meta';
const CLOSE_ENTRY_TYPE = 'agent.close';
const SWITCH_ENTRY_TYPE = 'agent.switch';

export function persistSession(
  session: SessionActor,
  tree: Tree,
  opts?: PersistSessionOptions,
): SessionPersistence {
  const report = opts?.onError ?? ((error: unknown) => console.error(error));
  const handles = new Map<string, AgentHandle>();
  let logBranch: Branch | undefined;

  const log = (): Branch => {
    logBranch ??= tree.has(SESSION_LOG_BRANCH)
      ? tree.openBranch(SESSION_LOG_BRANCH)
      : tree.createBranch(SESSION_LOG_BRANCH);
    return logBranch;
  };

  const attach = (
    agentId: string,
    ref: AgentActorRef,
    branch: Branch,
    persistedMessages?: number,
  ): void => {
    const persistence = persistAgent(ref, branch, {
      states: opts?.states?.(agentId),
      onError: report,
      persistedMessages,
    });
    handles.set(agentId, { persistence, branch });
  };

  const attachCreated = (agentId: string, branchId: string, ref: AgentActorRef): void => {
    const mapped = opts?.branches?.get(agentId);
    if (mapped !== undefined) {
      attach(agentId, ref, tree.openBranch(mapped));
      return;
    }
    if (tree.has(branchId)) {
      report(new Error(`branch '${branchId}' already exists for agent '${agentId}'`));
      return;
    }
    const branch = tree.createBranch(branchId);
    void log()
      .append({ type: SESSION_AGENT_OPEN_ENTRY_TYPE, kind: 'session', data: { agentId, branch: branch.name } })
      .catch(report);
    attach(agentId, ref, branch);
  };

  const attachForked = (
    sourceId: string,
    agentId: string,
    branchId: string,
    ref: AgentActorRef,
  ): void => {
    const source = handles.get(sourceId);
    if (source === undefined) {
      report(new Error(`cannot persist fork of unknown agent '${sourceId}'`));
      return;
    }
    if (tree.has(branchId)) {
      report(new Error(`branch '${branchId}' already exists for agent '${agentId}'`));
      return;
    }
    const head = source.branch.head;
    const branch =
      head === null
        ? tree.createBranch(branchId)
        : tree.createBranch(branchId, { from: { branch: source.branch.name, seq: head } });
    void log()
      .append({ type: SESSION_AGENT_OPEN_ENTRY_TYPE, kind: 'session', data: { agentId, branch: branch.name } })
      .catch(report);
    attach(agentId, ref, branch, source.persistence.persistedMessages);
  };

  const attachSwitched = (agentId: string, branchId: string, reason?: string): void => {
    const entry = session.getSnapshot().context.agents[agentId];
    if (entry === undefined) return;
    const previous = handles.get(agentId);
    const from =
      previous === undefined
        ? null
        : { branch: previous.branch.name, seq: previous.branch.head };
    previous?.persistence.dispose();
    attach(agentId, entry.ref, tree.openBranch(branchId));
    void log()
      .append({
        type: SWITCH_ENTRY_TYPE,
        kind: 'session',
        data: { agentId, branch: branchId, reason, from },
      })
      .catch(report);
  };

  const detach = (agentId: string): void => {
    const handle = handles.get(agentId);
    if (handle === undefined) return;
    handles.delete(agentId);
    handle.persistence.dispose();
    void log().append({ type: CLOSE_ENTRY_TYPE, kind: 'session', data: { agentId } }).catch(report);
  };

  for (const [agentId, entry] of Object.entries(session.getSnapshot().context.agents)) {
    attachCreated(agentId, entry.ref.getSnapshot().context.branchId, entry.ref);
  }

  const subscriptions = [
    session.on('agent.created', (event) => {
      if (event.type !== 'agent.created') return;
      attachCreated(event.agentId, event.branchId, event.ref);
    }),
    session.on('agent.forked', (event) => {
      if (event.type !== 'agent.forked') return;
      attachForked(event.sourceId, event.agentId, event.branchId, event.ref);
    }),
    session.on('agent.switched', (event) => {
      if (event.type !== 'agent.switched') return;
      attachSwitched(event.agentId, event.branchId, event.reason);
    }),
    session.on('agent.stopped', (event) => {
      if (event.type !== 'agent.stopped') return;
      detach(event.agentId);
    }),
  ];

  return {
    flush: async () => {
      await Promise.all([...handles.values()].map((handle) => handle.persistence.flush()));
      await logBranch?.settled();
    },
    dispose: () => {
      for (const subscription of subscriptions) {
        subscription.unsubscribe();
      }
      for (const handle of handles.values()) {
        handle.persistence.dispose();
      }
      handles.clear();
    },
  };
}

export async function loadSessionState(tree: Tree): Promise<LoadedSessionState> {
  const agents: LoadedSessionAgent[] = [];
  if (!tree.has(SESSION_LOG_BRANCH)) return { agents };
  const open = new Map<string, string>();
  let meta: unknown;
  const entries = [...tree.openBranch(SESSION_LOG_BRANCH).walk()].toReversed();
  for (const entry of entries) {
    const data = await tree.resolve(entry);
    if (entry.type === SESSION_AGENT_OPEN_ENTRY_TYPE || entry.type === SWITCH_ENTRY_TYPE) {
      const opened = data as { agentId: string; branch: string };
      open.set(opened.agentId, opened.branch);
    } else if (entry.type === CLOSE_ENTRY_TYPE) {
      const closed = data as { agentId: string };
      open.delete(closed.agentId);
    } else if (entry.type === SESSION_META_ENTRY_TYPE) {
      meta = data;
    }
  }
  for (const [agentId, branch] of [...open.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    const loaded = await loadAgentState(tree, branch);
    agents.push({ agentId, branch, ...loaded });
  }
  return meta === undefined ? { agents } : { agents, meta };
}

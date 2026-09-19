import { openBlobs, type BlobBackend, type Blobs } from '#/store/blob';
import { NodeBackend } from '#/store/node';
import { openStore, type Journal, type Store, type Projection } from '#/store/store';
import { decodeRecord, treeJournal, type BranchJournal, type RecordEvent } from '#/store/journal';
import { StoreError, Trees, type Branch, type BranchRef, type Tree, type TreeBackend } from '#/store/tree';
import { openAgentStore, type AgentStore } from '#/stores/agent';

export type AgentOpened = {
  readonly type: 'agent.opened';
  readonly time?: number;
  readonly agentId: string;
  readonly branch: string;
};

export type AgentClosed = {
  readonly type: 'agent.closed';
  readonly time?: number;
  readonly agentId: string;
};

export type AgentSwitched = {
  readonly type: 'agent.switched';
  readonly time?: number;
  readonly agentId: string;
  readonly branch: string;
  readonly reason?: string;
  readonly stats?: Record<string, number>;
};

export type SessionMetaUpdated = {
  readonly type: 'session.meta_updated';
  readonly time?: number;
  readonly meta: unknown;
};

export type SessionEvent = AgentOpened | AgentClosed | AgentSwitched | SessionMetaUpdated;

const sessionTypes = new Set<SessionEvent['type']>([
  'agent.opened',
  'agent.closed',
  'agent.switched',
  'session.meta_updated',
]);

export function decodeSession(record: RecordEvent): SessionEvent | undefined {
  return decodeRecord<SessionEvent>(record, sessionTypes);
}

export interface SessionLogState {
  readonly roster: { agents: Record<string, string> };
  readonly sessionMeta: { value: unknown };
}

export function session<C>(): Projection<SessionLogState, RecordEvent, C> {
  return {
    initial: () => ({ roster: { agents: {} }, sessionMeta: { value: undefined } }),
    reduce: (state, record) => {
      const event = decodeSession(record);
      if (event === undefined) return state;
      if (event.type === 'agent.opened') {
        return { ...state, roster: { agents: { ...state.roster.agents, [event.agentId]: event.branch } } };
      }
      if (event.type === 'agent.switched') {
        return { ...state, roster: { agents: { ...state.roster.agents, [event.agentId]: event.branch } } };
      }
      if (event.type === 'agent.closed') {
        const agents = { ...state.roster.agents };
        delete agents[event.agentId];
        return { ...state, roster: { agents } };
      }
      if (event.type === 'session.meta_updated') {
        return { ...state, sessionMeta: { value: event.meta } };
      }
      return state;
    },
  };
}

export const SESSION_TREE_NAME = 'session';
export const SESSION_LOG_BRANCH = '_session';

export type SessionStore<C = BranchRef> = Store<SessionLogState, RecordEvent, C>;

export function openSessionStore<C>(journal: Journal<RecordEvent, C>): Promise<SessionStore<C>> {
  return openStore({ journal, projection: session<C>() });
}

export type UndoErrorReason = 'unknown-agent' | 'invalid-count' | 'insufficient';

export class UndoError extends Error {
  readonly reason: UndoErrorReason;

  constructor(reason: UndoErrorReason, message: string) {
    super(message);
    this.name = 'UndoError';
    this.reason = reason;
  }
}

export function isValidUndoCount(count: number): boolean {
  return Number.isSafeInteger(count) && count > 0;
}

export function freshBranchName(tree: Tree, agentId: string): string {
  if (!tree.has(agentId)) return agentId;
  let n = 2;
  while (tree.has(`${agentId}~${n}`)) n += 1;
  return `${agentId}~${n}`;
}

function undoForkRef(tree: Tree, start: BranchRef): BranchRef | undefined {
  if (start.seq > 0) return { branch: start.branch, seq: start.seq - 1 };
  const header = tree.openBranch(start.branch).header;
  if (header.parentBranch !== undefined && header.parentSeq !== undefined) {
    return { branch: header.parentBranch, seq: header.parentSeq };
  }
  return undefined;
}

interface OpenedAgent {
  readonly store: AgentStore;
  readonly journal: BranchJournal;
}

export interface SessionStores {
  readonly tree: Tree;
  readonly blobs: Blobs;
  readonly session: SessionStore;
  get(agentId: string): AgentStore | undefined;
  branch(agentId: string): string | undefined;
  open(agentId: string, opts?: { from?: BranchRef }): Promise<AgentStore>;
  fork(sourceId: string, agentId: string): Promise<AgentStore>;
  close(agentId: string): Promise<void>;
  undo(agentId: string, turns: number): Promise<{ branchId: string }>;
  switchBranch(
    agentId: string,
    opts: { reason: string; stats?: Record<string, number>; seed: readonly RecordEvent[] },
  ): Promise<{ branchId: string }>;
  flush(): Promise<void>;
  dispose(): Promise<void>;
}

export async function openSessionStores(tree: Tree, blobs: Blobs): Promise<SessionStores> {
  const agents = new Map<string, OpenedAgent>();
  const logBranch = tree.has(SESSION_LOG_BRANCH)
    ? tree.openBranch(SESSION_LOG_BRANCH)
    : tree.createBranch(SESSION_LOG_BRANCH);
  const journal = treeJournal(tree, logBranch);
  const session = await openSessionStore(journal);

  const open = async (agentId: string, opts?: { from?: BranchRef }): Promise<AgentStore> => {
    const existing = agents.get(agentId);
    if (existing !== undefined) {
      return existing.store;
    }
    const registered = session.getState().roster.agents[agentId];
    let branch: Branch;
    if (registered !== undefined) {
      branch = tree.openBranch(registered);
    } else if (tree.has(agentId)) {
      branch = tree.openBranch(agentId);
    } else {
      branch = tree.createBranch(
        agentId,
        opts?.from !== undefined ? { from: opts.from } : undefined,
      );
    }
    const agentJournal = treeJournal(tree, branch);
    const store = await openAgentStore(agentJournal);
    agents.set(agentId, { store, journal: agentJournal });
    if (registered === undefined) {
      await session.dispatch({ type: 'agent.opened', agentId, branch: branch.name });
    }
    return store;
  };

  return {
    tree,
    blobs,
    session,
    get: (agentId) => agents.get(agentId)?.store,
    branch: (agentId) => agents.get(agentId)?.journal.branch,
    open,
    fork: async (sourceId, agentId) => {
      const source = agents.get(sourceId);
      if (source === undefined) {
        throw new StoreError('unknown-agent', `unknown agent '${sourceId}'`);
      }
      const sourceBranch = tree.openBranch(source.journal.branch);
      const head = sourceBranch.head;
      return open(
        agentId,
        head === null ? undefined : { from: { branch: sourceBranch.name, seq: head } },
      );
    },
    close: async (agentId) => {
      const opened = agents.get(agentId);
      if (opened === undefined) return;
      agents.delete(agentId);
      await opened.store.close();
      await session.dispatch({ type: 'agent.closed', agentId });
    },
    undo: async (agentId, turns) => {
      const opened = agents.get(agentId);
      if (opened === undefined) {
        throw new UndoError('unknown-agent', `unknown agent: '${agentId}'`);
      }
      if (!isValidUndoCount(turns)) {
        throw new UndoError('invalid-count', `invalid undo count: ${turns}`);
      }
      const index = opened.store.getState().turnIndex.turns;
      const cut = index.at(-turns);
      if (cut === undefined) {
        throw new UndoError('insufficient', `cannot undo ${turns} turn(s): not enough turns`);
      }
      const from = undoForkRef(tree, cut.start);
      if (from === undefined) {
        throw new UndoError('insufficient', `cannot undo ${turns} turn(s): no earlier history`);
      }
      const branchId = freshBranchName(tree, agentId);
      await opened.store.refresh(() => opened.journal.create(branchId, from));
      await session.dispatch({ type: 'agent.switched', agentId, branch: branchId, reason: 'undo' });
      return { branchId };
    },
    switchBranch: async (agentId, opts) => {
      const opened = agents.get(agentId);
      if (opened === undefined) {
        throw new StoreError('unknown-agent', `unknown agent '${agentId}'`);
      }
      const branchId = freshBranchName(tree, agentId);
      await opened.store.refresh(() => opened.journal.create(branchId));
      if (opts.seed.length > 0) await opened.store.dispatch([...opts.seed]);
      await session.dispatch({
        type: 'agent.switched',
        agentId,
        branch: branchId,
        reason: opts.reason,
        stats: opts.stats,
      });
      return { branchId };
    },
    flush: async () => {
      await Promise.all([...agents.values()].map((opened) => opened.journal.settled()));
      await journal.settled();
    },
    dispose: async () => {
      await Promise.all([...agents.values()].map((opened) => opened.store.close()));
      agents.clear();
      await session.close();
    },
  };
}

export interface SessionContainer {
  readonly trees: TreeBackend;
  readonly blobs: BlobBackend;
}

export interface OpenSessionTreeOptions {
  treeName?: string;
  fsync?: boolean;
}

export interface OpenedSessionTree {
  trees: Trees;
  tree: Tree;
  stores: SessionStores;
}

export async function openSessionContainer(
  container: SessionContainer,
  opts?: OpenSessionTreeOptions,
): Promise<OpenedSessionTree> {
  const trees = await Trees.open(container.trees, { fsync: opts?.fsync ?? false });
  const blobs = openBlobs(container.blobs);
  const tree = await trees.tree(opts?.treeName ?? SESSION_TREE_NAME);
  return { trees, tree, stores: await openSessionStores(tree, blobs) };
}

export function openSessionTree(dir: string, opts?: OpenSessionTreeOptions): Promise<OpenedSessionTree> {
  return openSessionContainer(new NodeBackend(dir), opts);
}

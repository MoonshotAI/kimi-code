import { createEventStore, type EventStore } from '#/eventStore/eventStore';
import type { ExternalEvent } from '#/eventStore/events';
import { journalFromBranch } from '#/eventStore/journal';
import { agentSlices, type AgentEventStore } from '#/agent/slices';
import type { StoreBackend } from '#/store/backend/backend';
import { StoreError, type BranchRef } from '#/store/types';
import type { Tree } from '#/store/tree';

import { agentClosed, agentOpened, agentSwitched, SESSION_LOG_BRANCH } from './events';
import { sessionSlices } from './slices';

export type SessionStore = EventStore<typeof sessionSlices>;

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

export class SessionStores {
  private readonly agents = new Map<string, AgentEventStore>();
  private sessionStore: SessionStore | undefined;

  constructor(
    readonly tree: Tree,
    readonly backend: StoreBackend,
  ) {}

  get(agentId: string): AgentEventStore | undefined {
    return this.agents.get(agentId);
  }

  async session(): Promise<SessionStore> {
    if (this.sessionStore === undefined) {
      const branch = this.tree.has(SESSION_LOG_BRANCH)
        ? this.tree.openBranch(SESSION_LOG_BRANCH)
        : this.tree.createBranch(SESSION_LOG_BRANCH);
      this.sessionStore = await createEventStore({
        journal: journalFromBranch(branch, this.tree),
        slices: sessionSlices,
      });
    }
    return this.sessionStore;
  }

  async open(agentId: string, opts?: { from?: BranchRef }): Promise<AgentEventStore> {
    const existing = this.agents.get(agentId);
    if (existing !== undefined) {
      return existing;
    }
    const existed = this.tree.has(agentId);
    const branch = existed
      ? this.tree.openBranch(agentId)
      : this.tree.createBranch(agentId, opts?.from !== undefined ? { from: opts.from } : undefined);
    const engine = await createEventStore({
      journal: journalFromBranch(branch, this.tree),
      slices: agentSlices,
    });
    this.agents.set(agentId, engine);
    if (!existed) {
      await (await this.session()).dispatch(agentOpened({ agentId, branch: branch.name }));
    }
    return engine;
  }

  async fork(sourceId: string, agentId: string): Promise<AgentEventStore> {
    const source = this.agents.get(sourceId);
    if (source === undefined) {
      throw new StoreError('unknown-agent', `unknown agent '${sourceId}'`);
    }
    const sourceBranch = this.tree.openBranch(source.ref.branch);
    const head = sourceBranch.head;
    return this.open(
      agentId,
      head === null ? undefined : { from: { branch: sourceBranch.name, seq: head } },
    );
  }

  async close(agentId: string): Promise<void> {
    const store = this.agents.get(agentId);
    if (store === undefined) return;
    this.agents.delete(agentId);
    await store.close();
    await (await this.session()).dispatch(agentClosed({ agentId }));
  }

  async undo(agentId: string, turns: number): Promise<{ branchId: string }> {
    const store = this.agents.get(agentId);
    if (store === undefined) {
      throw new UndoError('unknown-agent', `unknown agent: '${agentId}'`);
    }
    if (!isValidUndoCount(turns)) {
      throw new UndoError('invalid-count', `invalid undo count: ${turns}`);
    }
    const index = store.slice('turnIndex').turns;
    const cut = index.at(-turns);
    if (cut === undefined) {
      throw new UndoError('insufficient', `cannot undo ${turns} turn(s): not enough turns`);
    }
    const from = undoForkRef(this.tree, cut.start);
    if (from === undefined) {
      throw new UndoError('insufficient', `cannot undo ${turns} turn(s): no earlier history`);
    }
    const branchId = freshBranchName(this.tree, agentId);
    const branch = this.tree.createBranch(branchId, { from });
    await store.reset(journalFromBranch(branch, this.tree));
    await (
      await this.session()
    ).dispatch(agentSwitched({ agentId, branch: branchId, reason: 'undo' }));
    return { branchId };
  }

  async switchBranch(
    agentId: string,
    opts: { reason: string; stats?: Record<string, number>; seed: readonly ExternalEvent[] },
  ): Promise<{ branchId: string }> {
    const store = this.agents.get(agentId);
    if (store === undefined) {
      throw new StoreError('unknown-agent', `unknown agent '${agentId}'`);
    }
    const branchId = freshBranchName(this.tree, agentId);
    const branch = this.tree.createBranch(branchId);
    const journal = journalFromBranch(branch, this.tree);
    const seedStore = await createEventStore({ journal, slices: agentSlices });
    try {
      await seedStore.dispatch([...opts.seed]);
      await seedStore.flush();
    } finally {
      await seedStore.close();
    }
    await store.reset(journal);
    await (await this.session()).dispatch(
      agentSwitched({ agentId, branch: branchId, reason: opts.reason, stats: opts.stats }),
    );
    return { branchId };
  }

  async flush(): Promise<void> {
    await Promise.all([...this.agents.values()].map((store) => store.flush()));
    await this.sessionStore?.flush();
  }

  async dispose(): Promise<void> {
    await Promise.all([...this.agents.values()].map((store) => store.close()));
    this.agents.clear();
    await this.sessionStore?.close();
    this.sessionStore = undefined;
  }
}

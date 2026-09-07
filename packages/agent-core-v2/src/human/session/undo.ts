import type { ActorRefFrom } from '#/xstate2';

import { loadAgentState, type LoadedAgentState } from '#/agent/replay';
import type { HistoryMessage, UserMeta } from '#/agent/turn';
import type { Branch } from '#/store/branch';
import type { Tree } from '#/store/tree';
import type { BranchRef, BranchHeader } from '#/store/types';

import type { createSessionMachine } from '#/session/machine';

type SessionActor = ActorRefFrom<ReturnType<typeof createSessionMachine>>;

export type UndoErrorReason = 'unknown-agent' | 'invalid-count' | 'busy' | 'insufficient';

export class UndoError extends Error {
  readonly reason: UndoErrorReason;

  constructor(reason: UndoErrorReason, message: string) {
    super(message);
    this.name = 'UndoError';
    this.reason = reason;
  }
}

export interface UndoResult extends LoadedAgentState {
  agentId: string;
  branchId: string;
}

export function isUndoAnchor(entry: HistoryMessage): boolean {
  if (entry.message.role !== 'user') return false;
  const source = (entry.meta as UserMeta).source;
  return source === undefined || source === 'input';
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

export async function findUndoCut(
  tree: Tree,
  start: Branch,
  turns: number,
): Promise<BranchRef | null> {
  let remaining = turns;
  let branch: Branch | undefined = start;
  let from: number | null = start.head;
  while (branch !== undefined) {
    for (let seq = from ?? -1; seq >= 0; seq--) {
      const entry = branch.entryAt(seq);
      if (entry === null || entry.type !== 'message') continue;
      const data = await tree.resolve(entry);
      if (!isUndoAnchor(data as HistoryMessage)) continue;
      remaining -= 1;
      if (remaining > 0) continue;
      if (seq > 0) return { branch: branch.name, seq: seq - 1 };
      const { parentBranch, parentSeq } = branch.header;
      if (parentBranch !== undefined && parentSeq !== undefined) {
        return { branch: parentBranch, seq: parentSeq };
      }
      return null;
    }
    const header: BranchHeader = branch.header;
    const next: Branch | undefined =
      header.parentBranch !== undefined &&
      header.parentSeq !== undefined &&
      tree.has(header.parentBranch)
        ? tree.openBranch(header.parentBranch)
        : undefined;
    from = header.parentSeq ?? null;
    branch = next;
  }
  throw new UndoError('insufficient', `cannot undo ${turns} turn(s): not enough anchors`);
}

export async function undoAgentTurns(
  session: SessionActor,
  tree: Tree,
  agentId: string,
  turns: number,
): Promise<UndoResult> {
  const entry = session.getSnapshot().context.agents[agentId];
  if (entry === undefined) {
    throw new UndoError('unknown-agent', `unknown agent: '${agentId}'`);
  }
  if (!isValidUndoCount(turns)) {
    throw new UndoError('invalid-count', `invalid undo count: ${turns}`);
  }
  const snapshot = entry.ref.getSnapshot();
  if (!snapshot.matches('idle')) {
    throw new UndoError('busy', `agent is busy: '${agentId}'`);
  }
  if (!tree.has(snapshot.context.branchId)) {
    throw new UndoError('insufficient', `cannot undo ${turns} turn(s): not enough anchors`);
  }
  const branch = tree.openBranch(snapshot.context.branchId);
  await branch.settled();
  const cut = await findUndoCut(tree, branch, turns);
  const branchId = freshBranchName(tree, agentId);
  tree.createBranch(branchId, cut === null ? undefined : { from: cut });
  const loaded = await loadAgentState(tree, branchId);
  session.send({
    type: 'agent.switch',
    agentId,
    input: { branchId, history: loaded.messages, turnId: loaded.turnId, reason: 'undo' },
  });
  if (entry.ref.getSnapshot().context.branchId !== branchId) {
    throw new UndoError('busy', `agent is busy: '${agentId}'`);
  }
  return { agentId, branchId, ...loaded };
}

import type { HistoryMessage } from '#/agent/turn';
import type { Tree } from '#/store/tree';

export type TurnOutcome = 'done' | 'failed' | 'aborted';

export type TurnEntryData =
  | { phase: 'start'; turnId: number }
  | { phase: 'end'; turnId?: number; outcome: TurnOutcome };

export interface StateEntryData {
  name: string;
  value: unknown;
}

export interface LoadedAgentState {
  messages: HistoryMessage[];
  turnId: number;
  states: Record<string, unknown>;
}

export async function loadAgentState(tree: Tree, branch: string): Promise<LoadedAgentState> {
  const loadedBranch = tree.openBranch(branch);
  const entries = [...loadedBranch.walk()].toReversed();
  const messages: HistoryMessage[] = [];
  let turnId = 0;
  const states: Record<string, unknown> = {};
  for (const entry of entries) {
    const data = await tree.resolve(entry);
    if (entry.type === 'message') {
      messages.push(data as HistoryMessage);
    } else if (entry.type === 'turn') {
      const turn = data as TurnEntryData;
      if (turn.phase === 'start') turnId = Math.max(turnId, turn.turnId);
    } else if (entry.type === 'state') {
      const state = data as StateEntryData;
      states[state.name] = state.value;
    }
  }
  return { messages, turnId, states };
}

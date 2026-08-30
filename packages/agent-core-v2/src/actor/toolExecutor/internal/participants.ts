import { toDisposable, type IDisposable } from '#/_base/di/lifecycle';
import { OrderedHookSlot } from '#/hooks';
import {
  PERMISSION_GATE_PARTICIPANT,
  TOOL_DEDUPE_PARTICIPANT,
  type ToolDidExecuteHook,
  type ToolExecutionParticipationOrder,
} from '#/actor/toolExecutor/toolExecutor';
import type { ToolDidExecuteContext } from '#/actor/toolExecutor/toolHooks';

export const VETO_PARTICIPANT_ORDER: readonly string[] = [
  'externalHooks',
  'plan',
  'swarm',
  'staleGuard',
  'tower-tool-guard',
  'tower-todolist-guard',
  'tower-worktree-guard',
  TOOL_DEDUPE_PARTICIPANT,
  PERMISSION_GATE_PARTICIPANT,
  'goal-approval',
  'goal-veto',
  'btw',
];

export const DID_HOOK_PARTICIPANT_ORDER: readonly string[] = [
  'externalHooks',
  'prompt-service-delivery',
  'staleGuard',
  TOOL_DEDUPE_PARTICIPANT,
  'agentsMdReminder',
  'goal-outcome-tool-result',
];

export function participantRank(
  order: readonly string[],
  name: string,
  position: 'prePolicy' | 'postPolicy',
): number {
  const index = order.indexOf(name);
  if (index >= 0) return index;
  if (position === 'postPolicy') return order.length;
  return order.indexOf(TOOL_DEDUPE_PARTICIPANT) - 0.5;
}

export function insertIndexByRank(ranks: readonly number[], rank: number): number {
  let index = ranks.length;
  while (index > 0 && ranks[index - 1]! > rank) index -= 1;
  return index;
}

export class DidExecuteHookRegistry {
  readonly hooks = new OrderedHookSlot<ToolDidExecuteContext>();
  private readonly entries: Array<{ readonly name: string; readonly rank: number }> = [];

  get order(): readonly string[] {
    return this.entries.map((entry) => entry.name);
  }

  register(
    name: string,
    hook: ToolDidExecuteHook,
    order: ToolExecutionParticipationOrder = 'prePolicy',
  ): IDisposable {
    const existingIndex = this.entries.findIndex((entry) => entry.name === name);
    if (existingIndex >= 0) this.entries.splice(existingIndex, 1);
    const entry = {
      name,
      rank: participantRank(DID_HOOK_PARTICIPANT_ORDER, name, order),
    };
    const insertAt = insertIndexByRank(
      this.entries.map((existing) => existing.rank),
      entry.rank,
    );
    this.entries.splice(insertAt, 0, entry);
    const successor = this.entries[insertAt + 1];
    const registration = this.hooks.register(
      name,
      hook,
      successor === undefined ? {} : { before: successor.name },
    );
    return toDisposable(() => {
      registration.dispose();
      const index = this.entries.indexOf(entry);
      if (index >= 0) this.entries.splice(index, 1);
    });
  }
}

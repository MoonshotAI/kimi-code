import {
  PERMISSION_GATE_PARTICIPANT,
  TOOL_DEDUPE_PARTICIPANT,
} from '#/features/toolExecutor/toolExecutor';

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

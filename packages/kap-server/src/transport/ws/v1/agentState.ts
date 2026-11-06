import {
  IAgentFullCompactionService,
  IAgentLoopService,
  IAgentGoalService,
  IAgentPermissionModeService,
  IAgentProfileService,
  IAgentStateService,
  IAgentSwarmService,
  IAgentTodoService,
  IAgentTowerService,
  planKey,
  type IAgentScopeHandle,
  type PromptOrigin,
  type ServiceIdentifier,
} from '@moonshot-ai/agent-core-v2';

import type {
  AgentState,
  GoalState,
  QueuedInput,
  TodoItemState,
  UsageState,
} from '../../../protocol/ws-agent';
import { readLegacyStatus } from '../../../services/legacyStatus/legacyStatus';
import { projectUserContent } from '../../../services/messages/messageProjection';

export function readAgentState(handle: IAgentScopeHandle, running: boolean): AgentState {
  const profile = optionalService(handle, IAgentProfileService);
  const model = profile?.getModel() ?? '';
  return {
    status: running ? 'running' : 'idle',
    compacting: (optionalService(handle, IAgentFullCompactionService)?.compacting ?? null) !== null,
    model: text(model),
    thinking: model === '' ? undefined : text(profile?.getEffectiveThinkingLevel()),
    permission_mode: optionalService(handle, IAgentPermissionModeService)?.mode,
    plan_mode: planActive(handle),
    swarm_mode: optionalService(handle, IAgentSwarmService)?.isActive === true,
    tower_mode: optionalService(handle, IAgentTowerService)?.isActive === true,
  };
}

export function readUsageState(handle: IAgentScopeHandle): UsageState | undefined {
  const status = readLegacyStatus(handle);
  if (status === undefined) return undefined;
  return {
    context_tokens: Math.max(0, Math.round(status.contextTokens)),
    max_context_tokens:
      status.maxContextTokens === undefined ? undefined : Math.round(status.maxContextTokens),
  };
}

export function readGoalState(handle: IAgentScopeHandle): GoalState | undefined {
  const goal = optionalService(handle, IAgentGoalService)?.getGoal().goal ?? undefined;
  if (goal === undefined) return undefined;
  return {
    objective: goal.objective,
    status: goal.status,
    completion_criterion: text(goal.completionCriterion),
    turns_used: goal.turnsUsed,
    tokens_used: goal.tokensUsed,
    wall_clock_ms: Math.max(0, Math.round(goal.wallClockMs)),
  };
}

export function readTodoItems(handle: IAgentScopeHandle): TodoItemState[] {
  const todos = optionalService(handle, IAgentTodoService)?.get() ?? [];
  return todos.map((todo) => ({ title: todo.title, status: todo.status }));
}

export function readQueuedInputs(handle: IAgentScopeHandle): QueuedInput[] {
  const snapshot = optionalService(handle, IAgentLoopService)?.snapshot();
  if (snapshot === undefined) return [];
  return snapshot.queue.flatMap((entry): QueuedInput[] => {
    const meta = entry.meta;
    if (meta?.tracked !== true || meta.promptId === undefined || meta.promptId === snapshot.startingPromptId) return [];
    const origin = meta.origin as PromptOrigin | undefined;
    const user = origin?.kind === 'user' ? origin : undefined;
    const skills = user?.skillActivations?.map(({ skillName, skillArgs }) => ({ name: skillName, args: skillArgs }));
    return [
      {
        prompt_id: meta.promptId,
        user_message_id: meta.userMessageId ?? meta.promptId,
        kind: 'input',
        delivery: 'queue',
        content: projectUserContent({ ...entry.message, origin }),
        skills: skills !== undefined && skills.length > 0 ? skills : undefined,
        client_metadata: user?.clientMetadata?.[0],
        created_at: meta.createdAt ?? '',
      },
    ];
  });
}

function planActive(handle: IAgentScopeHandle): boolean {
  const states = optionalService(handle, IAgentStateService);
  return states?.has(planKey) === true && states.get(planKey).active;
}

export function optionalService<T>(
  handle: IAgentScopeHandle,
  id: ServiceIdentifier<T>,
): T | undefined {
  try {
    return handle.accessor.get(id) as T | undefined;
  } catch {
    return undefined;
  }
}

function text(value: string | undefined): string | undefined {
  return value === undefined || value.length === 0 ? undefined : value;
}

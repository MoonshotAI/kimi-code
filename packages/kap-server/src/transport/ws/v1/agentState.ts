import {
  IAgentFullCompactionService,
  IAgentGoalService,
  IAgentPermissionModeService,
  IAgentProfileService,
  IAgentStateService,
  IAgentSwarmService,
  IAgentTodoService,
  IAgentTowerService,
  planKey,
  type IAgentScopeHandle,
  type ServiceIdentifier,
} from '@moonshot-ai/agent-core-v2';

import type {
  AgentState,
  GoalState,
  TodoItemState,
  UsageState,
} from '../../../protocol/ws-agent';
import { readLegacyStatus } from '../../../services/legacyStatus/legacyStatus';

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

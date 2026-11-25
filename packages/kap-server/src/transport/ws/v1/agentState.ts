import {
  IAgentFullCompactionService,
  IAgentGoalService,
  IAgentPermissionModeService,
  IAgentLoopService,
  IAgentStateService,
  IAgentSwarmService,
  IAgentToolPolicyService,
  IAgentTodoService,
  IAgentTowerService,
  MAIN_AGENT_ID,
  planKey,
  type IAgentScopeHandle,
  type ServiceIdentifier,
} from '@moonshot-ai/agent-core-v2';

import type {
  AgentState,
  ContextState,
  GoalState,
  TodoItemState,
} from '../../../protocol/ws-agent';
import { missingConfiguredModelAlias, readLegacyStatus } from '../../../services/legacyStatus/legacyStatus';

export function readAgentState(handle: IAgentScopeHandle | undefined, running: boolean): AgentState {
  if (handle === undefined) {
    return {
      status: running ? 'running' : 'idle',
      compacting: false,
      plan_mode: false,
      swarm_mode: false,
      tower_mode: false,
      plan_mode_available: false,
      swarm_mode_available: false,
      tower_mode_available: false,
      goal_mode_available: false,
    };
  }
  const profile = optionalService(handle, IAgentLoopService);
  let model = profile?.getModel() ?? '';
  const isMain = handle.id === MAIN_AGENT_ID;
  if (isMain && model !== '' && missingConfiguredModelAlias(handle) !== undefined) model = '';
  const toolPolicy = optionalService(handle, IAgentToolPolicyService);
  return {
    status: running ? 'running' : 'idle',
    compacting: (optionalService(handle, IAgentFullCompactionService)?.compacting ?? null) !== null,
    model: text(model),
    thinking: model === '' ? undefined : text(profile?.getEffectiveThinkingLevel()),
    permission_mode: optionalService(handle, IAgentPermissionModeService)?.mode,
    plan_mode: planActive(handle),
    swarm_mode: optionalService(handle, IAgentSwarmService)?.isActive === true,
    tower_mode: optionalService(handle, IAgentTowerService)?.isActive === true,
    plan_mode_available: isMain && toolPolicy?.isToolActive('ExitPlanMode') === true,
    swarm_mode_available: toolPolicy?.isToolActive('AgentSwarm') === true,
    tower_mode_available: isMain && optionalService(handle, IAgentTowerService)?.toolsAvailable === true,
    goal_mode_available: isMain && toolPolicy?.isToolActive('UpdateGoal') === true,
  };
}

export function readContextState(handle: IAgentScopeHandle): ContextState | undefined {
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

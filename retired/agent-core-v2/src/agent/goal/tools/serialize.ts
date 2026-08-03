import type { GoalSnapshot, GoalToolResult } from '#/agent/goal/types';

export function goalForModel(goal: GoalSnapshot): Omit<GoalSnapshot, 'goalId'> {
  const { goalId: _goalId, ...rest } = goal;
  return rest;
}

export function goalResultForModel(
  result: GoalToolResult,
): { goal: Omit<GoalSnapshot, 'goalId'> | null } {
  return { goal: result.goal === null ? null : goalForModel(result.goal) };
}

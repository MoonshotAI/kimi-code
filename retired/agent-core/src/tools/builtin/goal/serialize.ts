import type { GoalSnapshot, GoalToolResult } from '../../../agent/goal';

/**
 * The goalId is a random UUID with no user-facing meaning, and no goal tool
 * takes one (there is only ever one goal at a time). Keep it out of what the
 * model sees so it never echoes the id back to the user as if it mattered.
 */
export function goalForModel(goal: GoalSnapshot): Omit<GoalSnapshot, 'goalId'> {
  const { goalId: _goalId, ...rest } = goal;
  return rest;
}

export function goalResultForModel(
  result: GoalToolResult,
): { goal: Omit<GoalSnapshot, 'goalId'> | null } {
  return { goal: result.goal === null ? null : goalForModel(result.goal) };
}

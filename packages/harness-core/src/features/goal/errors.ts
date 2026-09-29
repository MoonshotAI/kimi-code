export const GOAL_ALREADY_EXISTS = 'goal.already_exists';
export const GOAL_NOT_FOUND = 'goal.not_found';
export const GOAL_OBJECTIVE_EMPTY = 'goal.objective_empty';
export const GOAL_OBJECTIVE_TOO_LONG = 'goal.objective_too_long';
export const GOAL_STATUS_INVALID = 'goal.status_invalid';
export const GOAL_NOT_RESUMABLE = 'goal.not_resumable';
export const GOAL_UNSUPPORTED_AGENT = 'goal.unsupported_agent';

export class GoalError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = 'GoalError';
    this.code = code;
  }
}

export function isGoalError(error: unknown): error is GoalError {
  return error instanceof GoalError;
}

export const LOOP_MAX_STEPS_EXCEEDED_ERROR_CODE = 'loop.max_steps_exceeded';

export type TurnInterruptReason = 'max_steps' | 'error';

export class MaxStepsExceededError extends Error {
  readonly code = LOOP_MAX_STEPS_EXCEEDED_ERROR_CODE;
  readonly details: { maxSteps: number };

  constructor(maxSteps: number, message?: string) {
    super(
      message ??
        `Turn exceeded maxSteps=${maxSteps}. If max_steps_per_turn is too small, raise it in config.toml (loop_control.max_steps_per_turn), or run "/update-config" to update it, then "/reload".`,
    );
    this.name = 'MaxStepsExceededError';
    this.details = { maxSteps };
  }
}

export function isMaxStepsExceededError(error: unknown): error is MaxStepsExceededError {
  if (error instanceof MaxStepsExceededError) return true;
  return (
    typeof error === 'object' &&
    error !== null &&
    (error as { code?: unknown }).code === LOOP_MAX_STEPS_EXCEEDED_ERROR_CODE
  );
}

export function interruptReasonOf(error: unknown): TurnInterruptReason {
  return isMaxStepsExceededError(error) ? 'max_steps' : 'error';
}

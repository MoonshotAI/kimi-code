/**
 * `loop` domain error codes and loop-local error helpers.
 */

import { KimiError, registerErrorDomain, type ErrorDomain } from '#/_base/errors';

export const LoopErrors = {
  codes: {
    LOOP_MAX_STEPS_EXCEEDED: 'loop.max_steps_exceeded',
    CONTEXT_OVERFLOW: 'context.overflow',
  },
  retryable: ['context.overflow'],
  info: {
    'loop.max_steps_exceeded': {
      title: 'Loop max steps exceeded',
      retryable: false,
      public: true,
      action: 'Raise the max step limit or inspect the tool loop for non-convergence.',
    },
    'context.overflow': {
      title: 'Context overflow',
      retryable: true,
      public: true,
      action: 'Compact the conversation or retry with fewer tokens.',
    },
  },
} as const satisfies ErrorDomain;

registerErrorDomain(LoopErrors);

export function createMaxStepsExceededError(maxSteps: number, message?: string): KimiError {
  return new KimiError(
    LoopErrors.codes.LOOP_MAX_STEPS_EXCEEDED,
    message ?? `Turn exceeded maxSteps=${maxSteps}`,
    { details: { maxSteps } },
  );
}

export function isMaxStepsExceededError(error: unknown): boolean {
  return error instanceof KimiError && error.code === LoopErrors.codes.LOOP_MAX_STEPS_EXCEEDED;
}

export function isAbortError(err: unknown): boolean {
  if (err instanceof Error) {
    return err.name === 'AbortError';
  }
  return false;
}

export function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

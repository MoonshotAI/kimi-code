import type { ToolMessage } from '#/llm/message';

export interface Cause {
  readonly by?: string;
  readonly reason: string;
  readonly message?: string;
  readonly details?: Readonly<Record<string, unknown>>;
}

export const INTERRUPTED: Cause = { by: 'loop', reason: 'interrupted' };

export const STEERED: Cause = { by: 'loop', reason: 'steered' };

export const CRASHED: Cause = { by: 'loop', reason: 'crashed' };

export const CLOSED: Cause = { by: 'loop', reason: 'closed' };

export const MAX_STEPS_REASON = 'max_steps';

export interface LoopErrorOptions {
  readonly name?: string;
  readonly details?: Readonly<Record<string, unknown>>;
  readonly retryable?: boolean;
}

export class LoopError extends Error {
  readonly details?: Readonly<Record<string, unknown>>;
  readonly retryable?: boolean;

  constructor(
    readonly code: string,
    message: string,
    options: LoopErrorOptions = {},
  ) {
    super(message);
    this.name = options.name ?? 'LoopError';
    this.details = options.details;
    this.retryable = options.retryable;
  }

  toJSON(): Record<string, unknown> {
    return {
      code: this.code,
      name: this.name,
      message: this.message,
      ...(this.details === undefined ? {} : { details: this.details }),
      ...(this.retryable === undefined ? {} : { retryable: this.retryable }),
    };
  }
}

export function createMaxStepsExceededError(maxSteps: number): LoopError {
  return new LoopError(
    'loop.max_steps_exceeded',
    `Turn exceeded maxSteps=${maxSteps}. If max_steps_per_turn is too small, raise it in config.toml (loop_control.max_steps_per_turn), or run "/update-config" to update it, then "/reload".`,
    { details: { maxSteps }, retryable: false },
  );
}

export function createProviderFilteredError(): LoopError {
  return new LoopError('provider.filtered', 'Provider safety policy blocked the response.', {
    name: 'ProviderFilteredError',
    details: { finishReason: 'filtered' },
    retryable: false,
  });
}

export type TurnOutcome =
  | { readonly type: 'done'; readonly cause?: Cause }
  | { readonly type: 'failed'; readonly error?: unknown }
  | { readonly type: 'aborted'; readonly reason?: unknown }
  | { readonly type: 'blocked'; readonly at: 'turn.starting' | 'step.starting' | StepEndingPoint; readonly cause: Cause };

export type TerminalTurnOutcome = Extract<TurnOutcome, { type: 'failed' | 'aborted' }>;

export interface TurnOutcomeConvergence {
  readonly filtered?: boolean;
  readonly terminal?: TerminalTurnOutcome;
}

export function convergeTurnOutcome(outcome: TurnOutcome, convergence: TurnOutcomeConvergence = {}): TurnOutcome {
  if (outcome.type === 'aborted') return outcome;
  if (convergence.terminal !== undefined) return convergence.terminal;
  if (outcome.type === 'failed') return outcome;
  if (convergence.filtered === true) return { type: 'failed', error: createProviderFilteredError() };
  if (outcome.cause?.reason === MAX_STEPS_REASON) {
    const maxSteps = outcome.cause.details?.['maxSteps'];
    return { type: 'failed', error: createMaxStepsExceededError(typeof maxSteps === 'number' ? maxSteps : 0) };
  }
  return outcome;
}

export type StepEndingPoint = 'step.stopping' | 'step.continuing';

export type StepOutcome =
  | { readonly type: 'continue'; readonly cause?: Cause }
  | { readonly type: 'done'; readonly cause?: Cause }
  | { readonly type: 'failed'; readonly error?: unknown }
  | { readonly type: 'aborted'; readonly reason?: unknown }
  | { readonly type: 'blocked'; readonly at: 'step.starting' | StepEndingPoint; readonly cause: Cause };

export type ToolCallOutcome =
  | { readonly type: 'succeeded'; readonly message: ToolMessage }
  | { readonly type: 'failed'; readonly message: ToolMessage; readonly error: unknown }
  | { readonly type: 'aborted'; readonly message: ToolMessage; readonly reason?: unknown }
  | { readonly type: 'blocked'; readonly message: ToolMessage; readonly cause: Cause };

export type AsyncToolOutcome =
  | { readonly type: 'succeeded' }
  | { readonly type: 'failed'; readonly error: unknown }
  | { readonly type: 'aborted'; readonly reason?: unknown };

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

export const CANCELED: Cause = { by: 'loop', reason: 'canceled' };

export type TurnOutcome =
  | { readonly type: 'done'; readonly cause?: Cause }
  | { readonly type: 'failed'; readonly error?: unknown }
  | { readonly type: 'aborted'; readonly reason?: unknown }
  | { readonly type: 'blocked'; readonly at: 'turn.starting' | 'step.starting' | StepEndingPoint; readonly cause: Cause };

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

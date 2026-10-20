import type { ToolEntry } from '#/history/message';

export interface Cause {
  readonly by?: string;
  readonly reason: string;
  readonly message?: string;
  readonly details?: Readonly<Record<string, unknown>>;
}

export const INTERRUPTED: Cause = { by: 'loop', reason: 'interrupted' };

export const CRASHED: Cause = { by: 'loop', reason: 'crashed' };

export const CLOSED: Cause = { by: 'loop', reason: 'closed' };

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
  | { readonly type: 'succeeded'; readonly entry: ToolEntry; readonly stopTurn?: true }
  | { readonly type: 'failed'; readonly entry: ToolEntry; readonly error: unknown }
  | { readonly type: 'aborted'; readonly entry: ToolEntry; readonly reason?: unknown }
  | { readonly type: 'blocked'; readonly entry: ToolEntry; readonly cause: Cause };

export type AsyncToolOutcome =
  | { readonly type: 'succeeded' }
  | { readonly type: 'failed'; readonly error: unknown }
  | { readonly type: 'aborted'; readonly reason?: unknown };

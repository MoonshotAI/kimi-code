import { createUserMessage } from '#/llm/message';
import { errorText } from '#/llm/protocol/errors';
import { createUserEntry, type UserEntry } from '#/history/message';
import type { HookFailedEvent } from '../contract/emitted';
import type { HookPoint } from '../contract/hook';
import type { Cause } from '../contract/outcome';

export interface HookFailure {
  hookId?: string;
  error: unknown;
  paused: boolean;
  blocking: boolean;
}

export interface HookFailureReport {
  readonly failure: HookFailure;
  readonly entry: UserEntry;
}

export function hookFailureText(point: HookPoint, error: unknown): string {
  return `[hook failed] ${point}: ${errorText(error)}`;
}

export function hookFailureCause(point: HookPoint, error: unknown, by?: string): Cause {
  return { ...(by === undefined ? {} : { by }), reason: 'hook_failed', message: hookFailureText(point, error) };
}

export function hookFailureEntry(point: HookPoint, error: unknown): UserEntry {
  return createUserEntry(createUserMessage(hookFailureText(point, error)), { source: 'hook', key: point });
}

export function hookFailureReports(point: HookPoint, failures: readonly HookFailure[]): HookFailureReport[] {
  return failures.map((failure) => ({ failure, entry: hookFailureEntry(point, failure.error) }));
}

export function runtimeFailure(error: unknown): HookFailure {
  return { error, paused: false, blocking: false };
}

export function hookFailedEvent(
  point: HookPoint,
  turnId: number,
  step: number,
  failure: HookFailure,
): HookFailedEvent {
  return {
    type: 'hook.failed',
    point,
    hookId: failure.hookId,
    turnId,
    step,
    error: failure.error,
    paused: failure.paused,
  };
}

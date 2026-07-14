/**
 * `task` domain (L1) — managed concurrent execution primitive.
 *
 * Two creation modes:
 *
 *   - `run(fn)` — active execution: wraps an async function with
 *     `AbortSignal`, output stream, state machine, and disposal.
 *   - `defer()` — passive wait: the caller controls when the handle
 *     settles via `resolve` / `reject`.
 *
 * Consumers that need to track handles across turns (e.g. `agent/task`)
 * compose on top of these primitives; `ITaskService` itself is stateless
 * beyond the set of live handles.
 */

import { createDecorator, type ServiceIdentifier } from '#/_base/di/instantiation';
import type { Event } from '#/_base/event';
import type { IDisposable } from '#/_base/di/lifecycle';

export type TaskState = 'pending' | 'running' | 'completed' | 'failed' | 'cancelled';

export const TERMINAL_TASK_STATES: ReadonlySet<TaskState> = new Set([
  'completed',
  'failed',
  'cancelled',
]);

export class TaskCancelledError extends Error {
  constructor(readonly taskId: string) {
    super(`Task ${taskId} was cancelled`);
    this.name = 'TaskCancelledError';
  }
}

export interface ITaskHandle<T = unknown> extends IDisposable {
  readonly id: string;
  readonly state: TaskState;
  readonly result: Promise<T>;
  readonly onDidChangeState: Event<TaskState>;
  readonly onDidOutput: Event<string>;
  cancel(): void;
}

export interface IDeferredHandle<T = unknown> extends ITaskHandle<T> {
  resolve(value: T): void;
  reject(reason?: unknown): void;
}

export interface ITaskService {
  readonly _serviceBrand: undefined;

  run<T>(fn: (signal: AbortSignal, output: (data: string) => void) => Promise<T>): ITaskHandle<T>;
  defer<T>(): IDeferredHandle<T>;
}

export const ITaskService: ServiceIdentifier<ITaskService> =
  createDecorator<ITaskService>('taskService');

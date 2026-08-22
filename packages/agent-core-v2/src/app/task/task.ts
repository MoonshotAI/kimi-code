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

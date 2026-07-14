/**
 * `task` domain (L1) — `ITaskService` implementation.
 *
 * Manages task handles: each handle owns a state machine, an optional
 * `AbortController` (for `run()`), and `Emitter` pairs for state changes
 * and output. App-scoped — one instance per process.
 */

import { Emitter, type Event } from '#/_base/event';
import { InstantiationType } from '#/_base/di/extensions';
import { Disposable, markAsDisposed, trackDisposable } from '#/_base/di/lifecycle';
import { LifecycleScope, registerScopedService } from '#/_base/di/scope';

import {
  type ITaskHandle,
  type IDeferredHandle,
  ITaskService,
  type TaskState,
  TERMINAL_TASK_STATES,
  TaskCancelledError,
} from './task';

function isTerminal(state: TaskState): boolean {
  return TERMINAL_TASK_STATES.has(state);
}

class RunHandle<T> implements ITaskHandle<T> {
  private _state: TaskState = 'pending';
  private readonly _abortController = new AbortController();
  private readonly _onDidChangeState = new Emitter<TaskState>();
  readonly onDidChangeState: Event<TaskState> = this._onDidChangeState.event;
  private readonly _onDidOutput = new Emitter<string>();
  readonly onDidOutput: Event<string> = this._onDidOutput.event;
  readonly result: Promise<T>;
  private _disposed = false;

  constructor(
    readonly id: string,
    fn: (signal: AbortSignal, output: (data: string) => void) => Promise<T>,
  ) {
    trackDisposable(this);

    const output = (data: string): void => {
      if (!isTerminal(this._state) && !this._disposed) {
        this._onDidOutput.fire(data);
      }
    };

    this._transition('running');

    this.result = fn(this._abortController.signal, output).then(
      (value) => {
        if (this._abortController.signal.aborted) {
          this._transition('cancelled');
          throw new TaskCancelledError(this.id);
        }
        this._transition('completed');
        return value;
      },
      (error: unknown) => {
        if (this._abortController.signal.aborted) {
          this._transition('cancelled');
        } else {
          this._transition('failed');
        }
        throw error;
      },
    );

    void this.result.catch(() => {});
  }

  get state(): TaskState {
    return this._state;
  }

  cancel(): void {
    if (isTerminal(this._state)) return;
    this._abortController.abort(new TaskCancelledError(this.id));
    this._transition('cancelled');
  }

  dispose(): void {
    if (this._disposed) return;
    this._disposed = true;
    markAsDisposed(this);
    this.cancel();
    this._onDidChangeState.dispose();
    this._onDidOutput.dispose();
  }

  private _transition(to: TaskState): void {
    if (isTerminal(this._state)) return;
    this._state = to;
    if (!this._disposed) {
      this._onDidChangeState.fire(to);
    }
  }
}

class DeferHandle<T> implements IDeferredHandle<T> {
  private _state: TaskState = 'pending';
  private _resolvePromise!: (value: T) => void;
  private _rejectPromise!: (reason: unknown) => void;
  private readonly _onDidChangeState = new Emitter<TaskState>();
  readonly onDidChangeState: Event<TaskState> = this._onDidChangeState.event;
  private readonly _onDidOutput = new Emitter<string>();
  readonly onDidOutput: Event<string> = this._onDidOutput.event;
  readonly result: Promise<T>;
  private _disposed = false;

  constructor(readonly id: string) {
    trackDisposable(this);

    this.result = new Promise<T>((resolve, reject) => {
      this._resolvePromise = resolve;
      this._rejectPromise = reject;
    });

    void this.result.catch(() => {});
  }

  get state(): TaskState {
    return this._state;
  }

  resolve(value: T): void {
    if (isTerminal(this._state)) return;
    this._transition('completed');
    this._resolvePromise(value);
  }

  reject(reason?: unknown): void {
    if (isTerminal(this._state)) return;
    this._transition('failed');
    this._rejectPromise(reason);
  }

  cancel(): void {
    if (isTerminal(this._state)) return;
    this._transition('cancelled');
    this._rejectPromise(new TaskCancelledError(this.id));
  }

  dispose(): void {
    if (this._disposed) return;
    this._disposed = true;
    markAsDisposed(this);
    this.cancel();
    this._onDidChangeState.dispose();
    this._onDidOutput.dispose();
  }

  private _transition(to: TaskState): void {
    if (isTerminal(this._state)) return;
    this._state = to;
    if (!this._disposed) {
      this._onDidChangeState.fire(to);
    }
  }
}

export class TaskService extends Disposable implements ITaskService {
  declare readonly _serviceBrand: undefined;
  private _nextId = 0;

  run<T>(fn: (signal: AbortSignal, output: (data: string) => void) => Promise<T>): ITaskHandle<T> {
    return new RunHandle<T>(this._generateId(), fn);
  }

  defer<T>(): IDeferredHandle<T> {
    return new DeferHandle<T>(this._generateId());
  }

  private _generateId(): string {
    return `task-${this._nextId++}`;
  }
}

registerScopedService(
  LifecycleScope.App,
  ITaskService,
  TaskService,
  InstantiationType.Delayed,
  'task',
);

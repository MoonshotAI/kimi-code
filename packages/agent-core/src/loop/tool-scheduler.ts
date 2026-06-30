/**
 * Stateful execution scheduler for tool calls in one model step.
 *
 * The scheduler owns only execution ordering:
 *   - tasks with non-conflicting resource accesses may overlap
 *   - tasks with conflicting resource accesses wait for the conflicting active tasks
 *   - drained results are handed back in provider order
 *
 * Validation, hooks, event construction, and result finalization stay in
 * `tool-call.ts`.
 */

import { createControlledPromise, type ControlledPromise } from '@antfu/utils';

import { ToolAccesses } from './tool-access';

// Scheduler

export interface ToolCallTask<Result> {
  readonly accesses: ToolAccesses;
  readonly start: () => Promise<{
    readonly result: Promise<Result>;
    readonly holdAccessUntil?: Promise<unknown> | undefined;
  }>;
  readonly cancel?: (() => Result) | undefined;
}

interface ScheduledToolCallTask<Result> extends ToolCallTask<Result> {
  readonly result: ControlledPromise<Result>;
}

interface StartedToolCallTask<Result> {
  readonly result: Promise<Result>;
  readonly holdAccessUntil?: Promise<unknown> | undefined;
}

export class ToolScheduler<Result> {
  private readonly activeTasks: Array<ScheduledToolCallTask<Result>> = [];
  private queuedTasks: Array<ScheduledToolCallTask<Result>> = [];

  add(task: ToolCallTask<Result>): Promise<Result> {
    const result = createControlledPromise<Result>();
    void result.catch(() => undefined);

    const scheduledTask: ScheduledToolCallTask<Result> = { ...task, result };
    if (this.isBlocked(task, this.queuedTasks)) {
      this.queuedTasks.push(scheduledTask);
    } else {
      this.start(scheduledTask);
    }

    return result;
  }

  cancelQueued(): void {
    const queuedTasks = this.queuedTasks;
    this.queuedTasks = [];
    for (const task of queuedTasks) {
      if (task.cancel !== undefined) {
        task.result.resolve(task.cancel());
      } else {
        task.result.reject(new Error('Queued tool task was cancelled.'));
      }
    }
  }

  private isBlocked(
    task: ToolCallTask<Result>,
    queuedBefore: readonly ToolCallTask<Result>[],
  ): boolean {
    return (
      this.conflictsWithAny(task, this.activeTasks) || this.conflictsWithAny(task, queuedBefore)
    );
  }

  private conflictsWithAny(
    task: ToolCallTask<Result>,
    candidates: readonly ToolCallTask<Result>[],
  ): boolean {
    return candidates.some((candidate) =>
      ToolAccesses.conflict(task.accesses, candidate.accesses),
    );
  }

  private start(task: ScheduledToolCallTask<Result>): void {
    this.activeTasks.push(task);
    let started: Promise<StartedToolCallTask<Result>>;
    try {
      started = task.start();
    } catch (error) {
      task.result.reject(error);
      this.finish(task);
      return;
    }

    void started
      .then(({ result, holdAccessUntil }) => {
        void result.then(task.result.resolve, task.result.reject);
        return (holdAccessUntil ?? result).catch(() => undefined);
      })
      .catch((error) => {
        task.result.reject(error);
      })
      .finally(() => {
        this.finish(task);
      });
  }

  private finish(task: ScheduledToolCallTask<Result>): void {
    const index = this.activeTasks.indexOf(task);
    if (index >= 0) this.activeTasks.splice(index, 1);
    this.startQueuedTasks();
  }

  private startQueuedTasks(): void {
    const stillQueued: Array<ScheduledToolCallTask<Result>> = [];
    for (const task of this.queuedTasks) {
      if (this.isBlocked(task, stillQueued)) {
        stillQueued.push(task);
      } else {
        this.start(task);
      }
    }
    this.queuedTasks = stillQueued;
  }
}

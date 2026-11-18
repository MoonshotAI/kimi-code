import { ToolAccesses } from '#/tool/toolContract';

export interface ToolCallTask<Result> {
  readonly accesses: ToolAccesses;
  readonly signal?: AbortSignal;
  readonly start: () => Promise<{ readonly result: Promise<Result> }>;
}

interface ScheduledToolCallTask<Result> extends ToolCallTask<Result> {
  readonly result: ControlledPromise<Result>;
  queued: boolean;
  abortListener?: () => void;
}

type ControlledPromise<Result> = Promise<Result> & {
  readonly resolve: (value: Result | PromiseLike<Result>) => void;
  readonly reject: (reason?: unknown) => void;
};

export class ToolScheduler<Result = unknown> {
  private readonly activeTasks: Array<ScheduledToolCallTask<Result>> = [];
  private queuedTasks: Array<ScheduledToolCallTask<Result>> = [];

  add(task: ToolCallTask<Result>): Promise<Result> {
    if (task.signal?.aborted === true) return Promise.reject(task.signal.reason);
    const result = createControlledPromise<Result>();
    void result.catch(() => undefined);
    const scheduledTask: ScheduledToolCallTask<Result> = { ...task, result, queued: true };
    const signal = task.signal;
    if (signal !== undefined) {
      const onAbort = (): void => {
        if (!scheduledTask.queued) return;
        const index = this.queuedTasks.indexOf(scheduledTask);
        if (index >= 0) this.queuedTasks.splice(index, 1);
        scheduledTask.result.reject(signal.reason);
        this.removeAbortListener(scheduledTask);
        this.startQueuedTasks();
      };
      scheduledTask.abortListener = onAbort;
      signal.addEventListener('abort', onAbort, { once: true });
    }
    if (this.isBlocked(task, this.queuedTasks)) {
      this.queuedTasks.push(scheduledTask);
    } else {
      this.start(scheduledTask);
    }
    return result;
  }

  async lease(accesses: ToolAccesses, signal?: AbortSignal): Promise<() => void> {
    let notifyStarted!: () => void;
    let failStarted!: (reason?: unknown) => void;
    const started = new Promise<void>((resolve, reject) => {
      notifyStarted = resolve;
      failStarted = reject;
    });
    let release: () => void = () => {};
    const completed = this.add({
      accesses,
      signal,
      start: async () => {
        notifyStarted();
        return { result: new Promise<void>((resolve) => { release = resolve; }) };
      },
    } as unknown as ToolCallTask<Result>);
    void completed.catch(failStarted);
    await started;
    return () => {
      release();
      void completed;
    };
  }

  private isBlocked(
    task: ToolCallTask<Result>,
    queuedBefore: readonly ToolCallTask<Result>[],
  ): boolean {
    return this.conflictsWithAny(task, this.activeTasks) || this.conflictsWithAny(task, queuedBefore);
  }

  private conflictsWithAny(
    task: ToolCallTask<Result>,
    candidates: readonly ToolCallTask<Result>[],
  ): boolean {
    return candidates.some((candidate) => ToolAccesses.conflict(task.accesses, candidate.accesses));
  }

  private start(task: ScheduledToolCallTask<Result>): void {
    task.queued = false;
    this.removeAbortListener(task);
    this.activeTasks.push(task);
    let started: Promise<{ readonly result: Promise<Result> }>;
    try {
      started = task.start();
    } catch (error) {
      task.result.reject(error);
      this.finish(task);
      return;
    }
    void started
      .then(({ result }) => result)
      .then(task.result.resolve, task.result.reject)
      .finally(() => {
        this.finish(task);
      });
  }

  private finish(task: ScheduledToolCallTask<Result>): void {
    this.removeAbortListener(task);
    const index = this.activeTasks.indexOf(task);
    if (index >= 0) this.activeTasks.splice(index, 1);
    this.startQueuedTasks();
  }

  private removeAbortListener(task: ScheduledToolCallTask<Result>): void {
    if (task.abortListener === undefined) return;
    task.signal?.removeEventListener('abort', task.abortListener);
    task.abortListener = undefined;
  }

  private startQueuedTasks(): void {
    const stillQueued: Array<ScheduledToolCallTask<Result>> = [];
    for (const task of this.queuedTasks) {
      if (task.signal?.aborted === true) {
        task.result.reject(task.signal.reason);
        this.removeAbortListener(task);
      } else if (this.isBlocked(task, stillQueued)) {
        stillQueued.push(task);
      } else {
        this.start(task);
      }
    }
    this.queuedTasks = stillQueued;
  }
}

function createControlledPromise<Result>(): ControlledPromise<Result> {
  let resolve!: (value: Result | PromiseLike<Result>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<Result>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  }) as ControlledPromise<Result>;
  return Object.assign(promise, { resolve, reject });
}

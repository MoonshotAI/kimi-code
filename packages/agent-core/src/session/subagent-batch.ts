import { isProviderRateLimitError, type TokenUsage } from '@moonshot-ai/kosong';
import * as retry from 'retry';

import type { RunSubagentOptions, SpawnSubagentOptions, SubagentHandle } from '.';
import { isUserCancellation } from '../utils/abort';

const INITIAL_LAUNCH_LIMIT = 5;
const INITIAL_LAUNCH_INTERVAL_MS = 700;
const START_CONFIRMATION_TIMEOUT_MS = 500;
const RATE_LIMIT_RETRY_BASE_MS = 3000;
const RATE_LIMIT_RETRY_FACTOR = 2;
const RATE_LIMIT_CAPACITY_SHRINK_INTERVAL_MS = 2000;
const RATE_LIMIT_SUSPENDED_REASON = 'Provider rate limit; subagent requeued for retry.';

export type QueuedSubagentTask<T = unknown> = {
  readonly data: T;
  readonly profileName: string;
  readonly parentToolCallId: string;
  readonly parentToolCallUuid?: string;
  readonly prompt: string;
  readonly description: string;
  readonly swarmItem?: string;
  readonly runInBackground: boolean;
  readonly resumeAgentId?: string;
  readonly timeout?: number;
  readonly signal?: AbortSignal;
};

export type SubagentResult<T = unknown> = {
  readonly task: QueuedSubagentTask<T>;
  readonly agentId?: string;
  readonly status: 'completed' | 'failed' | 'aborted';
  readonly state?: 'started' | 'not_started';
  readonly result?: string;
  readonly usage?: TokenUsage;
  readonly error?: string;
};

export interface SubagentLauncher {
  spawn(options: SpawnSubagentOptions): Promise<SubagentHandle>;
  resume(agentId: string, options: RunSubagentOptions): Promise<SubagentHandle>;
  retry(agentId: string, options: RunSubagentOptions): Promise<SubagentHandle>;
  suspended?(event: SubagentSuspendedEvent): void;
}

export type SubagentSuspendedEvent = {
  readonly task: QueuedSubagentTask;
  readonly agentId: string;
  readonly reason: string;
};

type AttemptOutcome<T> =
  | SubagentResult<T>
  | {
      readonly type: 'rate_limited';
      readonly agentId?: string;
    };

type TaskState<T> = {
  readonly index: number;
  readonly task: QueuedSubagentTask<T>;
  agentId?: string;
  retryAgentId?: string;
  retryCount: number;
  retryReadyAt: number;
  started: boolean;
  readyCounted: boolean;
};

type ActiveAttempt<T> = {
  readonly id: number;
  readonly state: TaskState<T>;
  readonly controller: AbortController;
  readonly readyTimer: ReturnType<typeof setTimeout>;
  cleanup: () => void;
  agentId?: string;
  ready: boolean;
  confirmationExpired: boolean;
  timedOut: boolean;
};

export class SubagentBatch<T> {
  private readonly states: Array<TaskState<T>>;
  private readonly pending: Array<TaskState<T>>;
  private readonly results: Array<SubagentResult<T> | undefined>;
  private readonly active = new Map<number, ActiveAttempt<T>>();
  private readonly controller = new AbortController();
  private readonly batchSignal: AbortSignal | undefined;
  private readonly batchAbortListener: () => void;
  private nextAttemptId = 0;
  private normalLaunchCount = 0;
  private normalLaunchTimer: ReturnType<typeof setTimeout> | undefined;
  private rateLimitLaunchTimer: ReturnType<typeof setTimeout> | undefined;
  private resolve: ((results: Array<SubagentResult<T>>) => void) | undefined;
  private reject: ((error: unknown) => void) | undefined;
  private finished = false;
  private started = false;
  private rateLimitMode = false;
  private startedSuccessCount = 0;
  private rateLimitCapacity = 1;
  private lastCapacityShrinkAt: number | undefined;
  private globalRetryIntervalMs = RATE_LIMIT_RETRY_BASE_MS;
  private nextRateLimitLaunchAt = 0;

  constructor(
    private readonly launcher: SubagentLauncher,
    tasks: readonly QueuedSubagentTask<T>[],
  ) {
    this.states = tasks.map((task, index) => ({
      index,
      task,
      retryCount: 0,
      retryReadyAt: 0,
      started: false,
      readyCounted: false,
    }));
    this.pending = [...this.states];
    this.results = Array.from({ length: tasks.length });
    this.batchSignal = tasks.find((task) => task.signal !== undefined)?.signal;
    this.batchAbortListener = () => {
      this.controller.abort(this.batchSignal?.reason);
      if (isUserCancellation(this.batchSignal?.reason)) {
        this.finishWithUserCancellation();
      } else {
        this.fail(this.batchSignal?.reason ?? new Error('Aborted'));
      }
    };
  }

  run(): Promise<Array<SubagentResult<T>>> {
    if (this.started) {
      throw new Error('SubagentBatch.run() can only be called once.');
    }
    this.started = true;

    return new Promise((resolve, reject) => {
      this.resolve = resolve;
      this.reject = reject;

      if (this.states.length === 0) {
        this.finish([]);
        return;
      }

      if (this.batchSignal?.aborted === true) {
        this.batchAbortListener();
        return;
      }

      this.batchSignal?.addEventListener('abort', this.batchAbortListener, { once: true });
      this.schedule();
    });
  }

  private schedule(): void {
    if (this.finished) return;
    if (this.finishIfComplete()) return;
    if (this.controller.signal.aborted) return;

    if (this.rateLimitMode) {
      this.scheduleRateLimitLaunch();
    } else {
      this.scheduleNormalLaunch();
    }
  }

  private scheduleNormalLaunch(): void {
    while (
      this.normalLaunchCount < INITIAL_LAUNCH_LIMIT &&
      this.pending.length > 0 &&
      !this.rateLimitMode
    ) {
      this.startAttempt(this.pending.shift()!);
      this.normalLaunchCount += 1;
    }

    if (
      this.pending.length === 0 ||
      this.rateLimitMode ||
      this.normalLaunchTimer !== undefined
    ) {
      return;
    }

    this.normalLaunchTimer = setTimeout(() => {
      this.normalLaunchTimer = undefined;
      if (this.finished || this.rateLimitMode || this.pending.length === 0) return;
      this.startAttempt(this.pending.shift()!);
      this.normalLaunchCount += 1;
      this.schedule();
    }, INITIAL_LAUNCH_INTERVAL_MS);
  }

  private scheduleRateLimitLaunch(): void {
    this.clearRateLimitTimer();
    if (this.pending.length === 0 || this.active.size >= this.rateLimitCapacity) return;

    const now = Date.now();
    const nextAllowedAt = Math.max(this.nextRateLimitLaunchAt, this.nextPendingReadyAt());
    if (nextAllowedAt > now) {
      this.rateLimitLaunchTimer = setTimeout(() => {
        this.rateLimitLaunchTimer = undefined;
        this.schedule();
      }, nextAllowedAt - now);
      return;
    }

    const pendingIndex = this.pending.findIndex((state) => state.retryReadyAt <= now);
    if (pendingIndex === -1) return;

    const [state] = this.pending.splice(pendingIndex, 1);
    this.startAttempt(state!);
    this.nextRateLimitLaunchAt = now + this.globalRetryIntervalMs;
  }

  private startAttempt(state: TaskState<T>): void {
    if (this.finished || this.controller.signal.aborted) return;

    const attempt: ActiveAttempt<T> = {
      id: this.nextAttemptId,
      state,
      controller: new AbortController(),
      cleanup: () => {},
      ready: false,
      confirmationExpired: false,
      timedOut: false,
      readyTimer: setTimeout(() => {
        attempt.confirmationExpired = true;
      }, START_CONFIRMATION_TIMEOUT_MS),
    };
    this.nextAttemptId += 1;
    attempt.cleanup = this.linkAttemptSignals(attempt, state.task);
    this.active.set(attempt.id, attempt);

    this.runAttempt(attempt).then(
      (outcome) => {
        this.handleAttemptOutcome(attempt, outcome);
      },
      (error) => {
        this.handleAttemptError(attempt, error);
      },
    );
  }

  private async runAttempt(attempt: ActiveAttempt<T>): Promise<AttemptOutcome<T>> {
    const task = attempt.state.task;
    let handle: SubagentHandle | undefined;
    const runOptions: RunSubagentOptions = {
      parentToolCallId: task.parentToolCallId,
      parentToolCallUuid: task.parentToolCallUuid,
      prompt: task.prompt,
      description: task.description,
      runInBackground: task.runInBackground,
      signal: attempt.controller.signal,
      onReady: () => {
        this.markAttemptReady(attempt);
      },
      suppressRateLimitFailureEvent: true,
    };

    try {
      attempt.controller.signal.throwIfAborted();
      if (attempt.state.retryAgentId !== undefined) {
        handle = await this.launcher.retry(attempt.state.retryAgentId, runOptions);
      } else if (task.resumeAgentId !== undefined) {
        handle = await this.launcher.resume(task.resumeAgentId, runOptions);
      } else {
        const spawnOptions: SpawnSubagentOptions = {
          profileName: task.profileName,
          swarmItem: task.swarmItem,
          ...runOptions,
        };
        handle = await this.launcher.spawn(spawnOptions);
      }

      attempt.agentId = handle.agentId;
      attempt.state.agentId = handle.agentId;
      const completion = await handle.completion;
      return {
        task,
        agentId: handle.agentId,
        status: 'completed',
        result: completion.result,
        usage: completion.usage,
      };
    } catch (error) {
      if (isProviderRateLimitError(error)) {
        return { type: 'rate_limited', agentId: handle?.agentId ?? attempt.agentId };
      }

      const status =
        attempt.controller.signal.aborted && isUserCancellation(attempt.controller.signal.reason)
          ? 'aborted'
          : 'failed';
      return {
        task,
        agentId: handle?.agentId ?? attempt.agentId,
        status,
        state: handle === undefined && attempt.agentId === undefined ? 'not_started' : 'started',
        error: this.attemptErrorMessage(attempt, error, status),
      };
    }
  }

  private markAttemptReady(attempt: ActiveAttempt<T>): void {
    if (this.finished || attempt.ready || !this.active.has(attempt.id)) return;
    if (attempt.confirmationExpired) return;

    attempt.ready = true;
    attempt.state.started = true;
    if (!this.rateLimitMode && !attempt.state.readyCounted) {
      attempt.state.readyCounted = true;
      this.startedSuccessCount += 1;
    }

    if (this.rateLimitMode) {
      this.globalRetryIntervalMs = RATE_LIMIT_RETRY_BASE_MS;
      this.nextRateLimitLaunchAt = Date.now() + this.globalRetryIntervalMs;
      this.schedule();
    }
  }

  private handleAttemptOutcome(attempt: ActiveAttempt<T>, outcome: AttemptOutcome<T>): void {
    if (!this.releaseAttempt(attempt)) return;
    if (this.finished) return;

    if (isRateLimitedOutcome(outcome)) {
      this.requeueRateLimited(attempt, outcome.agentId);
    } else {
      this.results[attempt.state.index] = outcome;
    }
    this.schedule();
  }

  private handleAttemptError(attempt: ActiveAttempt<T>, error: unknown): void {
    if (!this.releaseAttempt(attempt)) return;
    if (this.finished) return;
    this.results[attempt.state.index] = {
      task: attempt.state.task,
      agentId: attempt.state.agentId,
      status: 'failed',
      error: error instanceof Error ? error.message : String(error),
    };
    this.schedule();
  }

  private releaseAttempt(attempt: ActiveAttempt<T>): boolean {
    const active = this.active.get(attempt.id);
    if (active !== attempt) return false;

    this.active.delete(attempt.id);
    clearTimeout(attempt.readyTimer);
    attempt.cleanup();
    return true;
  }

  private requeueRateLimited(attempt: ActiveAttempt<T>, agentId: string | undefined): void {
    const state = attempt.state;
    const knownAgentId = agentId ?? attempt.agentId ?? state.agentId;
    if (knownAgentId !== undefined) {
      state.agentId = knownAgentId;
      state.retryAgentId = knownAgentId;
      this.launcher.suspended?.({
        task: state.task,
        agentId: knownAgentId,
        reason: RATE_LIMIT_SUSPENDED_REASON,
      });
    }

    const now = Date.now();
    state.retryCount += 1;
    const retryDelay = rateLimitRetryDelayMs(state.retryCount);
    state.retryReadyAt = now + retryDelay;
    this.pending.unshift(state);
    this.enterRateLimitMode(now);

    if (!attempt.ready) {
      this.globalRetryIntervalMs = Math.max(this.globalRetryIntervalMs * 2, retryDelay);
      this.nextRateLimitLaunchAt = Math.max(
        this.nextRateLimitLaunchAt,
        now + this.globalRetryIntervalMs,
      );
    } else {
      this.nextRateLimitLaunchAt = Math.max(
        this.nextRateLimitLaunchAt,
        now + RATE_LIMIT_RETRY_BASE_MS,
      );
    }
  }

  private enterRateLimitMode(now: number): void {
    if (!this.rateLimitMode) {
      this.rateLimitMode = true;
      this.clearNormalTimer();
      this.rateLimitCapacity = Math.max(1, this.startedSuccessCount);
      this.nextRateLimitLaunchAt = Math.max(
        this.nextRateLimitLaunchAt,
        now + RATE_LIMIT_RETRY_BASE_MS,
      );
      this.shrinkRateLimitCapacity(now, true);
      return;
    }

    this.shrinkRateLimitCapacity(now, false);
  }

  private shrinkRateLimitCapacity(now: number, force: boolean): void {
    if (
      !force &&
      this.lastCapacityShrinkAt !== undefined &&
      now - this.lastCapacityShrinkAt < RATE_LIMIT_CAPACITY_SHRINK_INTERVAL_MS
    ) {
      return;
    }

    this.rateLimitCapacity = Math.max(1, this.rateLimitCapacity - 1);
    this.lastCapacityShrinkAt = now;
  }

  private nextPendingReadyAt(): number {
    return this.pending.reduce((nextAt, state) => {
      return Math.min(nextAt, state.retryReadyAt);
    }, Number.POSITIVE_INFINITY);
  }

  private finishIfComplete(): boolean {
    if (this.results.every((result) => result !== undefined)) {
      this.finish(this.results as Array<SubagentResult<T>>);
      return true;
    }
    return false;
  }

  private finishWithUserCancellation(): void {
    if (this.finished) return;

    this.finish(
      this.states.map((state) => {
        const result = this.results[state.index];
        if (result !== undefined) return result;

        if (state.started || state.agentId !== undefined) {
          return {
            task: state.task,
            agentId: state.agentId,
            status: 'aborted',
            state: 'started',
            error:
              'The user manually interrupted this subagent batch before this subagent finished.',
          };
        }

        return {
          task: state.task,
          status: 'aborted',
          state: 'not_started',
          error:
            'The user manually interrupted this subagent batch before this subagent was started.',
        };
      }),
    );
  }

  private finish(results: Array<SubagentResult<T>>): void {
    if (this.finished) return;
    this.finished = true;
    this.cleanup();
    this.resolve?.(results);
  }

  private fail(error: unknown): void {
    if (this.finished) return;
    this.finished = true;
    this.cleanup();
    this.reject?.(error);
  }

  private cleanup(): void {
    this.batchSignal?.removeEventListener('abort', this.batchAbortListener);
    this.clearNormalTimer();
    this.clearRateLimitTimer();
    for (const attempt of this.active.values()) {
      clearTimeout(attempt.readyTimer);
      attempt.cleanup();
    }
    this.active.clear();
  }

  private clearNormalTimer(): void {
    if (this.normalLaunchTimer !== undefined) clearTimeout(this.normalLaunchTimer);
    this.normalLaunchTimer = undefined;
  }

  private clearRateLimitTimer(): void {
    if (this.rateLimitLaunchTimer !== undefined) clearTimeout(this.rateLimitLaunchTimer);
    this.rateLimitLaunchTimer = undefined;
  }

  private linkAttemptSignals(attempt: ActiveAttempt<T>, task: QueuedSubagentTask<T>): () => void {
    const abortFromBatch = () => {
      attempt.controller.abort(this.controller.signal.reason);
    };
    const abortFromTask = () => {
      attempt.controller.abort(task.signal?.reason);
    };
    const timeout =
      task.timeout === undefined
        ? undefined
        : setTimeout(() => {
            attempt.timedOut = true;
            attempt.controller.abort(new Error('Aborted'));
          }, task.timeout);

    if (this.controller.signal.aborted) {
      abortFromBatch();
    } else if (task.signal?.aborted === true) {
      abortFromTask();
    } else {
      this.controller.signal.addEventListener('abort', abortFromBatch, { once: true });
      task.signal?.addEventListener('abort', abortFromTask, { once: true });
    }

    return () => {
      if (timeout !== undefined) clearTimeout(timeout);
      this.controller.signal.removeEventListener('abort', abortFromBatch);
      task.signal?.removeEventListener('abort', abortFromTask);
    };
  }

  private attemptErrorMessage(
    attempt: ActiveAttempt<T>,
    error: unknown,
    status: SubagentResult<T>['status'],
  ): string {
    if (attempt.timedOut && attempt.state.task.timeout !== undefined) {
      return `Subagent timed out after ${formatTimeoutMs(attempt.state.task.timeout)}.`;
    }
    if (status === 'aborted') return 'The user manually interrupted this subagent batch.';
    return error instanceof Error ? error.message : String(error);
  }
}

function rateLimitRetryDelayMs(retryCount: number): number {
  return retry.createTimeout(Math.max(0, retryCount - 1), {
    minTimeout: RATE_LIMIT_RETRY_BASE_MS,
    factor: RATE_LIMIT_RETRY_FACTOR,
    randomize: false,
  });
}

function isRateLimitedOutcome<T>(outcome: AttemptOutcome<T>): outcome is Extract<
  AttemptOutcome<T>,
  { readonly type: 'rate_limited' }
> {
  return (outcome as { readonly type?: string }).type === 'rate_limited';
}

export function formatTimeoutMs(timeoutMs: number): string {
  if (timeoutMs % 1000 === 0) return `${String(timeoutMs / 1000)}s`;
  return `${String(timeoutMs)}ms`;
}

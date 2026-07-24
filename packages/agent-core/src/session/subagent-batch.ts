import { isProviderRateLimitError, type TokenUsage } from '@moonshot-ai/kosong';
import * as retry from 'retry';

import type {
  RunSubagentOptions,
  SpawnSubagentOptions,
  SubagentHandle,
} from './subagent-host';
import { isUserCancellation } from '../utils/abort';

/*
Subagent batch scheduling contract:
Normal phase:
- Return results in input order; empty input returns an empty list.
- Start up to 5 tasks immediately, then 1 more every 700 ms while queued work remains. By default active tasks do not cap this ramp; when KIMI_CODE_AGENT_SWARM_MAX_CONCURRENCY is set to a positive integer, the ramp additionally stops while active tasks reach that cap, and resumes as tasks complete.
- Launch priority: previous agent id saved after a rate limit, explicit resume, then new spawn.
- Readiness can be reported while the attempt is active. Ready normal launches seed the first rate-limit capacity.
- The first provider rate limit stops the ramp and enters rate-limit phase.

Rate-limit phase:
- A provider rate limit requeues while there is other unfinished work. Save the agent id for same-agent retry, emit suspended, and requeue the task at the front; its own eligibility delays are 3000 ms, 6000 ms, 12000 ms, then doubling.
- If the rate-limited attempt is the only unfinished task, fail that task instead of suspending the whole batch forever.
- Enter with capacity equal to ready normal launches, minimum 1; set the next global launch no earlier than 3000 ms later; then shrink capacity by 1, minimum 1. Later rate limits shrink by 1, minimum 1, at most once per 2000 ms.
- Each pass starts at most 1 task: active attempts must be below capacity, global launch time reached, and task eligibility reached. Choose the first eligible queued task, then set next global launch to now plus the current interval. If blocked by time or queued work remains after a launch, wake at the earlier of next launch/eligibility and next capacity recovery.
- Core recovery rule: in rate-limit phase, if work is queued and no provider rate limit happened for 3 minutes, capacity increases by 1, which can launch one more task immediately. This can happen once per quiet window; a new rate limit restarts the window. If active attempts still fill capacity, wake at the next recovery time.

Results and cancellation:
- Completed, failed, aborted, and timed-out attempts occupy their input slots; when all slots have results, return the ordered list. A task timeout fails only that task and does not enter rate-limit phase or stop others.
- The first task signal is the batch signal. User cancellation preserves existing results, marks ready or agent-known unfinished tasks aborted/started, and marks never-started tasks aborted/not_started. Non-user cancellation rejects.
*/

const INITIAL_LAUNCH_LIMIT = 5;
const INITIAL_LAUNCH_INTERVAL_MS = 700;
const RATE_LIMIT_RETRY_BASE_MS = 3000;
const RATE_LIMIT_RETRY_FACTOR = 2;
const RATE_LIMIT_CAPACITY_SHRINK_INTERVAL_MS = 2000;
const RATE_LIMIT_CAPACITY_RECOVERY_INTERVAL_MS = 3 * 60 * 1000;
const RATE_LIMIT_SUSPENDED_REASON = 'Provider rate limit; subagent requeued for retry.';

const AGENT_SWARM_MAX_CONCURRENCY_ENV = 'KIMI_CODE_AGENT_SWARM_MAX_CONCURRENCY';

type BaseQueuedSubagentTask<T> = {
  readonly data: T;
  readonly profileName: string;
  readonly parentToolCallId: string;
  readonly parentToolCallUuid?: string;
  readonly prompt: string;
  readonly description: string;
  readonly swarmIndex?: number;
  readonly swarmItem?: string;
  /** Per-batch spawn override (e.g. from a binding slot); resume ignores it. */
  readonly modelAlias?: string;
  /** Per-batch thinking-effort override; same semantics as `modelAlias`. */
  readonly thinkingEffort?: string;
  readonly runInBackground: boolean;
  readonly timeout?: number;
  readonly signal?: AbortSignal;
};

export type SpawnQueuedSubagentTask<T = unknown> = BaseQueuedSubagentTask<T> & {
  readonly kind: 'spawn';
  readonly resumeAgentId?: undefined;
};

export type ResumeQueuedSubagentTask<T = unknown> = BaseQueuedSubagentTask<T> & {
  readonly kind: 'resume';
  readonly resumeAgentId: string;
};

export type QueuedSubagentTask<T = unknown> =
  | SpawnQueuedSubagentTask<T>
  | ResumeQueuedSubagentTask<T>;

export type SubagentResult<T = unknown> = {
  readonly task: QueuedSubagentTask<T>;
  readonly agentId?: string;
  readonly status: 'completed' | 'failed' | 'aborted';
  readonly state?: 'started' | 'not_started';
  readonly result?: string;
  readonly usage?: TokenUsage;
  readonly error?: string;
};

export type SubagentSuspendedEvent = {
  readonly task: QueuedSubagentTask;
  readonly agentId: string;
  readonly reason: string;
};

export type SubagentBatchLauncher = {
  spawn(options: SpawnSubagentOptions): Promise<SubagentHandle>;
  resume(agentId: string, options: RunSubagentOptions): Promise<SubagentHandle>;
  retry(agentId: string, options: RunSubagentOptions): Promise<SubagentHandle>;
  suspended?(event: SubagentSuspendedEvent): void;
};

type RateLimitedOutcome = {
  readonly type: 'rate_limited';
  readonly agentId: string;
  readonly error: string;
};

type AttemptOutcome<T> = SubagentResult<T> | RateLimitedOutcome;

type TaskState<T> = {
  readonly index: number;
  readonly task: QueuedSubagentTask<T>;
  agentId?: string;
  retryAgentId?: string;
  retryCount: number;
  retryReadyAt: number;
  started: boolean;
};

type ActiveAttempt<T> = {
  readonly state: TaskState<T>;
  readonly controller: AbortController;
  cleanup: () => void;
  ready: boolean;
  timedOut: boolean;
};

export type SubagentBatchOptions = {
  /**
   * Optional cap on how many subagents may run concurrently during the normal
   * phase. `undefined` means no cap (legacy ramp behavior). The rate-limit
   * phase is governed by its own capacity logic and is not affected.
   */
  readonly maxConcurrency?: number;
};

export class SubagentBatch<T> {
  private readonly states: Array<TaskState<T>>;
  private readonly pending: Array<TaskState<T>>;
  private readonly results: Array<SubagentResult<T> | undefined>;
  private readonly active = new Set<ActiveAttempt<T>>();
  private readonly controller = new AbortController();
  private readonly batchSignal: AbortSignal | undefined;
  private readonly batchAbortListener: () => void;
  private readonly maxConcurrency: number | undefined;
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
  private lastRateLimitAt: number | undefined;
  private lastCapacityShrinkAt: number | undefined;
  private lastCapacityRecoveryAt: number | undefined;
  private globalRetryIntervalMs = RATE_LIMIT_RETRY_BASE_MS;
  private nextRateLimitLaunchAt = 0;

  constructor(
    private readonly launcher: SubagentBatchLauncher,
    tasks: readonly QueuedSubagentTask<T>[],
    options: SubagentBatchOptions = {},
  ) {
    this.maxConcurrency = options.maxConcurrency;
    this.states = tasks.map((task, index) => ({
      index,
      task,
      retryCount: 0,
      retryReadyAt: 0,
      started: false,
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
      !this.rateLimitMode &&
      !this.isAtConcurrencyLimit()
    ) {
      this.startAttempt(this.pending.shift()!);
      this.normalLaunchCount += 1;
    }

    if (
      this.pending.length === 0 ||
      this.rateLimitMode ||
      this.normalLaunchTimer !== undefined ||
      this.isAtConcurrencyLimit()
    ) {
      return;
    }

    this.normalLaunchTimer = setTimeout(() => {
      this.normalLaunchTimer = undefined;
      if (this.finished || this.rateLimitMode || this.pending.length === 0) return;
      if (this.isAtConcurrencyLimit()) return;
      this.startAttempt(this.pending.shift()!);
      this.normalLaunchCount += 1;
      this.schedule();
    }, INITIAL_LAUNCH_INTERVAL_MS);
  }

  private isAtConcurrencyLimit(): boolean {
    return this.maxConcurrency !== undefined && this.active.size >= this.maxConcurrency;
  }

  private scheduleRateLimitLaunch(): void {
    this.clearRateLimitTimer();
    if (this.pending.length === 0) return;

    const now = Date.now();
    this.recoverRateLimitCapacity(now);
    if (this.active.size >= this.rateLimitCapacity) {
      this.scheduleRateLimitWakeup(this.nextRateLimitCapacityRecoveryAt(), now);
      return;
    }

    const nextAllowedAt = Math.max(this.nextRateLimitLaunchAt, this.nextPendingReadyAt());
    const nextWakeupAt = Math.min(nextAllowedAt, this.nextRateLimitCapacityRecoveryAt());
    if (nextWakeupAt > now) {
      this.scheduleRateLimitWakeup(nextWakeupAt, now);
      return;
    }

    const pendingIndex = this.pending.findIndex((state) => state.retryReadyAt <= now);
    if (pendingIndex === -1) return;

    const [state] = this.pending.splice(pendingIndex, 1);
    this.startAttempt(state!);
    this.nextRateLimitLaunchAt = now + this.globalRetryIntervalMs;
    this.scheduleNextRateLimitWakeup(now);
  }

  private startAttempt(state: TaskState<T>): void {
    if (this.finished || this.controller.signal.aborted) return;

    const attempt: ActiveAttempt<T> = {
      state,
      controller: new AbortController(),
      cleanup: () => {},
      ready: false,
      timedOut: false,
    };
    attempt.cleanup = this.linkAttemptSignals(attempt, state.task);
    this.active.add(attempt);

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
    const runOptions: RunSubagentOptions = {
      parentToolCallId: task.parentToolCallId,
      parentToolCallUuid: task.parentToolCallUuid,
      prompt: task.prompt,
      description: task.description,
      swarmIndex: task.swarmIndex,
      modelAlias: task.modelAlias,
      thinkingEffort: task.thinkingEffort,
      runInBackground: task.runInBackground,
      signal: attempt.controller.signal,
      onReady: () => {
        this.markAttemptReady(attempt);
      },
      suppressRateLimitFailureEvent: true,
    };

    let handle: SubagentHandle;
    try {
      attempt.controller.signal.throwIfAborted();
      if (attempt.state.retryAgentId !== undefined) {
        handle = await this.launcher.retry(attempt.state.retryAgentId, runOptions);
      } else if (task.kind === 'resume') {
        handle = await this.launcher.resume(task.resumeAgentId, runOptions);
      } else {
        const spawnOptions: SpawnSubagentOptions = {
          profileName: task.profileName,
          swarmItem: task.swarmItem,
          ...runOptions,
        };
        handle = await this.launcher.spawn(spawnOptions);
      }
    } catch (error) {
      return this.failedAttemptOutcome(attempt, error);
    }

    attempt.state.agentId = handle.agentId;
    try {
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
        return {
          type: 'rate_limited',
          agentId: handle.agentId,
          error: this.attemptErrorMessage(attempt, error, 'failed'),
        };
      }

      return this.failedAttemptOutcome(attempt, error);
    }
  }

  private failedAttemptOutcome(attempt: ActiveAttempt<T>, error: unknown): SubagentResult<T> {
    const status =
      attempt.controller.signal.aborted && isUserCancellation(attempt.controller.signal.reason)
        ? 'aborted'
        : 'failed';
    return {
      task: attempt.state.task,
      agentId: attempt.state.agentId,
      status,
      state: attempt.state.agentId === undefined ? 'not_started' : 'started',
      error: this.attemptErrorMessage(attempt, error, status),
    };
  }

  private markAttemptReady(attempt: ActiveAttempt<T>): void {
    if (this.finished || attempt.ready || !this.active.has(attempt)) return;

    attempt.ready = true;
    attempt.state.started = true;
    if (!this.rateLimitMode) {
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

    if ('status' in outcome) {
      this.results[attempt.state.index] = outcome;
    } else if (this.isOnlyUnfinishedTask(attempt.state)) {
      this.results[attempt.state.index] = {
        task: attempt.state.task,
        agentId: outcome.agentId,
        status: 'failed',
        state: 'started',
        error: outcome.error,
      };
    } else {
      this.requeueRateLimited(attempt, outcome.agentId);
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
    if (!this.active.delete(attempt)) return false;
    attempt.cleanup();
    return true;
  }

  private requeueRateLimited(attempt: ActiveAttempt<T>, agentId: string): void {
    const state = attempt.state;
    state.agentId = agentId;
    state.retryAgentId = agentId;
    this.launcher.suspended?.({
      task: state.task,
      agentId,
      reason: RATE_LIMIT_SUSPENDED_REASON,
    });

    const now = Date.now();
    this.lastRateLimitAt = now;
    state.retryCount += 1;
    const retryDelay = retry.createTimeout(Math.max(0, state.retryCount - 1), {
      minTimeout: RATE_LIMIT_RETRY_BASE_MS,
      maxTimeout: Number.POSITIVE_INFINITY,
      factor: RATE_LIMIT_RETRY_FACTOR,
      randomize: false,
    });
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

  private recoverRateLimitCapacity(now: number): void {
    const nextRecoveryAt = this.nextRateLimitCapacityRecoveryAt();
    if (nextRecoveryAt > now) return;

    this.rateLimitCapacity += 1;
    this.lastCapacityRecoveryAt = now;
    this.nextRateLimitLaunchAt = Math.min(this.nextRateLimitLaunchAt, now);
  }

  private nextRateLimitCapacityRecoveryAt(): number {
    if (this.pending.length === 0 || this.lastRateLimitAt === undefined) {
      return Number.POSITIVE_INFINITY;
    }

    const latestCapacityChangeAt = Math.max(
      this.lastRateLimitAt,
      this.lastCapacityRecoveryAt ?? 0,
    );
    return latestCapacityChangeAt + RATE_LIMIT_CAPACITY_RECOVERY_INTERVAL_MS;
  }

  private scheduleRateLimitWakeup(wakeupAt: number, now: number): void {
    if (!Number.isFinite(wakeupAt) || wakeupAt <= now) return;
    this.rateLimitLaunchTimer = setTimeout(() => {
      this.rateLimitLaunchTimer = undefined;
      this.schedule();
    }, wakeupAt - now);
  }

  private scheduleNextRateLimitWakeup(now: number): void {
    if (this.pending.length === 0) return;

    const nextWakeupAt =
      this.active.size >= this.rateLimitCapacity
        ? this.nextRateLimitCapacityRecoveryAt()
        : Math.min(
            Math.max(this.nextRateLimitLaunchAt, this.nextPendingReadyAt()),
            this.nextRateLimitCapacityRecoveryAt(),
          );

    this.scheduleRateLimitWakeup(nextWakeupAt, now);
  }

  private nextPendingReadyAt(): number {
    return this.pending.reduce((nextAt, state) => {
      return Math.min(nextAt, state.retryReadyAt);
    }, Number.POSITIVE_INFINITY);
  }

  private finishIfComplete(): boolean {
    if (this.results.every((result) => result !== undefined)) {
      this.finish(this.results);
      return true;
    }
    return false;
  }

  private isOnlyUnfinishedTask(state: TaskState<T>): boolean {
    return this.results.every((result, index) => index === state.index || result !== undefined);
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
      task.timeout === undefined || task.timeout <= 0
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
      return 'Subagent timed out.';
    }
    if (status === 'aborted') return 'The user manually interrupted this subagent batch.';
    return error instanceof Error ? error.message : String(error);
  }
}

/**
 * Resolve the optional AgentSwarm normal-phase concurrency cap from the environment.
 *
 * Returns `undefined` when the variable is unset/empty. A present value must be a
 * positive integer; invalid input fails fast so a misconfigured cap never silently
 * reverts to the uncapped ramp.
 */
export function resolveSwarmMaxConcurrency(
  env: Readonly<Record<string, string | undefined>> = process.env,
): number | undefined {
  const raw = env[AGENT_SWARM_MAX_CONCURRENCY_ENV];
  if (raw === undefined || raw.trim() === '') return undefined;
  const value = Number(raw);
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(
      `${AGENT_SWARM_MAX_CONCURRENCY_ENV} must be a positive integer, got ${JSON.stringify(raw)}.`,
    );
  }
  return value;
}

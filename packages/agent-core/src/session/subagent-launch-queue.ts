import { createControlledPromise, sleep } from '@antfu/utils';
import type { TokenUsage } from '@moonshot-ai/kosong';

import type { PromptOrigin } from '../agent/context';
import { abortable, createDeadlineAbortSignal, isUserCancellation } from '../utils/abort';

const SUBAGENT_LAUNCH_BATCH_SIZE = 5;
const SUBAGENT_QUEUE_LAUNCH_DELAY_MS = 500;
const SUBAGENT_INITIAL_INCREMENT_DELAY_MS = 700;
const RATE_LIMIT_SLOT_REDUCTION_WINDOW_MS = 2000;
const RATE_LIMIT_RETRY_BASE_DELAY_MS = 3000;
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
  readonly origin?: PromptOrigin;
  readonly resumeAgentId?: string;
};

export type QueuedSubagentRunOptions = {
  readonly signal: AbortSignal;
  readonly timeoutMs?: number;
  readonly totalTimeoutMs?: number;
};

export type QueuedSubagentRunResult<T = unknown> = {
  readonly task: QueuedSubagentTask<T>;
  readonly agentId?: string;
  readonly status: 'completed' | 'failed' | 'aborted';
  readonly state?: 'started' | 'not_started';
  readonly result?: string;
  readonly usage?: TokenUsage;
  readonly error?: string;
};

export type QueuedSubagentRateLimitOutcome = {
  readonly type: 'rate_limited';
  readonly agentId?: string;
};

export type QueuedSubagentSuspended = {
  readonly task: QueuedSubagentTask;
  readonly agentId: string;
  readonly reason: string;
  readonly retryAttempt: number;
};

export type QueuedSubagentAttemptOutcome<T> =
  | QueuedSubagentRateLimitOutcome
  | QueuedSubagentRunResult<T>;

type QueuedSubagentPending = {
  readonly index: number;
  readonly agentId?: string;
  readonly rateLimitAttempts?: number;
  readonly nextRetryAtMs?: number;
};

type QueuedSubagentAttempt<T> = {
  readonly pending: QueuedSubagentPending;
  readonly outcome: Promise<QueuedSubagentAttemptOutcome<T>>;
  readonly readiness: Promise<void>;
  readonly agentId?: string;
  readonly ready: boolean;
  readonly launchSucceeded: boolean;
  settled: boolean;
};

export type QueuedSubagentAttemptOptions = QueuedSubagentRunOptions & {
  readonly totalTimedOut: () => boolean;
  readonly markAgentId: (agentId: string) => void;
  readonly markReady: () => void;
  readonly retryAgentId?: string;
};

type RunQueuedSubagentAttempt = <T>(
  task: QueuedSubagentTask<T>,
  options: QueuedSubagentAttemptOptions,
) => Promise<QueuedSubagentAttemptOutcome<T>>;

type SubagentLaunchQueueEvents = {
  readonly onSuspended?: (event: QueuedSubagentSuspended) => void;
};

export class SubagentLaunchQueue {
  constructor(
    private readonly runAttempt: RunQueuedSubagentAttempt,
    private readonly events: SubagentLaunchQueueEvents = {},
  ) {}

  async run<T>(
    tasks: readonly QueuedSubagentTask<T>[],
    runOptions: QueuedSubagentRunOptions,
  ): Promise<Array<QueuedSubagentRunResult<T>>> {
    const totalDeadline =
      runOptions.totalTimeoutMs === undefined
        ? undefined
        : createDeadlineAbortSignal(runOptions.signal, runOptions.totalTimeoutMs);
    const options: QueuedSubagentRunOptions = {
      signal: totalDeadline?.signal ?? runOptions.signal,
      timeoutMs: runOptions.timeoutMs,
      totalTimeoutMs: runOptions.totalTimeoutMs,
    };
    const totalTimedOut = (): boolean => totalDeadline?.timedOut() === true;

    const queued = tasks.map((_, index): QueuedSubagentPending => ({ index }));
    const active: Array<QueuedSubagentAttempt<T>> = [];
    const results: Array<QueuedSubagentRunResult<T> | undefined> = Array.from({
      length: tasks.length,
    });
    let slotLimit = SUBAGENT_LAUNCH_BATCH_SIZE;
    let rateLimitMode = false;
    let rateLimitReductionWindowStartMs: number | undefined;
    let nextRateLimitedLaunchAtMs = 0;
    let rateLimitedLaunchDelayMs = RATE_LIMIT_RETRY_BASE_DELAY_MS;
    let initialSuccessfulLaunches = 0;

    const finish = (fallback: string): Array<QueuedSubagentRunResult<T>> =>
      results.map((result, index) => result ?? { task: tasks[index]!, status: 'failed', error: fallback });

    const finishInterrupted = (): Array<QueuedSubagentRunResult<T>> => {
      const activeAgentIds = new Map<number, string | undefined>();
      for (const attempt of active) {
        activeAgentIds.set(attempt.pending.index, attempt.agentId ?? attempt.pending.agentId);
      }
      const queuedAgentIds = new Map<number, string | undefined>();
      for (const pending of queued) {
        if (pending.agentId !== undefined) queuedAgentIds.set(pending.index, pending.agentId);
      }

      return results.map((result, index) => {
        if (result !== undefined) return result;
        const task = tasks[index]!;
        const wasStarted = activeAgentIds.has(index) || queuedAgentIds.has(index);
        return {
          task,
          agentId: activeAgentIds.get(index) ?? queuedAgentIds.get(index) ?? task.resumeAgentId,
          status: 'aborted',
          state: wasStarted ? 'started' : 'not_started',
          error: wasStarted
            ? 'The user manually interrupted this subagent batch before this subagent finished.'
            : 'The user manually interrupted this subagent batch before this subagent was started.',
        };
      });
    };

    const requeueRateLimited = (pending: QueuedSubagentPending): void => {
      if (results[pending.index] !== undefined) return;
      queued.unshift(pending);
    };

    const failQueued = (error: string): void => {
      for (const { index } of queued.splice(0)) {
        results[index] = { task: tasks[index]!, status: 'failed', error };
      }
    };

    const reduceSlotsAfterRateLimit = (): void => {
      const now = Date.now();
      if (
        rateLimitReductionWindowStartMs === undefined ||
        now - rateLimitReductionWindowStartMs >= RATE_LIMIT_SLOT_REDUCTION_WINDOW_MS
      ) {
        rateLimitReductionWindowStartMs = now;
        slotLimit = Math.max(1, slotLimit - 1);
      }
    };

    const rateLimitRetryDelayMs = (retryAttempt: number): number =>
      RATE_LIMIT_RETRY_BASE_DELAY_MS * 2 ** Math.max(0, retryAttempt - 1);

    const launch = (pending: QueuedSubagentPending): QueuedSubagentAttempt<T> => {
      const readiness = createControlledPromise<void>();
      let agentId = pending.agentId;
      let ready = false;
      let launchSucceeded = false;
      const markReadyOnly = (): void => {
        if (ready) return;
        ready = true;
        clearTimeout(readinessTimer);
        readiness.resolve();
      };
      const markReady = (): void => {
        if (!launchSucceeded && !rateLimitMode) {
          initialSuccessfulLaunches += 1;
        }
        launchSucceeded = true;
        markReadyOnly();
        if (!rateLimitMode) return;
        rateLimitedLaunchDelayMs = RATE_LIMIT_RETRY_BASE_DELAY_MS;
        nextRateLimitedLaunchAtMs = Date.now() + RATE_LIMIT_RETRY_BASE_DELAY_MS;
      };
      const readinessTimer = setTimeout(markReadyOnly, SUBAGENT_QUEUE_LAUNCH_DELAY_MS);
      const outcome = this.runAttempt(tasks[pending.index]!, {
        ...options,
        totalTimedOut,
        markAgentId: (id) => {
          agentId = id;
        },
        markReady,
        retryAgentId: pending.agentId,
      });
      const attempt: QueuedSubagentAttempt<T> = {
        pending,
        outcome,
        readiness,
        get agentId() { return agentId; },
        get ready() { return ready; },
        get launchSucceeded() { return launchSucceeded; },
        settled: false,
      };
      const settle = (): void => {
        attempt.settled = true;
        markReadyOnly();
      };
      void outcome.then(settle, settle);
      active.push(attempt);
      return attempt;
    };

    const processAttempt = async (attempt: QueuedSubagentAttempt<T>): Promise<boolean> => {
      active.splice(active.indexOf(attempt), 1);
      const outcome = await attempt.outcome;
      if (isRateLimitedOutcome(outcome)) {
        if (!rateLimitMode) {
          slotLimit = Math.max(1, initialSuccessfulLaunches);
        }
        rateLimitMode = true;
        reduceSlotsAfterRateLimit();
        const agentId = outcome.agentId ?? attempt.pending.agentId;
        const retryAttempt = (attempt.pending.rateLimitAttempts ?? 0) + 1;
        const now = Date.now();
        const retryDelayMs = rateLimitRetryDelayMs(retryAttempt);
        if (nextRateLimitedLaunchAtMs <= now) {
          nextRateLimitedLaunchAtMs = now + RATE_LIMIT_RETRY_BASE_DELAY_MS;
        }
        if (!attempt.launchSucceeded) {
          rateLimitedLaunchDelayMs = Math.max(rateLimitedLaunchDelayMs * 2, retryDelayMs);
          nextRateLimitedLaunchAtMs = now + rateLimitedLaunchDelayMs;
        }
        if (agentId !== undefined) {
          this.events.onSuspended?.({
            task: tasks[attempt.pending.index]!,
            agentId,
            reason: RATE_LIMIT_SUSPENDED_REASON,
            retryAttempt,
          });
        }
        requeueRateLimited({
          index: attempt.pending.index,
          agentId,
          rateLimitAttempts: retryAttempt,
          nextRetryAtMs: now + retryDelayMs,
        });
        return true;
      }
      results[attempt.pending.index] = outcome;
      return true;
    };

    const processSettledAttempts = async (): Promise<boolean> => {
      while (true) {
        const attempt = active.find((item) => item.settled);
        if (attempt === undefined) return true;
        if (!(await processAttempt(attempt))) return false;
      }
    };

    const nextSettled = (): Promise<void> =>
      Promise.race(active.map((attempt) => attempt.outcome.then(() => undefined)));

    const nextReadiness = (): Promise<void> | undefined => {
      const unready = active.filter((attempt) => !attempt.ready);
      if (unready.length === 0) return undefined;
      return Promise.race(unready.map((attempt) => attempt.readiness));
    };

    const waitForInitialIncrement = async (): Promise<void> => {
      const delay = sleep(SUBAGENT_INITIAL_INCREMENT_DELAY_MS).then(() => 'delay' as const);
      while (true) {
        if (rateLimitMode) return;
        options.signal.throwIfAborted();
        const waits: Array<Promise<'delay' | 'settled' | 'readiness'>> = [delay];
        const settled = nextSettled().then(() => 'settled' as const);
        const readiness = nextReadiness()?.then(() => 'readiness' as const);
        waits.push(settled);
        if (readiness !== undefined) waits.push(readiness);
        const waitResult = await abortable(Promise.race(waits), options.signal);
        if (waitResult === 'delay') return;
        if (waitResult === 'settled') await processSettledAttempts();
      }
    };

    const eligibleRateLimitedQueuedIndex = (): number => {
      const now = Date.now();
      return queued.findIndex((pending) => (pending.nextRetryAtMs ?? 0) <= now);
    };

    const nextRateLimitedLaunchWakeAt = (): number | undefined => {
      if (!rateLimitMode || queued.length === 0 || active.length >= slotLimit) return undefined;
      const nextPendingAt = Math.min(
        ...queued.map((pending) => pending.nextRetryAtMs ?? 0),
      );
      return Math.max(nextRateLimitedLaunchAtMs, nextPendingAt);
    };

    const launchRateLimitedQueued = (): number => {
      if (!rateLimitMode || queued.length === 0 || active.length >= slotLimit) return 0;
      const now = Date.now();
      if (now < nextRateLimitedLaunchAtMs) return 0;
      const index = eligibleRateLimitedQueuedIndex();
      if (index < 0) return 0;
      launch(queued.splice(index, 1)[0]!);
      nextRateLimitedLaunchAtMs = now + rateLimitedLaunchDelayMs;
      return 1;
    };

    const launchInitialBatch = (): void => {
      for (const pending of queued.splice(0, Math.min(SUBAGENT_LAUNCH_BATCH_SIZE, queued.length))) {
        launch(pending);
      }
    };

    try {
      launchInitialBatch();
      while (queued.length > 0) {
        if (rateLimitMode) break;
        await waitForInitialIncrement();
        if (!rateLimitMode && queued.length > 0) launch(queued.shift()!);
      }

      while (active.length > 0 || queued.length > 0) {
        options.signal.throwIfAborted();
        await processSettledAttempts();

        const launched = launchRateLimitedQueued();
        if (launched > 0) continue;

        if (active.length === 0) {
          const wakeAt = nextRateLimitedLaunchWakeAt();
          if (wakeAt === undefined) {
            failQueued('No running subagents remained to open queue slots after rate-limited launches.');
            break;
          }
          await abortable(sleep(Math.max(0, wakeAt - Date.now())), options.signal);
          continue;
        }

        const wakeAt = nextRateLimitedLaunchWakeAt();
        const waitForLaunch =
          wakeAt === undefined
            ? undefined
            : sleep(Math.max(0, wakeAt - Date.now())).then(() => undefined);
        const waitForReadiness = nextReadiness();
        await abortable(
          Promise.race(
            [nextSettled(), waitForLaunch, waitForReadiness].filter(
              (wait): wait is Promise<void> => wait !== undefined,
            ),
          ),
          options.signal,
        );
      }

      return finish('Subagent stopped before it could finish.');
    } catch (error) {
      if (totalTimedOut()) return finish(totalTimeoutMessage(options.totalTimeoutMs));
      if (isUserCancellation(options.signal.reason)) {
        try {
          await processSettledAttempts();
        } catch {
          // Children may observe the same user abort before returning handles.
        }
        return finishInterrupted();
      }
      throw error;
    } finally {
      totalDeadline?.clear();
    }
  }
}

export function totalTimeoutMessage(timeoutMs: number | undefined): string {
  return timeoutMs === undefined
    ? 'Subagent batch total timeout elapsed.'
    : `Subagent batch total timeout after ${formatTimeoutMs(timeoutMs)}.`;
}

function isRateLimitedOutcome<T>(
  outcome: QueuedSubagentAttemptOutcome<T>,
): outcome is QueuedSubagentRateLimitOutcome {
  return 'type' in outcome && outcome.type === 'rate_limited';
}

export function formatTimeoutMs(timeoutMs: number): string {
  return `${String(timeoutMs / 1000)}s`;
}

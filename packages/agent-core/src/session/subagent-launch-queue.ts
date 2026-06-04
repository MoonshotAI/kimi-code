import { createControlledPromise, sleep } from '@antfu/utils';
import type { TokenUsage } from '@moonshot-ai/kosong';

import type { PromptOrigin } from '../agent/context';
import { abortable, createDeadlineAbortSignal } from '../utils/abort';

const SUBAGENT_LAUNCH_BATCH_SIZE = 10;
const SUBAGENT_QUEUE_LAUNCH_DELAY_MS = 500;
const RATE_LIMIT_SLOT_REDUCTION_WINDOW_MS = 1000;
const RATE_LIMIT_SLOT_REDUCTION_MAX_PER_WINDOW = 3;
const RATE_LIMIT_RETRY_EXHAUSTED_MESSAGE =
  'Subagent failed after another 429 with only one retry slot remaining.';

export type QueuedSubagentTask<T = unknown> = {
  readonly data: T;
  readonly profileName: string;
  readonly parentToolCallId: string;
  readonly parentToolCallUuid?: string;
  readonly prompt: string;
  readonly description: string;
  readonly runInBackground: boolean;
  readonly origin?: PromptOrigin;
};

export type QueuedSubagentRunOptions = {
  readonly signal: AbortSignal;
  readonly timeoutMs?: number;
  readonly totalTimeoutMs?: number;
};

export type QueuedSubagentRunResult<T = unknown> = {
  readonly task: QueuedSubagentTask<T>;
  readonly agentId?: string;
  readonly status: 'completed' | 'failed';
  readonly result?: string;
  readonly usage?: TokenUsage;
  readonly error?: string;
};

export type QueuedSubagentRateLimitOutcome = {
  readonly type: 'rate_limited';
  readonly agentId?: string;
};

export type QueuedSubagentAttemptOutcome<T> =
  | QueuedSubagentRateLimitOutcome
  | QueuedSubagentRunResult<T>;

type QueuedSubagentPending = {
  readonly index: number;
  readonly agentId?: string;
};

type QueuedSubagentAttempt<T> = {
  readonly pending: QueuedSubagentPending;
  readonly outcome: Promise<QueuedSubagentAttemptOutcome<T>>;
  readonly readiness: Promise<void>;
  readonly ready: boolean;
  settled: boolean;
};

export type QueuedSubagentAttemptOptions = QueuedSubagentRunOptions & {
  readonly totalTimedOut: () => boolean;
  readonly markReady: () => void;
  readonly retryAgentId?: string;
};

type RunQueuedSubagentAttempt = <T>(
  task: QueuedSubagentTask<T>,
  options: QueuedSubagentAttemptOptions,
) => Promise<QueuedSubagentAttemptOutcome<T>>;

export class SubagentLaunchQueue {
  constructor(private readonly runAttempt: RunQueuedSubagentAttempt) {}

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
    let slotLimit: number | undefined;
    let rateLimitReductionWindowStartMs: number | undefined;
    let rateLimitReductionsInWindow = 0;
    const hasResults = (): boolean => results.some((result) => result !== undefined);
    const hasRetriableQueued = (): boolean =>
      queued.some((pending) => pending.agentId !== undefined);

    const finish = (fallback: string): Array<QueuedSubagentRunResult<T>> =>
      results.map(
        (result, index) => result ?? { task: tasks[index]!, status: 'failed', error: fallback },
      );

    const requeueRateLimited = (pending: QueuedSubagentPending): void => {
      if (results[pending.index] !== undefined) return;
      queued.unshift(pending);
    };

    const failQueued = (error: string): void => {
      for (const { index } of queued.splice(0)) {
        results[index] = { task: tasks[index]!, status: 'failed', error };
      }
    };

    const unreadyActiveCount = (): number =>
      active.reduce((count, attempt) => count + (attempt.ready ? 0 : 1), 0);

    const reduceSlotsAfterRateLimit = (): boolean => {
      const now = Date.now();
      if (
        rateLimitReductionWindowStartMs === undefined ||
        now - rateLimitReductionWindowStartMs >= RATE_LIMIT_SLOT_REDUCTION_WINDOW_MS
      ) {
        rateLimitReductionWindowStartMs = now;
        rateLimitReductionsInWindow = 0;
      }

      const currentLimit = slotLimit ?? SUBAGENT_LAUNCH_BATCH_SIZE;
      if (currentLimit <= 1) {
        slotLimit = currentLimit;
        return false;
      }
      if (
        rateLimitReductionsInWindow >= RATE_LIMIT_SLOT_REDUCTION_MAX_PER_WINDOW
      ) {
        slotLimit = currentLimit;
        return true;
      }

      slotLimit = currentLimit - 1;
      rateLimitReductionsInWindow += 1;
      return true;
    };

    const launch = (pending: QueuedSubagentPending): QueuedSubagentAttempt<T> => {
      const readiness = createControlledPromise<void>();
      let ready = false;
      const markReady = (): void => {
        if (ready) return;
        ready = true;
        clearTimeout(readinessTimer);
        readiness.resolve();
      };
      const readinessTimer = setTimeout(markReady, SUBAGENT_QUEUE_LAUNCH_DELAY_MS);
      const outcome = this.runAttempt(tasks[pending.index]!, {
        ...options,
        totalTimedOut,
        markReady,
        retryAgentId: pending.agentId,
      });
      const attempt: QueuedSubagentAttempt<T> = {
        pending,
        outcome,
        readiness,
        get ready() {
          return ready;
        },
        settled: false,
      };
      void outcome.then(
        () => {
          attempt.settled = true;
          markReady();
        },
        () => {
          attempt.settled = true;
          markReady();
        },
      );
      active.push(attempt);
      return attempt;
    };

    const processAttempt = async (attempt: QueuedSubagentAttempt<T>): Promise<boolean> => {
      active.splice(active.indexOf(attempt), 1);
      const outcome = await attempt.outcome;
      if (isRateLimitedOutcome(outcome)) {
        if (!reduceSlotsAfterRateLimit()) {
          results[attempt.pending.index] = {
            task: tasks[attempt.pending.index]!,
            agentId: outcome.agentId ?? attempt.pending.agentId,
            status: 'failed',
            error: RATE_LIMIT_RETRY_EXHAUSTED_MESSAGE,
          };
          return true;
        }
        requeueRateLimited({
          index: attempt.pending.index,
          agentId: outcome.agentId ?? attempt.pending.agentId,
        });
        return false;
      }
      results[attempt.pending.index] = outcome;
      return true;
    };

    const processSettledAttempts = async (): Promise<boolean> => {
      for (let attempt = active.find((item) => item.settled); attempt !== undefined; ) {
        if (!(await processAttempt(attempt))) return false;
        attempt = active.find((item) => item.settled);
      }
      return true;
    };

    const nextSettled = (): Promise<void> =>
      Promise.race(active.map((attempt) => attempt.outcome.then(() => undefined)));

    const nextReadiness = (): Promise<void> => {
      const unready = active.filter((attempt) => !attempt.ready);
      if (unready.length === 0) return Promise.resolve();
      return Promise.race(unready.map((attempt) => attempt.readiness));
    };

    const nextSettledAttempt = async (): Promise<QueuedSubagentAttempt<T>> => {
      await nextSettled();
      return active.find((attempt) => attempt.settled)!;
    };

    const waitForRampBatch = async (
      batch: readonly QueuedSubagentAttempt<T>[],
    ): Promise<boolean> => {
      const batchReady = Promise.all(batch.map((attempt) => attempt.readiness));
      while (batch.some((attempt) => !attempt.ready)) {
        options.signal.throwIfAborted();
        await abortable(Promise.race([batchReady, nextSettled()]), options.signal);
        if (!(await processSettledAttempts())) return false;
      }
      return processSettledAttempts();
    };

    const launchQueuedUpToSlotLimit = async (): Promise<number> => {
      if (slotLimit === undefined || (!hasResults() && !hasRetriableQueued())) return 0;
      let launched = 0;
      while (queued.length > 0 && unreadyActiveCount() < slotLimit) {
        const delay = sleep(SUBAGENT_QUEUE_LAUNCH_DELAY_MS).then(() => 'delay' as const);
        const settled =
          active.length === 0
            ? undefined
            : nextSettled().then(() => 'settled' as const);
        const waitResult = await abortable(
          settled === undefined ? delay : Promise.race([delay, settled]),
          options.signal,
        );
        if (waitResult === 'settled') break;
        if (active.some((attempt) => attempt.settled)) break;
        if (unreadyActiveCount() < slotLimit) {
          launch(queued.shift()!);
          launched += 1;
        }
      }
      return launched;
    };

    const launchRampBatch = (): Array<QueuedSubagentAttempt<T>> =>
      queued.splice(0, SUBAGENT_LAUNCH_BATCH_SIZE).map(launch);

    try {
      while (queued.length > 0) {
        if (slotLimit !== undefined) break;
        const batch = launchRampBatch();
        if (queued.length === 0) break;
        if (!(await waitForRampBatch(batch))) break;
      }

      while (active.length > 0 || queued.length > 0) {
        options.signal.throwIfAborted();
        if (active.length === 0) {
          if (queued.length === 0) break;
          if (!hasResults() && !hasRetriableQueued()) {
            throw new Error(
              'Could not start any subagents because every launch attempt was rate limited.',
            );
          }
          await launchQueuedUpToSlotLimit();
          if (active.length > 0) continue;
          failQueued('No running subagents remained to open queue slots after rate-limited launches.');
          break;
        }

        const settled = active.find((attempt) => attempt.settled);
        if (settled !== undefined) {
          await processAttempt(settled);
          await launchQueuedUpToSlotLimit();
          continue;
        }

        const launched = await launchQueuedUpToSlotLimit();
        if (launched > 0) continue;

        if (
          queued.length > 0 &&
          slotLimit !== undefined &&
          unreadyActiveCount() >= slotLimit &&
          active.some((attempt) => !attempt.ready)
        ) {
          await abortable(Promise.race([nextSettled(), nextReadiness()]), options.signal);
          continue;
        }

        const attempt = await abortable(nextSettledAttempt(), options.signal);
        await processAttempt(attempt);
      }

      return finish('Subagent stopped before it could finish.');
    } catch (error) {
      if (!totalTimedOut()) throw error;
      return finish(totalTimeoutMessage(options.totalTimeoutMs));
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

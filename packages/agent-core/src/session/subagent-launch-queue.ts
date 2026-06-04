import { createControlledPromise, sleep } from '@antfu/utils';
import type { TokenUsage } from '@moonshot-ai/kosong';

import type { PromptOrigin } from '../agent/context';
import {
  createDeadlineAbortSignal,
  raceWithSignal,
} from '../utils/abort';

const SUBAGENT_LAUNCH_BATCH_SIZE = 10;
const SUBAGENT_QUEUE_LAUNCH_DELAY_MS = 500;
const RATE_LIMIT_429_MESSAGE =
  "429 We're receiving too many requests at the moment. Please wait a moment and try again.";
const RATE_LIMIT_429_BODY =
  "We're receiving too many requests at the moment. Please wait a moment and try again.";

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

export type QueuedSubagentAttemptOutcome<T> =
  | {
      readonly kind: 'rate_limited';
      readonly task: QueuedSubagentTask<T>;
    }
  | {
      readonly kind: 'result';
      readonly result: QueuedSubagentRunResult<T>;
    };

type QueuedSubagentAttempt<T> = {
  readonly task: QueuedSubagentTask<T>;
  readonly promise: Promise<QueuedSubagentAttemptOutcome<T>>;
  readonly readiness: Promise<void>;
  readonly state: {
    settled: boolean;
    ready: boolean;
  };
};

type SubagentLaunchQueueHost = {
  readonly runQueuedTaskAttempt: <T>(
    task: QueuedSubagentTask<T>,
    options: QueuedSubagentRunOptions,
    totalTimedOut: () => boolean,
    markReady: () => void,
  ) => Promise<QueuedSubagentAttemptOutcome<T>>;
};

export class SubagentLaunchQueue {
  constructor(private readonly host: SubagentLaunchQueueHost) {}

  async run<T>(
    tasks: readonly QueuedSubagentTask<T>[],
    options: QueuedSubagentRunOptions,
  ): Promise<Array<QueuedSubagentRunResult<T>>> {
    let totalDeadline: ReturnType<typeof createDeadlineAbortSignal> | undefined;
    try {
      totalDeadline =
        options.totalTimeoutMs === undefined
          ? undefined
          : createDeadlineAbortSignal(options.signal, options.totalTimeoutMs);
      return await this.runWithSignal(
        tasks,
        {
          signal: totalDeadline?.signal ?? options.signal,
          timeoutMs: options.timeoutMs,
          totalTimeoutMs: options.totalTimeoutMs,
        },
        () => totalDeadline?.timedOut() === true,
      );
    } finally {
      totalDeadline?.clear();
    }
  }

  private async runWithSignal<T>(
    tasks: readonly QueuedSubagentTask<T>[],
    options: QueuedSubagentRunOptions,
    totalTimedOut: () => boolean,
  ): Promise<Array<QueuedSubagentRunResult<T>>> {
    const pending = [...tasks];
    const queued: Array<QueuedSubagentTask<T>> = [];
    const active: Array<QueuedSubagentAttempt<T>> = [];
    const results: Array<QueuedSubagentRunResult<T> | undefined> = Array.from({
      length: tasks.length,
    });
    const taskIndexes = new Map(tasks.map((task, index) => [task, index]));
    let completedResults = 0;
    let launchedAttempts = 0;
    let slotLimit: number | undefined;

    const resultIndex = (task: QueuedSubagentTask<T>): number => {
      const index = taskIndexes.get(task);
      if (index === undefined) {
        throw new Error('Queued subagent task was not registered');
      }
      return index;
    };

    const enqueue = (task: QueuedSubagentTask<T>): void => {
      if (results[resultIndex(task)] !== undefined || queued.includes(task)) return;
      const index = resultIndex(task);
      const insertAt = queued.findIndex((queuedTask) => resultIndex(queuedTask) > index);
      if (insertAt === -1) {
        queued.push(task);
      } else {
        queued.splice(insertAt, 0, task);
      }
    };

    const launch = (task: QueuedSubagentTask<T>): QueuedSubagentAttempt<T> => {
      const readiness = createControlledPromise<void>();
      const state = {
        settled: false,
        ready: false,
      };
      const markReady = (): void => {
        if (state.ready) return;
        state.ready = true;
        readiness.resolve();
      };
      const promise = this.host.runQueuedTaskAttempt(task, options, totalTimedOut, markReady);
      const attempt: QueuedSubagentAttempt<T> = {
        task,
        promise,
        readiness,
        state,
      };
      launchedAttempts += 1;
      void promise.then(
        () => {
          state.settled = true;
          markReady();
        },
        () => {
          state.settled = true;
          markReady();
        },
      );
      active.push(attempt);
      return attempt;
    };

    const processAttempt = async (attempt: QueuedSubagentAttempt<T>): Promise<boolean> => {
      const activeIndex = active.indexOf(attempt);
      if (activeIndex !== -1) active.splice(activeIndex, 1);
      const outcome = await attempt.promise;
      if (outcome.kind === 'rate_limited') {
        slotLimit ??= Math.max(0, launchedAttempts - 2);
        enqueue(outcome.task);
        return false;
      }
      results[resultIndex(outcome.result.task)] = outcome.result;
      completedResults += 1;
      return true;
    };

    const processSettledAttempts = async (): Promise<boolean> => {
      while (true) {
        const settled = active.find((attempt) => attempt.state.settled);
        if (settled === undefined) return true;
        if (!(await processAttempt(settled))) return false;
      }
    };

    const waitForRampBatch = async (
      batch: readonly QueuedSubagentAttempt<T>[],
    ): Promise<boolean> => {
      while (batch.some((attempt) => !attempt.state.ready)) {
        const readiness = batch
          .filter((attempt) => !attempt.state.ready)
          .map((attempt) => attempt.readiness.then(() => undefined));
        const settled = active.map((attempt) => attempt.promise.then(() => undefined));
        options.signal.throwIfAborted();
        await raceWithSignal(Promise.race([...readiness, ...settled]), options.signal);
        if (!(await processSettledAttempts())) return false;
      }
      return await processSettledAttempts();
    };

    const launchQueuedUpToSlotLimit = async (): Promise<void> => {
      if (slotLimit === undefined) return;
      if (active.length === 0 && completedResults === 0) return;
      while (queued.length > 0 && active.length < slotLimit) {
        await raceWithSignal(sleep(SUBAGENT_QUEUE_LAUNCH_DELAY_MS), options.signal);
        if (active.length >= slotLimit) return;
        const task = queued.shift();
        if (task !== undefined) launch(task);
      }
    };

    try {
      while (pending.length > 0 && slotLimit === undefined) {
        const batch: Array<QueuedSubagentAttempt<T>> = [];
        const batchSize = Math.min(SUBAGENT_LAUNCH_BATCH_SIZE, pending.length);
        for (let i = 0; i < batchSize; i += 1) {
          const task = pending.shift();
          if (task === undefined) break;
          batch.push(launch(task));
        }
        if (pending.length === 0) break;
        const rampCanContinue = await waitForRampBatch(batch);
        if (!rampCanContinue) break;
      }

      for (const task of pending) {
        enqueue(task);
      }
      pending.length = 0;
      if (active.length > 0 || completedResults > 0) {
        await launchQueuedUpToSlotLimit();
      }

      while (completedResults < tasks.length) {
        options.signal.throwIfAborted();
        if (active.length === 0) {
          if (queued.length === 0) break;
          if (completedResults === 0) {
            throw new Error(
              'Could not start any subagents because every launch attempt was rate limited.',
            );
          }
          while (queued.length > 0) {
            const task = queued.shift();
            if (task === undefined) break;
            results[resultIndex(task)] = {
              task,
              status: 'failed',
              error: 'No running subagents remained to open queue slots after rate-limited launches.',
            };
            completedResults += 1;
          }
          break;
        }

        const settled = active.find((attempt) => attempt.state.settled);
        const attempt =
          settled ??
          (await raceWithSignal(
            Promise.race(active.map((candidate) => candidate.promise.then(() => candidate))),
            options.signal,
          ));
        await processAttempt(attempt);
        await launchQueuedUpToSlotLimit();
      }
    } catch (error) {
      if (!totalTimedOut()) throw error;
      const message = totalTimeoutMessage(options.totalTimeoutMs);
      for (const task of tasks) {
        const index = resultIndex(task);
        if (results[index] !== undefined) continue;
        results[index] = { task, status: 'failed', error: message };
      }
    }

    return results.map((result, index) => {
      if (result !== undefined) return result;
      return {
        task: tasks[index]!,
        status: 'failed',
        error: 'Subagent stopped before it could finish.',
      };
    });
  }
}

export function totalTimeoutMessage(timeoutMs: number | undefined): string {
  return timeoutMs === undefined
    ? 'Subagent batch total timeout elapsed.'
    : `Subagent batch total timeout after ${formatTimeoutMs(timeoutMs)}.`;
}

export function formatTimeoutMs(timeoutMs: number): string {
  return `${String(timeoutMs / 1000)}s`;
}

export function isRateLimit429Error(error: unknown): boolean {
  const message = errorMessage(error);
  if (message.includes(RATE_LIMIT_429_MESSAGE)) return true;
  if (!message.includes(RATE_LIMIT_429_BODY)) return false;
  if (message.includes('429')) return true;
  if (message.includes('provider.rate_limit')) return true;
  return maybeStatusCode(error) === 429;
}

function maybeStatusCode(error: unknown): number | undefined {
  if (typeof error !== 'object' || error === null) return undefined;
  const statusCode = (error as { readonly statusCode?: unknown }).statusCode;
  if (typeof statusCode === 'number') return statusCode;
  const status = (error as { readonly status?: unknown }).status;
  return typeof status === 'number' ? status : undefined;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

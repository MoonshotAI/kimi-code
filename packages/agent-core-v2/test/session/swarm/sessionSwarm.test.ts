import { createControlledPromise } from '@antfu/utils';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { IAgentScopeHandle } from '#/_base/di/scope';
import { LifecycleScope } from '#/_base/di/scope';
import { SyncDescriptor } from '#/_base/di/descriptors';
import { DisposableStore } from '#/_base/di/lifecycle';
import { TestInstantiationService } from '#/_base/di/test';
import { Event } from '#/_base/event';
import { userCancellationReason } from '#/_base/utils/abort';
import { IAgentPermissionModeService } from '#/agent/permissionMode/permissionMode';
import { IAgentProfileService, type ProfileData } from '#/agent/profile/profile';
import { IAgentLoopService } from '#/agent/loop/loop';
import { IAgentUserToolService } from '#/agent/userTool/userTool';
import { IEventBus, type DomainEvent } from '#/app/event/eventBus';
import { ISessionAgentProfileCatalog } from '#/session/sessionAgentProfileCatalog/sessionAgentProfileCatalog';
import { APIProviderRateLimitError } from '#/kosong/contract/errors';
import { ITelemetryService, noopTelemetryService } from '#/app/telemetry/telemetry';
import {
  IAgentLifecycleService,
  type CreateAgentOptions,
} from '#/session/agentLifecycle/agentLifecycle';
import { labelsFromAgentMeta } from '#/session/agentLifecycle/subagentMetadata';
import { createHooks } from '#/hooks';
import {
  type AgentTaskHooks,
  ISessionSubagentService,
} from '#/session/subagent/subagent';
import { ISessionContext, makeSessionContext } from '#/session/sessionContext/sessionContext';
import {
  ISessionMetadata,
  type AgentMeta,
  type SessionMetadataChangedEvent,
} from '#/session/sessionMetadata/sessionMetadata';
import { ISessionProcessRunner } from '#/session/process/processRunner';
import { ILogService } from '#/_base/log/log';
import {
  AgentRunBatch,
  resolveSwarmMaxConcurrency,
  type AgentRunAttemptHandle,
  type AgentRunAttemptOptions,
  type AgentRunBatchLauncher,
  type AgentRunResult,
  type AgentRunSuspendedEvent,
  type AgentSpawnAttemptOptions,
  type QueuedAgentRunTask,
} from '#/session/swarm/agentRunBatch';
import { ISessionSwarmService, type SessionSwarmTask } from '#/session/swarm/sessionSwarm';
import { SessionSwarmService } from '#/session/swarm/sessionSwarmService';

import { stubLog } from '../../_base/log/stubs';

describe('resolveSwarmMaxConcurrency', () => {
  it('returns undefined when the variable is unset', () => {
    expect(resolveSwarmMaxConcurrency({})).toBeUndefined();
  });

  it('returns undefined for empty or whitespace-only values', () => {
    expect(
      resolveSwarmMaxConcurrency({ KIMI_CODE_AGENT_SWARM_MAX_CONCURRENCY: '' }),
    ).toBeUndefined();
    expect(
      resolveSwarmMaxConcurrency({ KIMI_CODE_AGENT_SWARM_MAX_CONCURRENCY: '   ' }),
    ).toBeUndefined();
  });

  it('throws for non-positive, non-integer, or non-numeric values', () => {
    for (const raw of ['0', '-1', '2.5', 'abc']) {
      expect(() =>
        resolveSwarmMaxConcurrency({ KIMI_CODE_AGENT_SWARM_MAX_CONCURRENCY: raw }),
      ).toThrow(/KIMI_CODE_AGENT_SWARM_MAX_CONCURRENCY.*positive integer/);
    }
  });

  it('returns the integer for a positive integer value', () => {
    expect(resolveSwarmMaxConcurrency({ KIMI_CODE_AGENT_SWARM_MAX_CONCURRENCY: '3' })).toBe(3);
    expect(resolveSwarmMaxConcurrency({ KIMI_CODE_AGENT_SWARM_MAX_CONCURRENCY: ' 8 ' })).toBe(8);
  });
});

describe('AgentRunBatch scheduling contract', () => {
  it('normal phase starts five tasks immediately, then one task every 700ms', async () => {
    vi.useFakeTimers();
    try {
      const { runBatch, attempts } = createMockAgentRunBatchRunner();
      const running = runBatch(
        Array.from({ length: 9 }, (_, index) => queuedAgentRunTask(index + 1)),
        { signal: new AbortController().signal },
      );

      await vi.advanceTimersByTimeAsync(0);
      expect(attempts).toHaveLength(5);

      await vi.advanceTimersByTimeAsync(699);
      expect(attempts).toHaveLength(5);

      await vi.advanceTimersByTimeAsync(1);
      expect(attempts).toHaveLength(6);

      await vi.advanceTimersByTimeAsync(700);
      expect(attempts).toHaveLength(7);

      await vi.advanceTimersByTimeAsync(700);
      expect(attempts).toHaveLength(8);

      await vi.advanceTimersByTimeAsync(700);
      expect(attempts).toHaveLength(9);

      await vi.advanceTimersByTimeAsync(700);
      expect(attempts).toHaveLength(9);

      attempts.forEach((attempt, index) => {
        attempt.outcome.resolve({
          task: attempt.task,
          agentId: `agent-${String(index + 1)}`,
          status: 'completed',
          result: `result ${String(index + 1)}`,
        });
      });
      const results = await running;

      expect(results).toHaveLength(9);
      expect(results.every((result) => result.status === 'completed')).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it('user cancellation returns completed, started, and not-started task results', async () => {
    vi.useFakeTimers();
    try {
      const controller = new AbortController();
      const { runBatch, attempts } = createMockAgentRunBatchRunner();
      const running = runBatch(
        Array.from({ length: 6 }, (_, index) => queuedAgentRunTask(index + 1)),
        { signal: controller.signal },
      );

      await vi.advanceTimersByTimeAsync(0);
      expect(attempts).toHaveLength(5);

      attempts[0]!.outcome.resolve({
        task: attempts[0]!.task,
        agentId: 'agent-1',
        status: 'completed',
        result: 'completed 1',
      });
      await vi.advanceTimersByTimeAsync(0);

      controller.abort(userCancellationReason());
      const results = await running;

      expect(
        results.map((result) => ({
          data: result.task.data,
          agentId: result.agentId,
          status: result.status,
          state: result.state,
          result: result.result,
          error: result.error,
        })),
      ).toEqual([
        {
          data: 1,
          agentId: 'agent-1',
          status: 'completed',
          state: undefined,
          result: 'completed 1',
          error: undefined,
        },
        {
          data: 2,
          agentId: 'agent-2',
          status: 'aborted',
          state: 'started',
          result: undefined,
          error: 'The user manually interrupted this subagent batch before this subagent finished.',
        },
        {
          data: 3,
          agentId: 'agent-3',
          status: 'aborted',
          state: 'started',
          result: undefined,
          error: 'The user manually interrupted this subagent batch before this subagent finished.',
        },
        {
          data: 4,
          agentId: 'agent-4',
          status: 'aborted',
          state: 'started',
          result: undefined,
          error: 'The user manually interrupted this subagent batch before this subagent finished.',
        },
        {
          data: 5,
          agentId: 'agent-5',
          status: 'aborted',
          state: 'started',
          result: undefined,
          error: 'The user manually interrupted this subagent batch before this subagent finished.',
        },
        {
          data: 6,
          agentId: undefined,
          status: 'aborted',
          state: 'not_started',
          result: undefined,
          error:
            'The user manually interrupted this subagent batch before this subagent was started.',
        },
      ]);
    } finally {
      vi.useRealTimers();
    }
  });

  it('normal phase keeps processing completions while waiting for the next launch', async () => {
    vi.useFakeTimers();
    try {
      const { runBatch, attempts } = createMockAgentRunBatchRunner();
      const running = runBatch(
        Array.from({ length: 6 }, (_, index) => queuedAgentRunTask(index + 1)),
        { signal: new AbortController().signal },
      );

      await vi.advanceTimersByTimeAsync(0);
      expect(attempts).toHaveLength(5);
      attempts[0]!.outcome.resolve({
        task: attempts[0]!.task,
        agentId: 'agent-1',
        status: 'completed',
        result: 'completed 1',
      });

      await vi.advanceTimersByTimeAsync(699);
      expect(attempts).toHaveLength(5);

      await vi.advanceTimersByTimeAsync(1);
      expect(attempts).toHaveLength(6);

      attempts.slice(1).forEach((attempt, index) => {
        attempt.outcome.resolve({
          task: attempt.task,
          agentId: `agent-${String(index + 2)}`,
          status: 'completed',
          result: `completed ${String(index + 2)}`,
        });
      });
      await expect(running).resolves.toHaveLength(6);
    } finally {
      vi.useRealTimers();
    }
  });

  it('rate-limit phase starts when the first provider rate limit stops the normal ramp', async () => {
    vi.useFakeTimers();
    try {
      const controller = new AbortController();
      const { runBatch, attempts } = createMockAgentRunBatchRunner();
      const running = runBatch(
        Array.from({ length: 9 }, (_, index) => queuedAgentRunTask(index + 1)),
        { signal: controller.signal },
      );
      void running.catch(() => {});

      await vi.advanceTimersByTimeAsync(0);
      expect(attempts).toHaveLength(5);
      attempts.forEach((attempt) => {
        attempt.markReady();
      });

      attempts[0]!.outcome.resolve({ type: 'rate_limited', agentId: 'agent-1' });
      await vi.advanceTimersByTimeAsync(0);

      await vi.advanceTimersByTimeAsync(700);
      expect(attempts).toHaveLength(5);

      attempts[1]!.outcome.resolve({
        task: attempts[1]!.task,
        agentId: 'agent-2',
        status: 'completed',
        result: 'completed 2',
      });
      await vi.advanceTimersByTimeAsync(3000);
      expect(attempts).toHaveLength(6);
      expect(attempts[5]!.task.data).toBe(1);
      expect(attempts[5]!.retryAgentId).toBe('agent-1');

      controller.abort();
      await expect(running).rejects.toThrow();
    } finally {
      vi.useRealTimers();
    }
  });

  it('rate-limit phase requeues 429 tasks, emits suspended, and throttles launches', async () => {
    vi.useFakeTimers();
    try {
      const controller = new AbortController();
      const onSuspended = vi.fn();
      const { runBatch, attempts } = createMockAgentRunBatchRunner({ onSuspended });
      const running = runBatch(
        Array.from({ length: 8 }, (_, index) => queuedAgentRunTask(index + 1)),
        { signal: controller.signal },
      );
      void running.catch(() => {});

      await vi.advanceTimersByTimeAsync(0);
      expect(attempts).toHaveLength(5);

      attempts.forEach((attempt) => {
        attempt.markReady();
      });
      attempts[0]!.outcome.resolve({ type: 'rate_limited', agentId: 'agent-1' });
      attempts[1]!.outcome.resolve({ type: 'rate_limited', agentId: 'agent-2' });
      await vi.advanceTimersByTimeAsync(0);
      expect(onSuspended).toHaveBeenCalledTimes(2);
      expect(attempts).toHaveLength(5);

      await vi.advanceTimersByTimeAsync(500);
      expect(attempts).toHaveLength(5);

      await vi.advanceTimersByTimeAsync(2500);
      expect(attempts).toHaveLength(6);
      expect(attempts[5]!.task.data).toBe(2);
      expect(attempts[5]!.retryAgentId).toBe('agent-2');

      controller.abort();
      await expect(running).rejects.toThrow();
    } finally {
      vi.useRealTimers();
    }
  });

  it('fails the only unfinished task on provider rate limit instead of suspending forever', async () => {
    vi.useFakeTimers();
    try {
      const onSuspended = vi.fn();
      const { runBatch, attempts } = createMockAgentRunBatchRunner({ onSuspended });
      const running = runBatch(
        Array.from({ length: 2 }, (_, index) => queuedAgentRunTask(index + 1)),
        { signal: new AbortController().signal },
      );

      await vi.advanceTimersByTimeAsync(0);
      expect(attempts).toHaveLength(2);
      attempts.forEach((attempt) => {
        attempt.markReady();
      });

      attempts[0]!.outcome.resolve({
        task: attempts[0]!.task,
        agentId: 'agent-1',
        status: 'completed',
        result: 'completed 1',
      });
      await vi.advanceTimersByTimeAsync(0);

      attempts[1]!.outcome.resolve({ type: 'rate_limited', agentId: 'agent-2' });
      await expect(running).resolves.toMatchObject([
        {
          task: { data: 1 },
          agentId: 'agent-1',
          status: 'completed',
          result: 'completed 1',
        },
        {
          task: { data: 2 },
          agentId: 'agent-2',
          status: 'failed',
          state: 'started',
          error: 'Rate limited',
        },
      ]);
      expect(onSuspended).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it('rate-limit capacity blocks launches while active attempts fill all slots', async () => {
    vi.useFakeTimers();
    try {
      const controller = new AbortController();
      const { runBatch, attempts } = createMockAgentRunBatchRunner();
      const running = runBatch(
        Array.from({ length: 12 }, (_, index) => queuedAgentRunTask(index + 1)),
        { signal: controller.signal },
      );
      void running.catch(() => {});

      await vi.advanceTimersByTimeAsync(0);
      expect(attempts).toHaveLength(5);
      attempts.slice(0, 5).forEach((attempt) => {
        attempt.markReady();
      });

      for (let count = 6; count <= 12; count += 1) {
        await vi.advanceTimersByTimeAsync(700);
        expect(attempts).toHaveLength(count);
        attempts[count - 1]!.markReady();
      }

      attempts.slice(0, 12).forEach((attempt) => {
        attempt.markReady();
      });

      attempts[0]!.outcome.resolve({
        type: 'rate_limited',
        agentId: 'agent-1',
      });
      await vi.advanceTimersByTimeAsync(0);

      await vi.advanceTimersByTimeAsync(3000);
      expect(attempts).toHaveLength(12);

      controller.abort();
      await expect(running).rejects.toThrow();
    } finally {
      vi.useRealTimers();
    }
  });

  it('rate-limit recovery adds one capacity slot after three quiet minutes with queued work', async () => {
    vi.useFakeTimers();
    try {
      const controller = new AbortController();
      const { runBatch, attempts } = createMockAgentRunBatchRunner();
      const running = runBatch(
        Array.from({ length: 6 }, (_, index) => queuedAgentRunTask(index + 1)),
        { signal: controller.signal },
      );
      void running.catch(() => {});

      await vi.advanceTimersByTimeAsync(0);
      expect(attempts).toHaveLength(5);
      attempts.forEach((attempt) => {
        attempt.markReady();
      });

      attempts[0]!.outcome.resolve({ type: 'rate_limited', agentId: 'agent-1' });
      await vi.advanceTimersByTimeAsync(0);
      expect(attempts).toHaveLength(5);

      await vi.advanceTimersByTimeAsync(2000);
      attempts[1]!.outcome.resolve({ type: 'rate_limited', agentId: 'agent-2' });
      await vi.advanceTimersByTimeAsync(0);
      expect(attempts).toHaveLength(5);

      await vi.advanceTimersByTimeAsync(2000);
      attempts[2]!.outcome.resolve({ type: 'rate_limited', agentId: 'agent-3' });
      await vi.advanceTimersByTimeAsync(0);
      expect(attempts).toHaveLength(5);

      await vi.advanceTimersByTimeAsync(2000);
      attempts[3]!.outcome.resolve({ type: 'rate_limited', agentId: 'agent-4' });
      await vi.advanceTimersByTimeAsync(0);
      expect(attempts).toHaveLength(5);

      await vi.advanceTimersByTimeAsync(179_999);
      expect(attempts).toHaveLength(5);

      await vi.advanceTimersByTimeAsync(1);
      expect(attempts).toHaveLength(6);
      expect(attempts[5]!.task.data).toBe(4);
      expect(attempts[5]!.retryAgentId).toBe('agent-4');

      controller.abort();
      await expect(running).rejects.toThrow();
    } finally {
      vi.useRealTimers();
    }
  });

  it('rate-limit phase keeps launches bounded after repeated 429s', async () => {
    vi.useFakeTimers();
    try {
      const controller = new AbortController();
      const { runBatch, attempts } = createMockAgentRunBatchRunner();
      const running = runBatch(
        Array.from({ length: 8 }, (_, index) => queuedAgentRunTask(index + 1)),
        { signal: controller.signal },
      );
      void running.catch(() => {});

      await vi.advanceTimersByTimeAsync(0);
      expect(attempts).toHaveLength(5);
      attempts.forEach((attempt) => {
        attempt.markReady();
      });

      for (let index = 0; index < 3; index += 1) {
        attempts[index]!.outcome.resolve({
          type: 'rate_limited',
          agentId: `agent-${String(index + 1)}`,
        });
        await vi.advanceTimersByTimeAsync(0);
      }

      await vi.advanceTimersByTimeAsync(3000);
      expect(attempts).toHaveLength(6);
      expect(attempts[5]!.task.data).toBe(3);
      expect(attempts[5]!.retryAgentId).toBe('agent-3');

      await vi.advanceTimersByTimeAsync(3000);
      expect(attempts).toHaveLength(7);
      expect(attempts[6]!.task.data).toBe(2);
      expect(attempts[6]!.retryAgentId).toBe('agent-2');

      controller.abort();
      await expect(running).rejects.toThrow();
    } finally {
      vi.useRealTimers();
    }
  });

  it('rate-limit phase schedules another launch after starting while capacity remains', async () => {
    vi.useFakeTimers();
    try {
      const controller = new AbortController();
      const { runBatch, attempts } = createMockAgentRunBatchRunner();
      const running = runBatch(
        Array.from({ length: 8 }, (_, index) => queuedAgentRunTask(index + 1)),
        { signal: controller.signal },
      );
      void running.catch(() => {});

      await vi.advanceTimersByTimeAsync(0);
      expect(attempts).toHaveLength(5);
      attempts.forEach((attempt) => {
        attempt.markReady();
      });

      attempts[0]!.outcome.resolve({ type: 'rate_limited', agentId: 'agent-1' });
      await vi.advanceTimersByTimeAsync(0);
      expect(attempts).toHaveLength(5);

      attempts[1]!.outcome.resolve({
        task: attempts[1]!.task,
        agentId: 'agent-2',
        status: 'completed',
        result: 'completed 2',
      });
      attempts[2]!.outcome.resolve({
        task: attempts[2]!.task,
        agentId: 'agent-3',
        status: 'completed',
        result: 'completed 3',
      });
      await vi.advanceTimersByTimeAsync(0);
      expect(attempts).toHaveLength(5);

      await vi.advanceTimersByTimeAsync(2_999);
      expect(attempts).toHaveLength(5);

      await vi.advanceTimersByTimeAsync(1);
      expect(attempts).toHaveLength(6);
      expect(attempts[5]!.task.data).toBe(1);
      expect(attempts[5]!.retryAgentId).toBe('agent-1');

      await vi.advanceTimersByTimeAsync(2_999);
      expect(attempts).toHaveLength(6);

      await vi.advanceTimersByTimeAsync(1);
      expect(attempts).toHaveLength(7);
      expect(attempts[6]!.task.data).toBe(6);
      expect(attempts[6]!.retryAgentId).toBeUndefined();

      controller.abort();
      await expect(running).rejects.toThrow();
    } finally {
      vi.useRealTimers();
    }
  });

  it('task timeout fails only that task', async () => {
    vi.useFakeTimers();
    try {
      const { runBatch, attempts } = createMockAgentRunBatchRunner();
      const running = runBatch([{ ...queuedAgentRunTask(1), timeout: 10_000 }], {
        signal: new AbortController().signal,
      });

      await vi.advanceTimersByTimeAsync(0);
      attempts[0]!.markReady();

      await vi.advanceTimersByTimeAsync(9999);
      expect(attempts).toHaveLength(1);

      await vi.advanceTimersByTimeAsync(1);
      await expect(running).resolves.toMatchObject([
        {
          task: { data: 1 },
          agentId: 'agent-1',
          status: 'failed',
          state: 'started',
          error: 'Subagent timed out.',
        },
      ]);
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not spend task timeout while the task is queued', async () => {
    vi.useFakeTimers();
    try {
      let settled = false;
      const { runBatch, attempts } = createMockAgentRunBatchRunner();
      const running = runBatch(
        [
          ...Array.from({ length: 5 }, (_, index) => queuedAgentRunTask(index + 1)),
          { ...queuedAgentRunTask(6), timeout: 1000 },
        ],
        { signal: new AbortController().signal },
      );
      void running.finally(() => {
        settled = true;
      });

      await vi.advanceTimersByTimeAsync(0);
      expect(attempts).toHaveLength(5);

      await vi.advanceTimersByTimeAsync(699);
      expect(attempts).toHaveLength(5);

      await vi.advanceTimersByTimeAsync(1);
      expect(attempts).toHaveLength(6);

      await vi.advanceTimersByTimeAsync(999);
      expect(settled).toBe(false);

      attempts.slice(0, 5).forEach((attempt, index) => {
        attempt.outcome.resolve({
          task: attempt.task,
          agentId: `agent-${String(index + 1)}`,
          status: 'completed',
          result: `completed ${String(index + 1)}`,
        });
      });
      await vi.advanceTimersByTimeAsync(1);

      await expect(running).resolves.toMatchObject([
        { task: { data: 1 }, status: 'completed' },
        { task: { data: 2 }, status: 'completed' },
        { task: { data: 3 }, status: 'completed' },
        { task: { data: 4 }, status: 'completed' },
        { task: { data: 5 }, status: 'completed' },
        {
          task: { data: 6 },
          agentId: 'agent-6',
          status: 'failed',
          state: 'started',
          error: 'Subagent timed out.',
        },
      ]);
    } finally {
      vi.useRealTimers();
    }
  });

  it('rate-limit phase continues launching after rate-limited attempts settle', async () => {
    vi.useFakeTimers();
    try {
      const controller = new AbortController();
      const { runBatch, attempts } = createMockAgentRunBatchRunner({
        readyDelay: (attemptIndex) => (attemptIndex >= 7 ? 100 : undefined),
      });

      const running = runBatch(
        Array.from({ length: 9 }, (_, index) => queuedAgentRunTask(index + 1)),
        { signal: controller.signal },
      );
      void running.catch(() => {});

      await vi.advanceTimersByTimeAsync(0);
      expect(attempts).toHaveLength(5);
      attempts.slice(0, 5).forEach((attempt) => {
        attempt.markReady();
      });

      await vi.advanceTimersByTimeAsync(700);
      expect(attempts).toHaveLength(6);

      await vi.advanceTimersByTimeAsync(700);
      expect(attempts).toHaveLength(7);

      attempts[5]!.outcome.resolve({ type: 'rate_limited', agentId: 'agent-6' });
      attempts[6]!.outcome.resolve({ type: 'rate_limited', agentId: 'agent-7' });
      attempts[0]!.outcome.resolve({
        task: attempts[0]!.task,
        agentId: 'agent-1',
        status: 'completed',
        result: 'completed 1',
      });
      attempts[1]!.outcome.resolve({
        task: attempts[1]!.task,
        agentId: 'agent-2',
        status: 'completed',
        result: 'completed 2',
      });
      await vi.advanceTimersByTimeAsync(12_000);
      expect(attempts).toHaveLength(8);
      expect(attempts[7]!.task.data).toBe(7);
      expect(attempts[7]!.retryAgentId).toBe('agent-7');

      controller.abort();
      await expect(running).rejects.toThrow();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('AgentRunBatch max concurrency cap', () => {
  it('caps in-flight tasks at maxConcurrency during the normal phase', async () => {
    vi.useFakeTimers();
    try {
      const { runBatch, attempts } = createMockAgentRunBatchRunner({ maxConcurrency: 3 });
      const running = runBatch(
        Array.from({ length: 9 }, (_, index) => queuedAgentRunTask(index + 1)),
        { signal: new AbortController().signal },
      );
      const resolved = new Set<number>();
      const resolveOne = (index: number) => {
        const attempt = attempts[index]!;
        resolved.add(index);
        attempt.outcome.resolve({
          task: attempt.task,
          agentId: `agent-${String(index + 1)}`,
          status: 'completed',
          result: `result ${String(index + 1)}`,
        });
      };
      const inFlight = () => attempts.length - resolved.size;

      await vi.advanceTimersByTimeAsync(0);
      expect(attempts).toHaveLength(3);
      expect(inFlight()).toBe(3);

      await vi.advanceTimersByTimeAsync(700);
      expect(attempts).toHaveLength(3);

      resolveOne(0);
      await vi.advanceTimersByTimeAsync(0);
      expect(attempts).toHaveLength(4);
      expect(inFlight()).toBeLessThanOrEqual(3);

      resolveOne(1);
      await vi.advanceTimersByTimeAsync(0);
      expect(attempts).toHaveLength(5);
      expect(inFlight()).toBeLessThanOrEqual(3);

      resolveOne(2);
      await vi.advanceTimersByTimeAsync(0);
      expect(attempts).toHaveLength(5);
      await vi.advanceTimersByTimeAsync(700);
      expect(attempts).toHaveLength(6);
      expect(inFlight()).toBeLessThanOrEqual(3);

      for (let index = 3; index < 9; index += 1) {
        resolveOne(index);
        await vi.advanceTimersByTimeAsync(700);
        expect(inFlight()).toBeLessThanOrEqual(3);
      }

      const results = await running;
      expect(results).toHaveLength(9);
      expect(results.every((result) => result.status === 'completed')).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('AgentRunBatch swarm item forwarding', () => {
  function recordingLauncher() {
    const spawned: AgentSpawnAttemptOptions[] = [];
    let nextId = 1;
    const launcher: AgentRunBatchLauncher = {
      spawn: vi.fn(async (options) => {
        spawned.push(options);
        return {
          agentId: `agent-${String(nextId++)}`,
          profileName: options.profileName,
          completion: Promise.resolve({ result: 'ok' }),
        };
      }),
      resume: vi.fn(async () => {
        throw new Error('unexpected resume');
      }),
      retry: vi.fn(async () => {
        throw new Error('unexpected retry');
      }),
    };
    return { launcher, spawned };
  }

  function spawnTask(swarmItem?: string): QueuedAgentRunTask {
    return {
      kind: 'spawn',
      data: {},
      profileName: 'subagent',
      parentToolCallId: 'call_swarm',
      prompt: 'Review the file',
      description: 'Review #1 (subagent)',
      swarmItem,
      runInBackground: false,
    };
  }

  it('forwards swarmItem from a spawn task to launcher.spawn', async () => {
    const { launcher, spawned } = recordingLauncher();

    const results = await new AgentRunBatch(launcher, [spawnTask('src/a.ts')]).run();

    expect(launcher.spawn).toHaveBeenCalledOnce();
    expect(spawned[0]).toMatchObject({
      profileName: 'subagent',
      swarmItem: 'src/a.ts',
    });
    expect(results).toMatchObject([{ status: 'completed', agentId: 'agent-1' }]);
  });

  it('leaves swarmItem undefined for spawn tasks without one', async () => {
    const { launcher, spawned } = recordingLauncher();

    await new AgentRunBatch(launcher, [spawnTask()]).run();

    expect(launcher.spawn).toHaveBeenCalledOnce();
    expect(spawned[0]?.swarmItem).toBeUndefined();
  });
});

describe('SessionSwarmService metadata compatibility', () => {
  let disposables: DisposableStore;
  let ix: TestInstantiationService;
  let agents: Record<string, AgentMeta>;
  let handles: Map<string, IAgentScopeHandle>;
  let lifecycle: IAgentLifecycleService;
  let subagents: ISessionSubagentService;
  let createAgent: ReturnType<typeof vi.fn>;
  let runAgent: ReturnType<typeof vi.fn>;
  let eventBus: IEventBus;

  beforeEach(() => {
    disposables = new DisposableStore();
    ix = disposables.add(new TestInstantiationService());
    agents = {};
    handles = new Map();
    eventBus = eventBusStub();
    lifecycle = lifecycleStub(handles, eventBus);
    subagents = subagentStub();
    createAgent = lifecycle.create as ReturnType<typeof vi.fn>;
    runAgent = subagents.run as ReturnType<typeof vi.fn>;
    handles.set('main', agentHandle('main', lifecycle, eventBus));

    ix.stub(IAgentLifecycleService, lifecycle);
    ix.stub(ISessionSubagentService, subagents);
    ix.stub(ISessionAgentProfileCatalog, {
      _serviceBrand: undefined,
      ready: Promise.resolve(),
      get: (name: string) =>
        name === 'coder'
          ? { name: 'coder', tools: [], systemPrompt: () => '' }
          : undefined,
      getDefault: () => ({ name: 'agent', tools: [], systemPrompt: () => '' }),
      list: () => [],
    });
    ix.stub(
      ISessionContext,
      makeSessionContext({
        sessionId: 's1',
        workspaceId: 'w1',
        sessionDir: '/tmp/kimi/s1',
        sessionScope: 'sessions/w1/s1',
        cwd: '/repo',
      }),
    );
    ix.stub(ISessionMetadata, {
      _serviceBrand: undefined,
      ready: Promise.resolve(),
      onDidChangeMetadata: Event.None as Event<SessionMetadataChangedEvent>,
      read: async () => ({
        id: 's1',
        createdAt: 0,
        updatedAt: 0,
        archived: false,
        agents,
      }),
      update: async () => {},
      setTitle: async () => {},
      setArchived: async () => {},
      registerAgent: async (agentId, meta) => {
        agents[agentId] = meta;
      },
    });
    ix.stub(ISessionProcessRunner, {
      _serviceBrand: undefined,
      exec: async () => {
        throw new Error('unexpected process exec');
      },
    });
    ix.stub(ILogService, stubLog());
    ix.set(ISessionSwarmService, new SyncDescriptor(SessionSwarmService));
  });

  afterEach(() => {
    disposables.dispose();
  });

  it('reads swarm items from caller-owned v2 labels and legacy v1 metadata', async () => {
    agents['v2-child'] = {
      labels: { parentAgentId: 'main', swarmItem: 'src/a.ts' },
    };
    agents['legacy-child'] = {
      type: 'sub',
      parentAgentId: 'main',
      swarmItem: 'src/legacy.ts',
    };
    agents['other-child'] = {
      labels: { parentAgentId: 'other', swarmItem: 'src/other.ts' },
    };

    const service = ix.get(ISessionSwarmService);

    await expect(
      service.getSwarmItem({ callerAgentId: 'main', agentId: 'v2-child' }),
    ).resolves.toBe('src/a.ts');
    await expect(
      service.getSwarmItem({ callerAgentId: 'main', agentId: 'legacy-child' }),
    ).resolves.toBe('src/legacy.ts');
    await expect(
      service.getSwarmItem({ callerAgentId: 'main', agentId: 'other-child' }),
    ).resolves.toBeUndefined();
    await expect(
      service.getSwarmItem({ callerAgentId: 'main', agentId: 'missing' }),
    ).resolves.toBeUndefined();
  });

  it('prefers labels over legacy metadata fields when both are present', async () => {
    agents['mixed-child'] = {
      labels: { parentAgentId: 'main', swarmItem: 'src/labels.ts' },
      type: 'sub',
      parentAgentId: 'other',
      swarmItem: 'src/legacy.ts',
    };

    const service = ix.get(ISessionSwarmService);

    await expect(
      service.getSwarmItem({ callerAgentId: 'main', agentId: 'mixed-child' }),
    ).resolves.toBe('src/labels.ts');
    await expect(
      service.getSwarmItem({ callerAgentId: 'other', agentId: 'mixed-child' }),
    ).resolves.toBeUndefined();
  });

  it('normalizes legacy subagent metadata into labels for new writes', () => {
    expect(
      labelsFromAgentMeta({
        type: 'sub',
        parentAgentId: 'main',
        swarmItem: 'src/legacy.ts',
      }),
    ).toEqual({ parentAgentId: 'main', swarmItem: 'src/legacy.ts' });
    expect(
      labelsFromAgentMeta({
        labels: { parentAgentId: 'main', swarmItem: 'src/labels.ts', custom: 'kept' },
        type: 'sub',
        parentAgentId: 'other',
        swarmItem: 'src/legacy.ts',
      }),
    ).toEqual({ parentAgentId: 'main', swarmItem: 'src/labels.ts', custom: 'kept' });
  });

  it('persists caller ownership and swarm item labels on spawned children', async () => {
    const service = ix.get(ISessionSwarmService);

    await expect(
      service.run({
        callerAgentId: 'main',
        tasks: [spawnSessionTask('src/a.ts')],
      }),
    ).resolves.toMatchObject([
      {
        agentId: 'agent-new',
        status: 'completed',
        result: 'child summary',
      },
    ]);

    expect(createAgent).toHaveBeenCalledWith(
      expect.objectContaining({
        binding: {
          profile: 'coder',
          model: 'kimi-test',
          thinking: 'medium',
          cwd: '/repo',
        },
        labels: { parentAgentId: 'main', swarmItem: 'src/a.ts' },
      }),
    );
  });

  it('inherits parent user tools on spawned children', async () => {
    const parentUserTools = userToolServiceStub();
    const childUserTools = userToolServiceStub();
    handles.set(
      'main',
      agentHandle('main', lifecycle, eventBus, {}, new Map([
        [IAgentUserToolService, parentUserTools],
      ])),
    );
    createAgent.mockImplementationOnce((opts: CreateAgentOptions = {}) => {
      const id = opts.agentId ?? 'agent-new';
      const handle = agentHandle(
        id,
        lifecycle,
        eventBus,
        {
          profileName: opts.binding?.profile ?? 'coder',
          modelAlias: opts.binding?.model ?? 'kimi-test',
          thinkingLevel: opts.binding?.thinking ?? 'medium',
          cwd: opts.binding?.cwd ?? '/repo',
        },
        new Map([[IAgentUserToolService, childUserTools]]),
      );
      handles.set(id, handle);
      return handle;
    });
    const service = ix.get(ISessionSwarmService);

    await service.run({
      callerAgentId: 'main',
      tasks: [spawnSessionTask('src/a.ts')],
    });

    expect(childUserTools.inheritUserTools).toHaveBeenCalledWith(parentUserTools);
  });

  it('keeps v1 resume ownership errors inside the per-subagent result', async () => {
    agents['other-child'] = {
      labels: { parentAgentId: 'other', swarmItem: 'src/other.ts' },
    };
    handles.set('other-child', agentHandle('other-child', lifecycle, eventBusStub()));
    const service = ix.get(ISessionSwarmService);

    await expect(
      service.run({
        callerAgentId: 'main',
        tasks: [resumeSessionTask('other-child')],
      }),
    ).resolves.toMatchObject([
      {
        status: 'failed',
        state: 'not_started',
        error: 'Agent instance "other-child" does not belong to this parent agent',
      },
    ]);
    expect(runAgent).not.toHaveBeenCalled();
  });

  it('realigns resumed children to the caller current model', async () => {
    agents['agent-existing'] = {
      labels: { parentAgentId: 'main' },
    };
    const child = agentHandle('agent-existing', lifecycle, eventBus, {
      profileName: 'explore',
      modelAlias: 'stale-model',
    });
    handles.set('agent-existing', child);
    const service = ix.get(ISessionSwarmService);

    await expect(
      service.run({
        callerAgentId: 'main',
        tasks: [resumeSessionTask('agent-existing')],
      }),
    ).resolves.toMatchObject([{ status: 'completed', agentId: 'agent-existing' }]);

    expect(child.accessor.get(IAgentProfileService).data().modelAlias).toBe('kimi-test');
    expect(runAgent).toHaveBeenCalledWith(
      'agent-existing',
      { kind: 'prompt', prompt: 'Continue' },
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
  });

  it('does not emit spawned again when a rate-limited child retries', async () => {
    vi.useFakeTimers();
    try {
      agents['agent-retry'] = {
        labels: { parentAgentId: 'main' },
      };
      agents['agent-blocker'] = {
        labels: { parentAgentId: 'main' },
      };
      handles.set('agent-retry', agentHandle('agent-retry', lifecycle, eventBus));
      handles.set('agent-blocker', agentHandle('agent-blocker', lifecycle, eventBus));
      const rateLimited = createControlledPromise<{ summary: string }>();
      const blocker = createControlledPromise<{ summary: string }>();
      const published: DomainEvent[] = [];
      (eventBus.publish as ReturnType<typeof vi.fn>).mockImplementation((event: DomainEvent) => {
        published.push(event);
      });
      let retryRuns = 0;
      runAgent.mockImplementation((agentId, request, options) => {
        options?.onReady?.();
        if (agentId === 'agent-retry') {
          retryRuns += 1;
          return {
            agentId,
            turn: {} as never,
            completion:
              retryRuns === 1
                ? rateLimited
                : Promise.resolve({ summary: 'recovered summary' }),
          };
        }
        return { agentId, turn: {} as never, completion: blocker };
      });
      const service = ix.get(ISessionSwarmService);

      const running = service.run({
        callerAgentId: 'main',
        tasks: [resumeSessionTask('agent-retry'), resumeSessionTask('agent-blocker')],
      });
      await vi.advanceTimersByTimeAsync(0);
      rateLimited.reject(new APIProviderRateLimitError('Rate limited'));
      await vi.advanceTimersByTimeAsync(0);
      blocker.resolve({ summary: 'blocker summary' });
      await vi.advanceTimersByTimeAsync(3_000);
      await running;

      expect(
        published
          .filter((event) => event.type === 'subagent.spawned')
          .map((event) => event.subagentId),
      ).toEqual(['agent-retry', 'agent-blocker']);
      expect(
        runAgent.mock.calls
          .filter(([agentId]) => agentId === 'agent-retry')
          .map(([, request]) => request),
      ).toEqual([{ kind: 'prompt', prompt: 'Continue' }, { kind: 'retry' }]);
    } finally {
      vi.useRealTimers();
    }
  });

  it('rejects resume of an already running child before launching or emitting spawned', async () => {
    agents['agent-existing'] = {
      labels: { parentAgentId: 'main' },
    };
    handles.set(
      'agent-existing',
      agentHandle('agent-existing', lifecycle, eventBus, {}, new Map([
        [
          IAgentLoopService,
          {
            _serviceBrand: undefined,
            status: () => ({ state: 'running', activeTurnId: 1, pendingTurnIds: [], hasPendingRequests: true }),
          },
        ],
      ])),
    );
    const service = ix.get(ISessionSwarmService);

    await expect(
      service.run({
        callerAgentId: 'main',
        tasks: [resumeSessionTask('agent-existing')],
      }),
    ).resolves.toMatchObject([
      {
        status: 'failed',
        state: 'not_started',
        error:
          'Agent instance "agent-existing" is already running and cannot run concurrently',
      },
    ]);
    expect(runAgent).not.toHaveBeenCalled();
    expect(eventBus.publish).not.toHaveBeenCalledWith(
      expect.objectContaining({ type: 'subagent.spawned' }),
    );
  });
});

function spawnSessionTask(swarmItem?: string): SessionSwarmTask {
  return {
    kind: 'spawn',
    data: {},
    profileName: 'coder',
    parentToolCallId: 'call_swarm',
    prompt: 'Review the file',
    description: 'Review #1 (coder)',
    swarmIndex: 1,
    swarmItem,
    runInBackground: false,
  };
}

function resumeSessionTask(agentId: string): SessionSwarmTask {
  return {
    kind: 'resume',
    data: {},
    profileName: 'subagent',
    parentToolCallId: 'call_swarm',
    prompt: 'Continue',
    description: 'Resume #1 (resume)',
    swarmIndex: 1,
    runInBackground: false,
    resumeAgentId: agentId,
  };
}

function lifecycleStub(
  handles: Map<string, IAgentScopeHandle>,
  eventBus: IEventBus,
): IAgentLifecycleService {
  const lifecycle = {
    _serviceBrand: undefined,
    onDidCreate: Event.None,
    onDidDispose: Event.None,
    create: vi.fn(async (opts: CreateAgentOptions = {}) => {
      if (opts.agentId !== undefined) {
        const existing = handles.get(opts.agentId);
        if (existing !== undefined) return existing;
      }
      const id = opts.agentId ?? 'agent-new';
      const handle = agentHandle(id, lifecycle as IAgentLifecycleService, eventBus, {
        profileName: opts.binding?.profile ?? 'coder',
        modelAlias: opts.binding?.model ?? 'kimi-test',
        thinkingLevel: opts.binding?.thinking ?? 'medium',
        cwd: opts.binding?.cwd ?? '/repo',
      });
      handles.set(id, handle);
      return handle;
    }),
    fork: vi.fn(),
    get: (agentId: string) => handles.get(agentId),
    list: () => [...handles.values()],
    remove: async (agentId: string) => {
      handles.delete(agentId);
    },
    broadcastPermissionMode: () => {},
  };
  return lifecycle as IAgentLifecycleService;
}

function subagentStub(): ISessionSubagentService {
  return {
    _serviceBrand: undefined,
    hooks: createHooks<AgentTaskHooks, keyof AgentTaskHooks>(['onWillStartAgentTask']),
    onDidStopAgentTask: Event.None,
    run: vi.fn(async (agentId: string) => ({
      agentId,
      turn: {} as never,
      completion: Promise.resolve({ summary: 'child summary' }),
    })),
    notifyAgentTaskStopped: () => {},
  } as ISessionSubagentService;
}

function agentHandle(
  id: string,
  lifecycle: IAgentLifecycleService,
  eventBus: IEventBus,
  data: Partial<ProfileData> = {},
  services: ReadonlyMap<unknown, unknown> = new Map(),
): IAgentScopeHandle {
  const profile = profileService({
    cwd: '/repo',
    modelAlias: 'kimi-test',
    modelCapabilities: {} as never,
    profileName: 'agent',
    thinkingLevel: 'medium',
    systemPrompt: '',
    ...data,
  });
  const permissionMode = {
    _serviceBrand: undefined,
    mode: 'auto',
    setMode: () => {},
    onDidChangeMode: Event.None,
  } as IAgentPermissionModeService;
  return {
    id,
    kind: LifecycleScope.Agent,
    accessor: {
      get: ((serviceId: unknown) => {
        const service = services.get(serviceId);
        if (service !== undefined) return service;
        if (serviceId === IAgentProfileService) return profile;
        if (serviceId === IAgentPermissionModeService) return permissionMode;
        if (serviceId === IAgentLoopService) {
          return {
            _serviceBrand: undefined,
            status: () => ({ state: 'idle', pendingTurnIds: [], hasPendingRequests: false }),
          } as unknown as IAgentLoopService;
        }
        if (serviceId === IAgentUserToolService) return userToolServiceStub();
        if (serviceId === IEventBus) return eventBus;
        if (serviceId === ITelemetryService) return noopTelemetryService;
        if (serviceId === IAgentLifecycleService) return lifecycle;
        return undefined;
      }) as IAgentScopeHandle['accessor']['get'],
    },
    dispose: () => {},
  };
}

function profileService(data: ProfileData): IAgentProfileService {
  let current = data;
  return {
    _serviceBrand: undefined,
    data: () => current,
    update: (changed) => {
      current = { ...current, ...changed };
    },
  } as IAgentProfileService;
}

function userToolServiceStub(): IAgentUserToolService {
  return {
    _serviceBrand: undefined,
    list: () => [],
    inheritUserTools: vi.fn<(parent: IAgentUserToolService) => void>(),
    register: () => {},
    unregister: () => {},
  };
}

function eventBusStub(): IEventBus {
  return {
    _serviceBrand: undefined,
    publish: vi.fn((_: DomainEvent) => {}),
    subscribe: vi.fn(() => ({ dispose: () => {} })) as IEventBus['subscribe'],
  };
}

type MockAgentRunAttemptOutcome<T> =
  | AgentRunResult<T>
  | {
      readonly type: 'rate_limited';
      readonly agentId: string;
    };

type MockAgentRunAttemptRecord = {
  readonly task: QueuedAgentRunTask<number>;
  readonly retryAgentId?: string;
  readonly markReady: () => void;
  readonly outcome: ReturnType<typeof createControlledPromise<MockAgentRunAttemptOutcome<number>>>;
};

type MockAgentRunBatchRunnerOptions = {
  readonly onSuspended?: (event: AgentRunSuspendedEvent) => void;
  readonly readyDelay?: (attemptIndex: number) => number | undefined;
  readonly maxConcurrency?: number;
};

function createMockAgentRunBatchRunner(
  options: MockAgentRunBatchRunnerOptions = {},
): {
  readonly runBatch: <T>(
    tasks: readonly QueuedAgentRunTask<T>[],
    options?: { readonly signal?: AbortSignal },
  ) => Promise<Array<AgentRunResult<T>>>;
  readonly attempts: MockAgentRunAttemptRecord[];
} {
  const attempts: MockAgentRunAttemptRecord[] = [];
  let activeTasks: readonly QueuedAgentRunTask<unknown>[] = [];

  const createHandle = <T,>(
    runOptions: AgentRunAttemptOptions,
    agentId: string,
    profileName: string,
    retryAgentId?: string,
  ): AgentRunAttemptHandle => {
    const task = findMockAgentRunTask<T>(activeTasks, runOptions);
    const outcome = createControlledPromise<MockAgentRunAttemptOutcome<T>>();
    const markReady = () => {
      runOptions.onReady?.();
    };
    const attemptIndex = attempts.length;
    attempts.push({
      task: task as unknown as QueuedAgentRunTask<number>,
      retryAgentId,
      markReady,
      outcome: outcome as unknown as MockAgentRunAttemptRecord['outcome'],
    });

    const delay = options.readyDelay?.(attemptIndex);
    if (delay !== undefined) setTimeout(markReady, delay);

    return {
      agentId,
      profileName,
      completion: completionFromMockAgentRunOutcome(outcome, runOptions.signal),
    };
  };

  const launcher: AgentRunBatchLauncher = {
    spawn: async (spawnOptions) => {
      const task = findMockAgentRunTask(activeTasks, spawnOptions);
      return createHandle(
        spawnOptions,
        mockAgentRunId(task, attempts.length),
        spawnOptions.profileName,
      );
    },
    resume: async (agentId, runOptions) => createHandle(runOptions, agentId, 'subagent'),
    retry: async (agentId, runOptions) => createHandle(runOptions, agentId, 'subagent', agentId),
    suspended: (event) => {
      options.onSuspended?.(event);
    },
  };

  return {
    runBatch: <T,>(
      tasks: readonly QueuedAgentRunTask<T>[],
      runOptions?: { readonly signal?: AbortSignal },
    ) => {
      activeTasks = tasks.map((task) => ({
        ...task,
        signal: task.signal ?? runOptions?.signal,
      }));
      return new AgentRunBatch(launcher, activeTasks as readonly QueuedAgentRunTask<T>[], {
        maxConcurrency: options.maxConcurrency,
      }).run();
    },
    attempts,
  };
}

function findMockAgentRunTask<T>(
  tasks: readonly QueuedAgentRunTask<unknown>[],
  options: AgentRunAttemptOptions,
): QueuedAgentRunTask<T> {
  const task = tasks.find(
    (candidate) =>
      candidate.prompt === options.prompt &&
      candidate.parentToolCallId === options.parentToolCallId,
  );
  if (task === undefined) {
    throw new Error(`No mock queued task for prompt "${options.prompt}"`);
  }
  return task as QueuedAgentRunTask<T>;
}

function mockAgentRunId(task: QueuedAgentRunTask<unknown>, attemptIndex: number): string {
  if (typeof task.data === 'number') return `agent-${String(task.data)}`;
  return `agent-${String(attemptIndex + 1)}`;
}

function completionFromMockAgentRunOutcome<T>(
  outcome: ReturnType<typeof createControlledPromise<MockAgentRunAttemptOutcome<T>>>,
  signal: AbortSignal,
): AgentRunAttemptHandle['completion'] {
  return new Promise((resolve, reject) => {
    const abort = () => {
      reject(signal.reason ?? new Error('Aborted'));
    };
    signal.addEventListener('abort', abort, { once: true });
    outcome.then(
      (result) => {
        signal.removeEventListener('abort', abort);
        if (isMockAgentRunRateLimitOutcome(result)) {
          reject(new APIProviderRateLimitError('Rate limited', result.agentId));
          return;
        }
        if (result.status === 'completed') {
          resolve({ result: result.result ?? '', usage: result.usage });
          return;
        }
        reject(new Error(result.error ?? result.status));
      },
      (error: unknown) => {
        signal.removeEventListener('abort', abort);
        reject(error);
      },
    );
  });
}

function isMockAgentRunRateLimitOutcome<T>(
  outcome: MockAgentRunAttemptOutcome<T>,
): outcome is Extract<MockAgentRunAttemptOutcome<T>, { readonly type: 'rate_limited' }> {
  return 'type' in outcome && outcome.type === 'rate_limited';
}

function queuedAgentRunTask(index: number): QueuedAgentRunTask<number> {
  return {
    kind: 'spawn',
    data: index,
    profileName: 'coder',
    parentToolCallId: 'call_swarm',
    prompt: `Review item-${String(index)}`,
    description: `Review #${String(index)}`,
    runInBackground: false,
  };
}

import { createControlledPromise } from '@antfu/utils';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { IAgentScopeHandle } from '#/_base/di/scope';
import { LifecycleScope } from '#/app/scopes';
import { SyncDescriptor } from '#/_base/di/descriptors';
import { DisposableStore } from '#/_base/di/lifecycle';
import { TestInstantiationService } from '#/_base/di/test';
import { Event } from '#/_base/event';
import type { AgentContext } from '#/agent/agentContext/agentContext';
import { userCancellationReason } from '#/_base/utils/abort';
import { Error2, ErrorCodes } from '#/errors';
import { IAgentPermissionModeService } from '#/agent/permissionMode/permissionMode';
import { IAgentScopeContext } from '#/agent/scopeContext/scopeContext';
import { IAgentProfileService, type ProfileData } from '#/agent/profile/profile';
import { IAgentLoopService } from '#/agent/loop/loop';
import { IAgentUserToolService } from '#/agent/userTool/userTool';
import { IEventBus } from '#/app/event/eventBus';
import type { Event2 } from '#/app/event/event2';
import { APIProviderRateLimitError } from '#/llm-adapter/contract/errors';
import { ITelemetryService, noopTelemetryService } from '#/app/telemetry/telemetry';
import {
  IAgentLifecycleService,
  type CreateAgentOptions,
} from '#/session/agentLifecycle/agentLifecycle';
import { labelsFromAgentMeta } from '#/session/agentLifecycle/subagentMetadata';
import { createHooks } from '#/hooks';
import {
  type AgentRunHandle,
  type AgentTaskHooks,
  ISessionSubagentService,
} from '#/session/subagent/subagent';
import {
  type SpawnSubagentOptions,
  type SubagentSpawnPlanInput,
} from '#/session/subagent/spawn';
import {
  ISessionMetadata,
  type AgentMeta,
  type SessionMetadataChangedEvent,
} from '#/session/sessionMetadata/sessionMetadata';
import { IEventDispatcher } from '#/state/eventDispatcher';
import { IAgentRuntimeBindingService } from '#/agent/runtimeBinding/runtimeBinding';
import {
  AgentRunBatch,
  resolveSwarmMaxConcurrency,
  type AgentRunAbandonedEvent,
  type AgentRunAttemptHandle,
  type AgentRunAttemptOptions,
  type AgentRunBatchLauncher,
  type AgentRunResult,
  type AgentRunSuspendedEvent,
  type AgentSpawnAttemptOptions,
  type QueuedAgentRunTask,
} from '#/features/swarm/session/agentRunBatch';
import { ISessionSwarmService, type SessionSwarmSpawnTask, type SessionSwarmTask } from '#/features/swarm/session/sessionSwarm';
import { SessionSwarmService } from '#/features/swarm/session/sessionSwarmService';

import { stubAgentContext } from '../../agent/agentContext/stubs';

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

  it('a non-positive task timeout means unbounded (v1 parity)', async () => {
    vi.useFakeTimers();
    try {
      const { runBatch, attempts } = createMockAgentRunBatchRunner();
      const running = runBatch([{ ...queuedAgentRunTask(1), timeout: 0 }], {
        signal: new AbortController().signal,
      });

      await vi.advanceTimersByTimeAsync(0);
      attempts[0]!.markReady();
      await vi.advanceTimersByTimeAsync(60_000);

      attempts[0]!.outcome.resolve({
        task: attempts[0]!.task,
        agentId: 'agent-1',
        status: 'completed',
        result: 'done',
      });
      await vi.advanceTimersByTimeAsync(0);
      await expect(running).resolves.toMatchObject([
        { task: { data: 1 }, agentId: 'agent-1', status: 'completed' },
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

describe('AgentRunBatch abandoned callback', () => {
  it('user cancellation abandons rate-limit-suspended agents without touching active or completed ones', async () => {
    vi.useFakeTimers();
    try {
      const controller = new AbortController();
      const onAbandoned = vi.fn();
      const { runBatch, attempts } = createMockAgentRunBatchRunner({ onAbandoned });
      const running = runBatch(
        Array.from({ length: 4 }, (_, index) => queuedAgentRunTask(index + 1)),
        { signal: controller.signal },
      );

      await vi.advanceTimersByTimeAsync(0);
      expect(attempts).toHaveLength(4);
      attempts.forEach((attempt) => {
        attempt.markReady();
      });

      attempts[0]!.outcome.resolve({ type: 'rate_limited', agentId: 'agent-1' });
      attempts[1]!.outcome.resolve({
        task: attempts[1]!.task,
        agentId: 'agent-2',
        status: 'completed',
        result: 'completed 2',
      });
      await vi.advanceTimersByTimeAsync(0);

      controller.abort(userCancellationReason());
      const results = await running;

      expect(results.map((result) => ({ data: result.task.data, status: result.status }))).toEqual([
        { data: 1, status: 'aborted' },
        { data: 2, status: 'completed' },
        { data: 3, status: 'aborted' },
        { data: 4, status: 'aborted' },
      ]);
      expect(onAbandoned).toHaveBeenCalledTimes(1);
      expect(onAbandoned).toHaveBeenCalledWith(
        expect.objectContaining({ agentId: 'agent-1', task: expect.objectContaining({ data: 1 }) }),
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it('abandons rate-limit-suspended agents when the batch aborts without a user-cancellation reason', async () => {
    vi.useFakeTimers();
    try {
      const controller = new AbortController();
      const onAbandoned = vi.fn();
      const { runBatch, attempts } = createMockAgentRunBatchRunner({ onAbandoned });
      const running = runBatch(
        Array.from({ length: 3 }, (_, index) => queuedAgentRunTask(index + 1)),
        { signal: controller.signal },
      );
      void running.catch(() => {});

      await vi.advanceTimersByTimeAsync(0);
      attempts.forEach((attempt) => {
        attempt.markReady();
      });
      attempts[0]!.outcome.resolve({ type: 'rate_limited', agentId: 'agent-1' });
      attempts[1]!.outcome.resolve({
        task: attempts[1]!.task,
        agentId: 'agent-2',
        status: 'completed',
        result: 'completed 2',
      });
      await vi.advanceTimersByTimeAsync(0);

      controller.abort();
      await expect(running).rejects.toThrow();
      expect(onAbandoned).toHaveBeenCalledTimes(1);
      expect(onAbandoned).toHaveBeenCalledWith(expect.objectContaining({ agentId: 'agent-1' }));
    } finally {
      vi.useRealTimers();
    }
  });

  it('abandons with a failed outcome when the final rate-limited task is terminalized instead of requeued', async () => {
    vi.useFakeTimers();
    try {
      const onAbandoned = vi.fn();
      const { runBatch, attempts } = createMockAgentRunBatchRunner({ onAbandoned });
      const running = runBatch(
        Array.from({ length: 2 }, (_, index) => queuedAgentRunTask(index + 1)),
        { signal: new AbortController().signal },
      );

      await vi.advanceTimersByTimeAsync(0);
      attempts.forEach((attempt) => {
        attempt.markReady();
      });
      attempts[0]!.outcome.resolve({
        task: attempts[0]!.task,
        agentId: 'agent-1',
        status: 'completed',
        result: 'done 1',
      });
      attempts[1]!.outcome.resolve({
        type: 'rate_limited',
        agentId: 'agent-2',
        error: 'Rate limited',
      });

      await expect(running).resolves.toMatchObject([
        { status: 'completed' },
        { status: 'failed' },
      ]);
      expect(onAbandoned).toHaveBeenCalledTimes(1);
      expect(onAbandoned).toHaveBeenCalledWith(
        expect.objectContaining({
          agentId: 'agent-2',
          outcome: 'failed',
          error: 'Rate limited',
        }),
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it('abandons a rate-limited task that is relaunched but not yet ready when the batch is cancelled', async () => {
    vi.useFakeTimers();
    try {
      const controller = new AbortController();
      const onAbandoned = vi.fn();
      const { runBatch, attempts } = createMockAgentRunBatchRunner({ onAbandoned });
      const running = runBatch(
        Array.from({ length: 2 }, (_, index) => queuedAgentRunTask(index + 1)),
        { signal: controller.signal },
      );

      await vi.advanceTimersByTimeAsync(0);
      attempts.forEach((attempt) => {
        attempt.markReady();
      });
      attempts[0]!.outcome.resolve({ type: 'rate_limited', agentId: 'agent-1' });
      attempts[1]!.outcome.resolve({
        task: attempts[1]!.task,
        agentId: 'agent-2',
        status: 'completed',
        result: 'completed 2',
      });
      await vi.advanceTimersByTimeAsync(3_000);
      expect(attempts).toHaveLength(3);
      expect(attempts[2]!.retryAgentId).toBe('agent-1');
      expect(attempts[2]!.ready).toBeFalsy();

      controller.abort(userCancellationReason());
      await running;

      expect(onAbandoned).toHaveBeenCalledWith(
        expect.objectContaining({ agentId: 'agent-1', outcome: 'cancelled' }),
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not abandon agents when a rate-limited task retries successfully', async () => {
    vi.useFakeTimers();
    try {
      const onAbandoned = vi.fn();
      const { runBatch, attempts } = createMockAgentRunBatchRunner({ onAbandoned });
      const running = runBatch(
        Array.from({ length: 2 }, (_, index) => queuedAgentRunTask(index + 1)),
        { signal: new AbortController().signal },
      );

      await vi.advanceTimersByTimeAsync(0);
      attempts.forEach((attempt) => {
        attempt.markReady();
      });
      attempts[0]!.outcome.resolve({ type: 'rate_limited', agentId: 'agent-1' });
      attempts[1]!.outcome.resolve({
        task: attempts[1]!.task,
        agentId: 'agent-2',
        status: 'completed',
        result: 'completed 2',
      });
      await vi.advanceTimersByTimeAsync(3_000);
      expect(attempts).toHaveLength(3);
      expect(attempts[2]!.retryAgentId).toBe('agent-1');

      attempts[2]!.outcome.resolve({
        task: attempts[2]!.task,
        agentId: 'agent-1',
        status: 'completed',
        result: 'recovered 1',
      });
      await expect(running).resolves.toMatchObject([
        { task: { data: 1 }, agentId: 'agent-1', status: 'completed' },
        { task: { data: 2 }, agentId: 'agent-2', status: 'completed' },
      ]);
      expect(onAbandoned).not.toHaveBeenCalled();
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
      plan: { profileName: 'subagent', model: 'mock-model', thinking: 'off', fork: false },
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
  let spawnAgent: ReturnType<typeof vi.fn>;
  let runAgent: ReturnType<typeof vi.fn>;
  let eventBus: IEventBus;

  beforeEach(() => {
    disposables = new DisposableStore();
    ix = disposables.add(new TestInstantiationService());
    agents = {};
    handles = new Map();
    eventBus = eventBusStub();
    lifecycle = lifecycleStub(handles, eventBus);
    subagents = subagentStub(handles, lifecycle, eventBus);
    spawnAgent = subagents.spawn as ReturnType<typeof vi.fn>;
    runAgent = subagents.run as ReturnType<typeof vi.fn>;
    handles.set('main', agentHandle('main', lifecycle, eventBus));

    ix.stub(IAgentLifecycleService, lifecycle);
    ix.stub(ISessionSubagentService, subagents);
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

  it('forwards caller ownership and swarm item labels to the subagent spawn', async () => {
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

    expect(spawnAgent).toHaveBeenCalledWith({
      callerAgentId: 'main',
      plan: { profileName: 'coder', model: 'kimi-test', thinking: 'medium', fork: false },
      labels: { parentAgentId: 'main', swarmItem: 'src/a.ts' },
      prompt: 'Review the file',
    });
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

  it('keeps resumed children on their own recorded model', async () => {
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

    expect(child.accessor.get(IAgentProfileService).data().modelAlias).toBe('stale-model');
    expect(eventBus.publish).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'subagent.spawned',
        subagentId: 'agent-existing',
        model: 'stale-model',
        thinkingEffort: 'medium',
      }),
    );
    expect(runAgent).toHaveBeenCalledWith(
      expect.objectContaining({ agentId: 'agent-existing' }),
      { kind: 'prompt', prompt: 'Continue' },
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
  });

  it('prefers the spawn task plan over the caller model', async () => {
    const service = ix.get(ISessionSwarmService);
    const spawnTask: SessionSwarmSpawnTask = {
      ...spawnSessionTask('src/a.ts'),
      kind: 'spawn',
      plan: { profileName: 'coder', model: 'provider/pool', thinking: 'low', fork: false },
    };

    await expect(
      service.run({
        callerAgentId: 'main',
        tasks: [spawnTask],
      }),
    ).resolves.toMatchObject([{ status: 'completed', agentId: 'agent-new' }]);

    expect(spawnAgent).toHaveBeenCalledWith(
      expect.objectContaining({
        plan: { profileName: 'coder', model: 'provider/pool', thinking: 'low', fork: false },
      }),
    );
    expect(eventBus.publish).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'subagent.spawned',
        subagentId: 'agent-new',
        model: 'provider/pool',
      }),
    );
  });

  it('returns a failed per-task result when the subagent spawn rejects', async () => {
    spawnAgent.mockRejectedValueOnce(new Error('spawn boom'));
    const service = ix.get(ISessionSwarmService);

    await expect(
      service.run({
        callerAgentId: 'main',
        tasks: [spawnSessionTask('src/a.ts')],
      }),
    ).resolves.toMatchObject([
      {
        status: 'failed',
        state: 'not_started',
        error: 'spawn boom',
      },
    ]);
    expect(runAgent).not.toHaveBeenCalled();
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
      const published: Event2[] = [];
      (eventBus.publish as ReturnType<typeof vi.fn>).mockImplementation((event: Event2) => {
        published.push(event);
      });
      let retryRuns = 0;
      runAgent.mockImplementation((agent, request, options) => {
        options?.onReady?.();
        const agentId = (agent as AgentContext).agentId;
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
          .map((event) => (event as Event2 & { readonly subagentId: string }).subagentId),
      ).toEqual(['agent-retry', 'agent-blocker']);
      expect(
        runAgent.mock.calls
          .filter(([agent]) => (agent as AgentContext).agentId === 'agent-retry')
          .map(([, request]) => request),
      ).toEqual([{ kind: 'prompt', prompt: 'Continue' }, { kind: 'retry' }]);
    } finally {
      vi.useRealTimers();
    }
  });

  it('emits subagent.cancelled (not subagent.failed) when a running child aborts', async () => {
    agents['agent-abort'] = {
      labels: { parentAgentId: 'main' },
    };
    handles.set('agent-abort', agentHandle('agent-abort', lifecycle, eventBus));
    const published: Event2[] = [];
    (eventBus.publish as ReturnType<typeof vi.fn>).mockImplementation((event: Event2) => {
      published.push(event);
    });
    runAgent.mockImplementation((agent) => {
      const agentId = (agent as AgentContext).agentId;
      return {
        agentId,
        turn: {} as never,
        completion: Promise.reject(userCancellationReason()),
      };
    });
    const service = ix.get(ISessionSwarmService);

    await expect(
      service.run({
        callerAgentId: 'main',
        tasks: [resumeSessionTask('agent-abort')],
      }),
    ).resolves.toMatchObject([{ status: 'failed', agentId: 'agent-abort' }]);

    expect(
      published
        .filter((event) => event.type === 'subagent.cancelled')
        .map((event) => (event as Event2 & { readonly subagentId: string }).subagentId),
    ).toEqual(['agent-abort']);
    expect(published.some((event) => event.type === 'subagent.failed')).toBe(false);
  });

  it('emits neither subagent.cancelled nor subagent.failed on the rate-limit requeue path', async () => {
    vi.useFakeTimers();
    try {
      agents['agent-rl'] = {
        labels: { parentAgentId: 'main' },
      };
      agents['agent-peer'] = {
        labels: { parentAgentId: 'main' },
      };
      handles.set('agent-rl', agentHandle('agent-rl', lifecycle, eventBus));
      handles.set('agent-peer', agentHandle('agent-peer', lifecycle, eventBus));
      const rateLimited = createControlledPromise<{ summary: string }>();
      const peer = createControlledPromise<{ summary: string }>();
      const published: Event2[] = [];
      (eventBus.publish as ReturnType<typeof vi.fn>).mockImplementation((event: Event2) => {
        published.push(event);
      });
      let rlRuns = 0;
      runAgent.mockImplementation((agent, request, options) => {
        options?.onReady?.();
        const agentId = (agent as AgentContext).agentId;
        if (agentId === 'agent-rl') {
          rlRuns += 1;
          return {
            agentId,
            turn: {} as never,
            completion:
              rlRuns === 1 ? rateLimited : Promise.resolve({ summary: 'recovered summary' }),
          };
        }
        return { agentId, turn: {} as never, completion: peer };
      });
      const service = ix.get(ISessionSwarmService);

      const running = service.run({
        callerAgentId: 'main',
        tasks: [resumeSessionTask('agent-rl'), resumeSessionTask('agent-peer')],
      });
      await vi.advanceTimersByTimeAsync(0);
      rateLimited.reject(new APIProviderRateLimitError('Rate limited'));
      await vi.advanceTimersByTimeAsync(0);
      peer.resolve({ summary: 'peer summary' });
      await vi.advanceTimersByTimeAsync(3_000);
      await expect(running).resolves.toMatchObject([
        { status: 'completed', agentId: 'agent-rl' },
        { status: 'completed', agentId: 'agent-peer' },
      ]);

      expect(published.filter((event) => event.type === 'subagent.suspended')).toHaveLength(1);
      expect(published.some((event) => event.type === 'subagent.cancelled')).toBe(false);
      expect(published.some((event) => event.type === 'subagent.failed')).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it('emits subagent.cancelled for a rate-limit-suspended child when the batch is cancelled', async () => {
    vi.useFakeTimers();
    try {
      agents['agent-rl'] = {
        labels: { parentAgentId: 'main' },
      };
      agents['agent-peer'] = {
        labels: { parentAgentId: 'main' },
      };
      handles.set('agent-rl', agentHandle('agent-rl', lifecycle, eventBus));
      handles.set('agent-peer', agentHandle('agent-peer', lifecycle, eventBus));
      const rateLimited = createControlledPromise<{ summary: string }>();
      const peer = createControlledPromise<{ summary: string }>();
      const published: Event2[] = [];
      (eventBus.publish as ReturnType<typeof vi.fn>).mockImplementation((event: Event2) => {
        published.push(event);
      });
      runAgent.mockImplementation((agent, request, options) => {
        options?.onReady?.();
        const agentId = (agent as AgentContext).agentId;
        if (agentId === 'agent-rl') {
          return { agentId, turn: {} as never, completion: rateLimited };
        }
        return { agentId, turn: {} as never, completion: peer };
      });
      const service = ix.get(ISessionSwarmService);
      const controller = new AbortController();

      const running = service.run({
        callerAgentId: 'main',
        tasks: [
          { ...resumeSessionTask('agent-rl'), signal: controller.signal },
          resumeSessionTask('agent-peer'),
        ],
      });
      await vi.advanceTimersByTimeAsync(0);
      rateLimited.reject(new APIProviderRateLimitError('Rate limited'));
      await vi.advanceTimersByTimeAsync(0);
      peer.resolve({ summary: 'peer summary' });
      await vi.advanceTimersByTimeAsync(0);

      controller.abort(userCancellationReason());
      await expect(running).resolves.toMatchObject([
        { status: 'aborted', agentId: 'agent-rl' },
        { status: 'completed', agentId: 'agent-peer' },
      ]);

      const subagentIdsOf = (type: string) =>
        published
          .filter((event) => event.type === type)
          .map((event) => (event as Event2 & { readonly subagentId: string }).subagentId);
      expect(subagentIdsOf('subagent.suspended')).toEqual(['agent-rl']);
      expect(subagentIdsOf('subagent.cancelled')).toEqual(['agent-rl']);
      expect(subagentIdsOf('subagent.completed')).toEqual(['agent-peer']);
    } finally {
      vi.useRealTimers();
    }
  });

  it('emits subagent.cancelled exactly once when a starting retry is cancelled', async () => {
    vi.useFakeTimers();
    try {
      agents['agent-rl'] = {
        labels: { parentAgentId: 'main' },
      };
      agents['agent-peer'] = {
        labels: { parentAgentId: 'main' },
      };
      handles.set('agent-rl', agentHandle('agent-rl', lifecycle, eventBus));
      handles.set('agent-peer', agentHandle('agent-peer', lifecycle, eventBus));
      const rateLimited = createControlledPromise<{ summary: string }>();
      const peer = createControlledPromise<{ summary: string }>();
      const published: Event2[] = [];
      (eventBus.publish as ReturnType<typeof vi.fn>).mockImplementation((event: Event2) => {
        published.push(event);
      });
      let rlRuns = 0;
      runAgent.mockImplementation((agent, _request, options) => {
        const agentId = (agent as AgentContext).agentId;
        if (agentId === 'agent-rl') {
          rlRuns += 1;
          if (rlRuns === 1) {
            options?.onReady?.();
            return { agentId, turn: {} as never, completion: rateLimited };
          }
          return new Promise((_, reject) => {
            options?.signal.addEventListener(
              'abort',
              () => {
                reject(options.signal.reason);
              },
              { once: true },
            );
          }) as unknown as AgentRunHandle;
        }
        options?.onReady?.();
        return { agentId, turn: {} as never, completion: peer };
      });
      const service = ix.get(ISessionSwarmService);
      const controller = new AbortController();

      const running = service.run({
        callerAgentId: 'main',
        tasks: [
          { ...resumeSessionTask('agent-rl'), signal: controller.signal },
          resumeSessionTask('agent-peer'),
        ],
      });
      await vi.advanceTimersByTimeAsync(0);
      rateLimited.reject(new APIProviderRateLimitError('Rate limited'));
      await vi.advanceTimersByTimeAsync(0);
      peer.resolve({ summary: 'peer summary' });
      await vi.advanceTimersByTimeAsync(3_000);
      expect(rlRuns).toBe(2);

      controller.abort(userCancellationReason());
      await expect(running).resolves.toMatchObject([
        { status: 'aborted', agentId: 'agent-rl' },
        { status: 'completed', agentId: 'agent-peer' },
      ]);
      await vi.advanceTimersByTimeAsync(0);

      const subagentIdsOf = (type: string) =>
        published
          .filter((event) => event.type === type)
          .map((event) => (event as Event2 & { readonly subagentId: string }).subagentId);
      expect(subagentIdsOf('subagent.suspended')).toEqual(['agent-rl']);
      expect(subagentIdsOf('subagent.cancelled')).toEqual(['agent-rl']);
      expect(subagentIdsOf('subagent.failed')).toEqual([]);
    } finally {
      vi.useRealTimers();
    }
  });

  it('emits subagent.cancelled exactly once when a child with an installed mirror is cancelled before ready', async () => {
    vi.useFakeTimers();
    try {
      const published: Event2[] = [];
      (eventBus.publish as ReturnType<typeof vi.fn>).mockImplementation((event: Event2) => {
        published.push(event);
      });
      runAgent.mockImplementation((agent, _request, options) => {
        const agentId = (agent as AgentContext).agentId;
        return {
          agentId,
          turn: {} as never,
          completion: new Promise((_, reject) => {
            options?.signal.addEventListener(
              'abort',
              () => {
                reject(options.signal.reason);
              },
              { once: true },
            );
          }),
        };
      });
      const service = ix.get(ISessionSwarmService);
      const controller = new AbortController();

      const running = service.run({
        callerAgentId: 'main',
        tasks: [{ ...spawnSessionTask('src/a.ts'), signal: controller.signal }],
      });
      await vi.advanceTimersByTimeAsync(0);

      controller.abort(userCancellationReason());
      await expect(running).resolves.toMatchObject([{ status: 'aborted' }]);
      await vi.advanceTimersByTimeAsync(0);

      const subagentIdsOf = (type: string) =>
        published
          .filter((event) => event.type === type)
          .map((event) => (event as Event2 & { readonly subagentId: string }).subagentId);
      expect(subagentIdsOf('subagent.spawned')).toEqual(['agent-new']);
      expect(subagentIdsOf('subagent.cancelled')).toEqual(['agent-new']);
      expect(subagentIdsOf('subagent.failed')).toEqual([]);
    } finally {
      vi.useRealTimers();
    }
  });

  it('emits subagent.cancelled when cancellation arrives during the start hook', async () => {
    vi.useFakeTimers();
    try {
      agents['agent-hook'] = {
        labels: { parentAgentId: 'main' },
      };
      handles.set('agent-hook', agentHandle('agent-hook', lifecycle, eventBus));
      handles.set(
        'main',
        agentHandle('main', lifecycle, eventBus, {}, new Map([[ISessionSubagentService, subagents]])),
      );
      subagents.hooks.onWillStartAgentTask.register(
        'test-hook',
        async (hookContext) => {
          await new Promise((_, reject) => {
            hookContext.signal.addEventListener(
              'abort',
              () => {
                reject(hookContext.signal.reason);
              },
              { once: true },
            );
          });
        },
      );
      runAgent.mockImplementation((agent, _request, options) => {
        options?.onReady?.();
        const agentId = (agent as AgentContext).agentId;
        return {
          agentId,
          turn: {} as never,
          completion: new Promise((_, reject) => {
            options?.signal.addEventListener(
              'abort',
              () => {
                reject(options.signal.reason);
              },
              { once: true },
            );
          }),
        };
      });
      const published: Event2[] = [];
      (eventBus.publish as ReturnType<typeof vi.fn>).mockImplementation((event: Event2) => {
        published.push(event);
      });
      const service = ix.get(ISessionSwarmService);
      const controller = new AbortController();

      const running = service.run({
        callerAgentId: 'main',
        tasks: [{ ...resumeSessionTask('agent-hook'), signal: controller.signal }],
      });
      await vi.advanceTimersByTimeAsync(0);

      controller.abort(userCancellationReason());
      await expect(running).resolves.toMatchObject([
        { status: 'aborted', agentId: 'agent-hook' },
      ]);
      await vi.advanceTimersByTimeAsync(0);

      const subagentIdsOf = (type: string) =>
        published
          .filter((event) => event.type === type)
          .map((event) => (event as Event2 & { readonly subagentId: string }).subagentId);
      expect(subagentIdsOf('subagent.spawned')).toEqual(['agent-hook']);
      expect(subagentIdsOf('subagent.cancelled')).toEqual(['agent-hook']);
      expect(subagentIdsOf('subagent.failed')).toEqual([]);
    } finally {
      vi.useRealTimers();
    }
  });

  it('emits subagent.cancelled exactly once when a not-ready attempt is cancelled during the start hook', async () => {
    vi.useFakeTimers();
    try {
      agents['agent-hook'] = {
        labels: { parentAgentId: 'main' },
      };
      handles.set('agent-hook', agentHandle('agent-hook', lifecycle, eventBus));
      handles.set(
        'main',
        agentHandle('main', lifecycle, eventBus, {}, new Map([[ISessionSubagentService, subagents]])),
      );
      subagents.hooks.onWillStartAgentTask.register(
        'test-hook',
        async (hookContext) => {
          await new Promise((_, reject) => {
            hookContext.signal.addEventListener(
              'abort',
              () => {
                reject(hookContext.signal.reason);
              },
              { once: true },
            );
          });
        },
      );
      runAgent.mockImplementation((agent, _request, options) => {
        const agentId = (agent as AgentContext).agentId;
        return {
          agentId,
          turn: {} as never,
          completion: new Promise((_, reject) => {
            options?.signal.addEventListener(
              'abort',
              () => {
                reject(options.signal.reason);
              },
              { once: true },
            );
          }),
        };
      });
      const published: Event2[] = [];
      (eventBus.publish as ReturnType<typeof vi.fn>).mockImplementation((event: Event2) => {
        published.push(event);
      });
      const service = ix.get(ISessionSwarmService);
      const controller = new AbortController();

      const running = service.run({
        callerAgentId: 'main',
        tasks: [{ ...resumeSessionTask('agent-hook'), signal: controller.signal }],
      });
      await vi.advanceTimersByTimeAsync(0);

      controller.abort(userCancellationReason());
      await expect(running).resolves.toMatchObject([
        { status: 'aborted', agentId: 'agent-hook' },
      ]);
      await vi.advanceTimersByTimeAsync(0);

      const subagentIdsOf = (type: string) =>
        published
          .filter((event) => event.type === type)
          .map((event) => (event as Event2 & { readonly subagentId: string }).subagentId);
      expect(subagentIdsOf('subagent.cancelled')).toEqual(['agent-hook']);
      expect(subagentIdsOf('subagent.failed')).toEqual([]);
    } finally {
      vi.useRealTimers();
    }
  });

  it('emits subagent.cancelled for a child whose spawn finishes after the batch is cancelled', async () => {
    vi.useFakeTimers();
    try {
      const spawnDeferred = createControlledPromise<{
        readonly agentId: string;
        readonly profileName: string;
        readonly model: string;
        readonly promptText: string;
      }>();
      handles.set(
        'agent-new',
        agentHandle('agent-new', lifecycle, eventBus, {
          profileName: 'coder',
          modelAlias: 'kimi-test',
        }),
      );
      spawnAgent.mockReturnValueOnce(spawnDeferred);
      runAgent.mockImplementationOnce((agent: AgentContext, _request: unknown, options) => {
        options?.signal.throwIfAborted();
        return {
          agentId: agent.agentId,
          turn: {} as never,
          completion: Promise.resolve({ summary: 'late summary' }),
        };
      });
      const published: Event2[] = [];
      (eventBus.publish as ReturnType<typeof vi.fn>).mockImplementation((event: Event2) => {
        published.push(event);
      });
      const service = ix.get(ISessionSwarmService);
      const controller = new AbortController();

      const running = service.run({
        callerAgentId: 'main',
        tasks: [{ ...spawnSessionTask('src/a.ts'), signal: controller.signal }],
      });
      await vi.advanceTimersByTimeAsync(0);
      expect(spawnAgent).toHaveBeenCalledTimes(1);

      controller.abort(userCancellationReason());
      await expect(running).resolves.toMatchObject([{ status: 'aborted', state: 'not_started' }]);
      expect(published.some((event) => event.type === 'subagent.spawned')).toBe(false);

      spawnDeferred.resolve({
        agentId: 'agent-new',
        profileName: 'coder',
        model: 'kimi-test',
        promptText: 'Review the file',
      });
      await vi.advanceTimersByTimeAsync(0);

      const subagentIdsOf = (type: string) =>
        published
          .filter((event) => event.type === type)
          .map((event) => (event as Event2 & { readonly subagentId: string }).subagentId);
      expect(subagentIdsOf('subagent.spawned')).toEqual(['agent-new']);
      expect(subagentIdsOf('subagent.cancelled')).toEqual(['agent-new']);
      expect(subagentIdsOf('subagent.failed')).toEqual([]);
    } finally {
      vi.useRealTimers();
    }
  });

  it('emits subagent.failed when the child run cannot start', async () => {
    runAgent.mockRejectedValueOnce(new Error('enqueue boom'));
    const published: Event2[] = [];
    (eventBus.publish as ReturnType<typeof vi.fn>).mockImplementation((event: Event2) => {
      published.push(event);
    });
    const service = ix.get(ISessionSwarmService);

    await expect(
      service.run({
        callerAgentId: 'main',
        tasks: [spawnSessionTask('src/a.ts')],
      }),
    ).resolves.toMatchObject([
      { status: 'failed', state: 'not_started', error: 'enqueue boom' },
    ]);

    const failedEvents = published.filter((event) => event.type === 'subagent.failed');
    expect(failedEvents).toHaveLength(1);
    expect(failedEvents[0]).toMatchObject({ subagentId: 'agent-new', error: 'enqueue boom' });
    expect(published.some((event) => event.type === 'subagent.cancelled')).toBe(false);
  });

  it('emits subagent.failed (not subagent.cancelled) when a child times out', async () => {
    vi.useFakeTimers();
    try {
      agents['agent-slow'] = {
        labels: { parentAgentId: 'main' },
      };
      handles.set('agent-slow', agentHandle('agent-slow', lifecycle, eventBus));
      runAgent.mockImplementation((agent, _request, options) => {
        const agentId = (agent as AgentContext).agentId;
        return {
          agentId,
          turn: {} as never,
          completion: new Promise((_, reject) => {
            options?.signal.addEventListener(
              'abort',
              () => {
                reject(options.signal.reason);
              },
              { once: true },
            );
          }),
        };
      });
      const published: Event2[] = [];
      (eventBus.publish as ReturnType<typeof vi.fn>).mockImplementation((event: Event2) => {
        published.push(event);
      });
      const service = ix.get(ISessionSwarmService);

      const running = service.run({
        callerAgentId: 'main',
        tasks: [{ ...resumeSessionTask('agent-slow'), timeout: 1000 }],
      });
      await vi.advanceTimersByTimeAsync(0);
      await vi.advanceTimersByTimeAsync(1000);

      await expect(running).resolves.toMatchObject([
        { status: 'failed', agentId: 'agent-slow', error: 'Subagent timed out.' },
      ]);
      const failedEvents = published.filter((event) => event.type === 'subagent.failed');
      expect(failedEvents).toHaveLength(1);
      expect(failedEvents[0]).toMatchObject({
        subagentId: 'agent-slow',
        error: 'Subagent timed out.',
      });
      expect(published.some((event) => event.type === 'subagent.cancelled')).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it('emits subagent.cancelled (not subagent.failed) when the child is aborted with a plain non-error reason', async () => {
    agents['agent-managed'] = {
      labels: { parentAgentId: 'main' },
    };
    handles.set('agent-managed', agentHandle('agent-managed', lifecycle, eventBus));
    const published: Event2[] = [];
    (eventBus.publish as ReturnType<typeof vi.fn>).mockImplementation((event: Event2) => {
      published.push(event);
    });
    runAgent.mockImplementation((agent, _request, options) => {
      options?.onReady?.();
      return {
        agentId: (agent as AgentContext).agentId,
        turn: {} as never,
        completion: new Promise((_, reject) => {
          options?.signal.addEventListener(
            'abort',
            () => {
              reject(options.signal.reason);
            },
            { once: true },
          );
        }),
      };
    });
    const taskSignal = new AbortController();
    const service = ix.get(ISessionSwarmService);
    const running = service.run({
      callerAgentId: 'main',
      tasks: [{ ...resumeSessionTask('agent-managed'), signal: taskSignal.signal }],
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    taskSignal.abort('Timed out');
    await expect(running).rejects.toBe('Timed out');

    expect(
      published
        .filter((event) => event.type === 'subagent.cancelled')
        .map((event) => (event as Event2 & { readonly subagentId: string }).subagentId),
    ).toEqual(['agent-managed']);
    expect(published.some((event) => event.type === 'subagent.failed')).toBe(false);
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
            snapshot: () => ({ state: 'running' }),
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

  it('rebuilds a missing child scope from session metadata before resuming', async () => {
    agents['agent-old'] = {
      labels: { parentAgentId: 'main', swarmItem: 'src/a.ts' },
    };
    const service = ix.get(ISessionSwarmService);

    await expect(
      service.run({
        callerAgentId: 'main',
        tasks: [resumeSessionTask('agent-old')],
      }),
    ).resolves.toMatchObject([{ status: 'completed', agentId: 'agent-old' }]);

    expect(lifecycle.create).toHaveBeenCalledWith(
      expect.objectContaining({
        agentId: 'agent-old',
        labels: { parentAgentId: 'main', swarmItem: 'src/a.ts' },
      }),
    );
    expect(runAgent).toHaveBeenCalledWith(
      expect.objectContaining({ agentId: 'agent-old' }),
      { kind: 'prompt', prompt: 'Continue' },
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
  });

  it('rebuilds a child scope whose previous remove is still in flight', async () => {
    agents['agent-old'] = {
      labels: { parentAgentId: 'main', swarmItem: 'src/a.ts' },
    };
    vi.mocked(lifecycle.create).mockRejectedValueOnce(
      new Error2(ErrorCodes.AGENT_ALREADY_EXISTS, 'Agent "agent-old" already exists', {
        details: { agentId: 'agent-old' },
      }),
    );
    const service = ix.get(ISessionSwarmService);

    await expect(
      service.run({
        callerAgentId: 'main',
        tasks: [resumeSessionTask('agent-old')],
      }),
    ).resolves.toMatchObject([{ status: 'completed', agentId: 'agent-old' }]);

    expect(lifecycle.create).toHaveBeenCalledTimes(2);
    expect(runAgent).toHaveBeenCalledWith(
      expect.objectContaining({ agentId: 'agent-old' }),
      { kind: 'prompt', prompt: 'Continue' },
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
  });

  it('does not produce an unhandled rejection when the batch fails with a non-user abort', async () => {
    agents['agent-a'] = { labels: { parentAgentId: 'main' } };
    handles.set('agent-a', agentHandle('agent-a', lifecycle, eventBus));
    const blocker = createControlledPromise<{ summary: string }>();
    runAgent.mockImplementation((agent, request, options) => {
      options?.onReady?.();
      return {
        agentId: (agent as AgentContext).agentId,
        turn: {} as never,
        completion: blocker,
      };
    });
    const rejections: unknown[] = [];
    const listener = (reason: unknown): void => {
      rejections.push(reason);
    };
    process.on('unhandledRejection', listener);
    try {
      const service = ix.get(ISessionSwarmService);
      const running = service.run({
        callerAgentId: 'main',
        tasks: [resumeSessionTask('agent-a')],
      });
      service.cancel({ callerAgentId: 'main' });
      await expect(running).rejects.toThrow();
      await new Promise((resolve) => setImmediate(resolve));
      expect(rejections).toEqual([]);
    } finally {
      process.off('unhandledRejection', listener);
    }
  });
});

function spawnSessionTask(swarmItem?: string): SessionSwarmSpawnTask {
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
    plan: { profileName: 'coder', model: 'kimi-test', thinking: 'medium', fork: false },
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
    onDidCreateScope: Event.None,
    onWillClose: Event.None,
    onDidClose: Event.None,
    create: vi.fn(async (opts: CreateAgentOptions = {}) => {
      if (opts.agentId !== undefined) {
        const existing = handles.get(opts.agentId);
        if (existing !== undefined) return stubAgentContext(opts.agentId, 1);
      }
      const id = opts.agentId ?? 'agent-new';
      const handle = agentHandle(id, lifecycle as IAgentLifecycleService, eventBus, {
        profileName: opts.binding?.profile ?? 'coder',
        modelAlias: opts.binding?.model ?? 'kimi-test',
        thinkingLevel: opts.binding?.thinking ?? 'medium',
      });
      handles.set(id, handle);
      return stubAgentContext(id, 1);
    }),
    fork: vi.fn(),
    get: (agentId: string) => (handles.has(agentId) ? stubAgentContext(agentId, 1) : undefined),
    handleOf: (agentId: string) => handles.get(agentId),
    list: () => [...handles.keys()].map((agentId) => stubAgentContext(agentId, 1)),
    remove: async (context: AgentContext) => {
      handles.delete(context.agentId);
    },
    broadcastPermissionMode: () => {},
    adopt: (handle: IAgentScopeHandle) => stubAgentContext(handle.id, 1),
  };
  return lifecycle as IAgentLifecycleService;
}

function subagentStub(
  handles: Map<string, IAgentScopeHandle>,
  lifecycle: IAgentLifecycleService,
  eventBus: IEventBus,
): ISessionSubagentService {
  return {
    _serviceBrand: undefined,
    hooks: createHooks<AgentTaskHooks, keyof AgentTaskHooks>(['onWillStartAgentTask']),
    onDidStopAgentTask: Event.None,
    run: vi.fn(async (agent: AgentContext) => ({
      agentId: agent.agentId,
      turn: {} as never,
      completion: Promise.resolve({ summary: 'child summary' }),
    })),
    planSpawn: vi.fn(async (input: SubagentSpawnPlanInput) => ({
      profileName: input.profileName ?? 'coder',
      model: input.model ?? 'kimi-test',
      fork: input.fork === true,
    })),
    spawn: vi.fn(async (opts: SpawnSubagentOptions) => {
      const handle = agentHandle('agent-new', lifecycle, eventBus, {
        profileName: opts.plan.profileName,
        modelAlias: opts.plan.model,
      });
      handles.set('agent-new', handle);
      return {
        agentId: 'agent-new',
        profileName: opts.plan.profileName,
        model: opts.plan.model,
        promptText: opts.prompt,
      };
    }),
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
    setModeAndBroadcast: () => {},
    onDidChangeMode: Event.None,
  } as IAgentPermissionModeService;
  const dispatcher = {
    _serviceBrand: undefined,
    dispatch: async (event: Event2) => {
      eventBus.publish(event);
    },
  } as unknown as IEventDispatcher;
  return {
    id,
    kind: LifecycleScope.Agent,
    accessor: {
      get: ((serviceId: unknown) => {
        const service = services.get(serviceId);
        if (service !== undefined) return service;
        if (serviceId === IAgentProfileService) return profile;
        if (serviceId === IAgentRuntimeBindingService) {
          return {
            _serviceBrand: undefined,
            current: { workspaceId: 'w1', runtimeId: 'local' },
            switch: () => {},
            onDidChange: Event.None,
          } as unknown as IAgentRuntimeBindingService;
        }
        if (serviceId === IAgentPermissionModeService) return permissionMode;
        if (serviceId === IAgentLoopService) {
          return {
            _serviceBrand: undefined,
            snapshot: () => ({ state: 'idle' }),
          } as unknown as IAgentLoopService;
        }
        if (serviceId === IAgentUserToolService) return userToolServiceStub();
        if (serviceId === IAgentScopeContext) {
          return {
            _serviceBrand: undefined,
            agentId: id,
            agentContext: stubAgentContext(id, 1),
            scope: (subKey?: string) => subKey ?? '',
          };
        }
        if (serviceId === IEventBus) return eventBus;
        if (serviceId === IEventDispatcher) return dispatcher;
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
    republishStatus: () => {},
    getEffectiveThinkingLevel: () => current.thinkingLevel,
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
    publish: vi.fn((_: Event2) => {}),
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
  ready: boolean;
  readonly markReady: () => void;
  readonly outcome: ReturnType<typeof createControlledPromise<MockAgentRunAttemptOutcome<number>>>;
};

type MockAgentRunBatchRunnerOptions = {
  readonly onSuspended?: (event: AgentRunSuspendedEvent) => void;
  readonly onAbandoned?: (event: AgentRunAbandonedEvent) => void;
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
    const attemptIndex = attempts.length;
    const record: MockAgentRunAttemptRecord = {
      task: task as unknown as QueuedAgentRunTask<number>,
      retryAgentId,
      ready: false,
      markReady: () => {
        record.ready = true;
        runOptions.onReady?.();
      },
      outcome: outcome as unknown as MockAgentRunAttemptRecord['outcome'],
    };
    attempts.push(record);

    const delay = options.readyDelay?.(attemptIndex);
    if (delay !== undefined) setTimeout(record.markReady, delay);

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
    abandoned: (event) => {
      options.onAbandoned?.(event);
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
    plan: { profileName: 'coder', model: 'mock-model', thinking: 'off', fork: false },
  };
}

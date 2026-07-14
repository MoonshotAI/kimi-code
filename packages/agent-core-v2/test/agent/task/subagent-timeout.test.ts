/**
 * AgentTaskService task timeout for SubagentTask registrations.
 *
 * Semantics:
 *   - manager-owned deadline fires → status=`timed_out`
 *   - no `timeoutMs` → the task runs to completion without a manager deadline
 *   - internal `TimeoutError` rejection (e.g. aiohttp sock_read) is a
 *     generic `failed` with no stop reason — the timeout reason must
 *     only be set for the caller-driven deadline
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { IAgentTaskService } from '#/agent/task/task';
import { SubagentTask } from '#/session/agentLifecycle/tools/subagent-task';
import { createTestAgent, type TestAgentContext } from '../../harness';

function agentTask(
  completion: Promise<{ result: string }>,
  description: string,
): SubagentTask {
  return new SubagentTask(
    { agentId: 'agent-child', profileName: 'coder', completion },
    description,
    new AbortController(),
  );
}

describe('SubagentTask — timeoutMs', () => {
  let ctx: TestAgentContext;
  let background: IAgentTaskService;

  beforeEach(() => {
    ctx = createTestAgent();
    background = ctx.get(IAgentTaskService);
  });

  afterEach(async () => {
    vi.useRealTimers();
    try {
      await ctx.expectResumeMatches();
    } finally {
      await ctx.dispose();
    }
  });

  it('external deadline marks task timed_out', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const hangForever = new Promise<{ result: string }>(() => {});
    const taskId = background.registerTask(agentTask(hangForever, 'hang'), {
      timeoutMs: 2_000,
    });

    const terminalPromise = background.wait(taskId);
    await vi.advanceTimersByTimeAsync(7_100);
    const info = await terminalPromise;

    expect(info?.status).toBe('timed_out');
    expect(info?.stopReason).toBeUndefined();
  });

  it('omitting timeoutMs lets the task run to completion without a manager deadline', async () => {
    let resolveFn!: (r: { result: string }) => void;
    const completion = new Promise<{ result: string }>((res) => {
      resolveFn = res;
    });
    const taskId = background.registerTask(agentTask(completion, 'no deadline'));

    resolveFn({ result: 'finished' });
    const info = await background.wait(taskId);
    expect(info?.status).toBe('completed');
    expect(info?.stopReason).toBeUndefined();
  });

  it('internal TimeoutError rejection = generic failure with error reason', async () => {
    const internalErr = new Error('aiohttp sock_read timeout');
    internalErr.name = 'TimeoutError';
    const rejecting = Promise.reject(internalErr);
    const taskId = background.registerTask(agentTask(rejecting, 'internal timeout'), {
      timeoutMs: 900_000,
    });

    const info = await background.wait(taskId);
    expect(info?.status).toBe('failed');
    expect(info?.stopReason).toBe('aiohttp sock_read timeout');
  });

  it('explicit timeoutMs is persisted on the task info', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    let resolveFn!: (r: { result: string }) => void;
    const completion = new Promise<{ result: string }>((res) => {
      resolveFn = res;
    });
    const taskId = background.registerTask(
      agentTask(completion, 'persist timeout'),
      { timeoutMs: 1_800_000 },
    );
    const info = background.getTask(taskId);
    expect((info as unknown as { timeoutMs?: number }).timeoutMs).toBe(1_800_000);
    resolveFn({ result: 'finished' });
    await expect(background.wait(taskId)).resolves.toMatchObject({ status: 'completed' });
  });

  it('omitted timeoutMs leaves the task info field undefined', async () => {
    let resolveFn!: (r: { result: string }) => void;
    const completion = new Promise<{ result: string }>((res) => {
      resolveFn = res;
    });
    const taskId = background.registerTask(agentTask(completion, 'default timeout'));
    const info = background.getTask(taskId);
    expect((info as unknown as { timeoutMs?: number }).timeoutMs).toBeUndefined();
    resolveFn({ result: 'finished' });
    await expect(background.wait(taskId)).resolves.toMatchObject({ status: 'completed' });
  });

  it('timeoutMs=0 is preserved on the task info and does not arm a deadline', async () => {
    let resolveFn!: (r: { result: string }) => void;
    const completion = new Promise<{ result: string }>((res) => {
      resolveFn = res;
    });
    const taskId = background.registerTask(agentTask(completion, 'zero timeout'), {
      timeoutMs: 0,
    });
    const initial = background.getTask(taskId);
    expect((initial as unknown as { timeoutMs?: number }).timeoutMs).toBe(0);

    const info = await background.wait(taskId, 5);
    const raced = info === undefined ? undefined : {
      status: info.status,
      stopReason: info.stopReason,
    };
    expect(raced?.status).toBe('running');
    expect(raced?.stopReason).toBeUndefined();
    resolveFn({ result: 'finished' });
    await expect(background.wait(taskId)).resolves.toMatchObject({ status: 'completed' });
  });
});

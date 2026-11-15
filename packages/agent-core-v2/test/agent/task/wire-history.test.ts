import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'pathe';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  type AgentTaskInfo,
  IAgentTaskService,
} from '#/agent/task/task';
import { IAgentLoopService } from '#/agent/loop/loop';
import { IEventBus } from '#/app/event/eventBus';
import { IWireService } from '#/wire/wire';
import { stubAgentWire } from '../../wire/stubs';
import {
  agentService,
  createTestAgent,
  homeDirServices,
  taskServices,
  type TestAgentContext,
} from '../../harness';
import {
  createAgentTaskPersistence,
  installControlledTask,
  restoreTaskHistory,
  startControlledTaskInLoop,
  taskHistoryRecords,
} from './stubs';

function processInfo(
  overrides: Partial<Extract<AgentTaskInfo, { kind: 'process' }>> = {},
): Extract<AgentTaskInfo, { kind: 'process' }> {
  return {
    taskId: 'bash-00000001',
    kind: 'process',
    command: 'sleep 60',
    description: 'historical process',
    pid: 1234,
    startedAt: 100,
    endedAt: null,
    exitCode: null,
    status: 'running',
    detached: true,
    parentToolCallId: 'tool-call-1',
    ...overrides,
  };
}

describe('AgentTaskService Wire history', () => {
  let sessionDir: string;
  let ctx: TestAgentContext;

  beforeEach(async () => {
    sessionDir = await mkdtemp(join(tmpdir(), 'kimi-task-wire-history-'));
    ctx = createTestAgent(homeDirServices(sessionDir), taskServices());
  });

  afterEach(async () => {
    await ctx.dispose();
    await rm(sessionDir, { recursive: true, force: true });
  });

  it('restores an empty read model from an empty journal', async () => {
    await ctx.restore([]);

    expect(ctx.get(IAgentTaskService).list(false)).toEqual([]);
  });

  it('projects a restored running task as lost without manufacturing endedAt', async () => {
    ctx.mockNextResponse({ type: 'text', text: 'restored lost task acknowledged' });
    await restoreTaskHistory(ctx, [processInfo()]);
    await vi.waitFor(() => {
      expect(ctx.get(IAgentLoopService).history().filter((message) =>
        message.origin?.kind === 'task' && message.origin.status === 'lost')).toHaveLength(1);
    });
    await ctx.get(IAgentLoopService).settled();

    expect(ctx.get(IAgentTaskService).getTask('bash-00000001')).toMatchObject({
      status: 'lost',
      startedAt: 100,
      endedAt: null,
    });
  });

  it('does not dispatch or persist TaskTerminated for a restored running task', async () => {
    const emitted: string[] = [];
    ctx.get(IEventBus).subscribe((event) => {
      emitted.push(event.type);
    });
    ctx.mockNextResponse({ type: 'text', text: 'restored lost task acknowledged' });
    await restoreTaskHistory(ctx, [processInfo()]);
    await vi.waitFor(() => {
      expect(ctx.get(IAgentLoopService).history().filter((message) =>
        message.origin?.kind === 'task' && message.origin.status === 'lost')).toHaveLength(1);
    });
    await ctx.get(IAgentLoopService).settled();

    expect(emitted.filter((type) => type === 'task.terminated')).toEqual([]);
    expect((await ctx.persistedWireRecords()).filter((record) => record.type === 'task.terminated')).toEqual([]);
  });

  it('preserves the complete terminal fields of a completed task', async () => {
    const completed = processInfo({
      status: 'completed',
      endedAt: 200,
      exitCode: 0,
      stopReason: 'finished',
      timeoutMs: 5000,
      terminalNotificationSuppressed: true,
    });

    await restoreTaskHistory(ctx, [completed]);

    expect(ctx.get(IAgentTaskService).getTask(completed.taskId)).toEqual(completed);
  });

  it('preserves timed_out and its domain-specific terminal fields', async () => {
    const timedOut = processInfo({
      status: 'timed_out',
      endedAt: 500,
      exitCode: 124,
      stopReason: 'deadline',
      timeoutMs: 100,
      terminalNotificationSuppressed: true,
    });

    await restoreTaskHistory(ctx, [timedOut]);

    expect(ctx.get(IAgentTaskService).getTask(timedOut.taskId)).toEqual(timedOut);
  });

  it('reduces started and terminated records to one latest historical entry', async () => {
    const completed = processInfo({
      status: 'completed',
      endedAt: 200,
      exitCode: 0,
      terminalNotificationSuppressed: true,
    });

    await restoreTaskHistory(ctx, [completed]);

    expect(ctx.get(IAgentTaskService).list(false)).toEqual([completed]);
  });

  it('reads the full restore journal rather than only the active restorable chain', async () => {
    const journal = taskHistoryRecords([processInfo()]);
    const wire = {
      ...stubAgentWire(),
      readRestoreChains: async () => ({ restorable: [], journal }),
    };
    const subject = createTestAgent(
      taskServices(),
      agentService(IWireService, wire),
    );
    try {
      await subject.restorePersisted();

      expect(subject.get(IAgentTaskService).getTask('bash-00000001')).toMatchObject({
        status: 'lost',
        endedAt: null,
      });
    } finally {
      await subject.dispose();
    }
  });

  it('prefers a live entry over journal history with the same task id', async () => {
    const tasks = ctx.get(IAgentTaskService);
    const controlled = await startControlledTaskInLoop(ctx, { description: 'live process' });
    const taskId = controlled.handler.taskId;
    const historical = processInfo({
      taskId,
      description: 'historical process',
      status: 'completed',
      endedAt: 200,
      exitCode: 0,
      terminalNotificationSuppressed: true,
    });

    await restoreTaskHistory(ctx, [historical]);

    expect(tasks.getTask(taskId)).toMatchObject({
      description: 'live process',
      status: 'running',
      endedAt: null,
    });
    expect(tasks.list(false).filter((info) => info.taskId === taskId)).toHaveLength(1);
    controlled.resolve('');
    await controlled.handler.wait();
  });

  it('lists live tasks as active and includes lost tasks only in full history', async () => {
    installControlledTask(ctx);
    ctx.mockNextResponse({ type: 'text', text: 'restored lost task acknowledged' });
    await restoreTaskHistory(ctx, [processInfo()]);
    await vi.waitFor(() => {
      expect(ctx.get(IAgentLoopService).history().filter((message) =>
        message.origin?.kind === 'task' && message.origin.status === 'lost')).toHaveLength(1);
    });
    await ctx.get(IAgentLoopService).settled();
    const tasks = ctx.get(IAgentTaskService);
    const controlled = await startControlledTaskInLoop(ctx, { description: 'live process' });
    const liveId = controlled.handler.taskId;

    expect(tasks.list(true).map((info) => info.taskId)).toEqual([liveId]);
    expect(tasks.list(false).map((info) => info.taskId)).toEqual([
      liveId,
      'bash-00000001',
    ]);
    controlled.resolve('');
    await controlled.handler.wait();
  });

  it('ignores journal records owned by another agent', async () => {
    await restoreTaskHistory(ctx, [processInfo()], 'agent-other');

    expect(ctx.get(IAgentTaskService).list(false)).toEqual([]);
  });

  it('restores an undelivered terminal notification through Core once', async () => {
    const completed = processInfo({ status: 'completed', endedAt: 200, exitCode: 0 });
    ctx.mockNextResponse({ type: 'text', text: 'restored completion' });

    await restoreTaskHistory(ctx, [completed]);
    await ctx.get(IAgentLoopService).settled();

    const origins = ctx.get(IAgentLoopService).history().map((message) => message.origin);
    expect(origins.filter((origin) => origin?.kind === 'task' && origin.taskId === completed.taskId)).toHaveLength(1);
    expect(ctx.allEvents.filter((event) => event.event === 'task.notified')).toHaveLength(0);
    const records = await ctx.persistedWireRecords();
    expect(records.some((record) => record.type === 'turn.prompt' && (record['origin'] as { kind?: string }).kind === 'task')).toBe(true);
    expect(JSON.stringify(records)).toContain('<notification');
    expect(JSON.stringify(records)).not.toContain('[async tool completed]');
  });

  it('does not restore terminal notifications already delivered by Loop history or WaitFor', async () => {
    const completed = processInfo({ status: 'completed', endedAt: 200, exitCode: 0 });
    const waitCompleted = processInfo({
      taskId: 'bash-00000002',
      parentToolCallId: 'tool-call-2',
      status: 'completed',
      endedAt: 201,
      exitCode: 0,
    });
    const origin = {
      kind: 'task',
      taskId: completed.taskId,
      status: 'completed',
      notificationId: `task:${completed.taskId}:completed`,
    } as const;
    const records = [
      {
        type: 'context.append_message',
        message: {
          role: 'user',
          content: [{ type: 'text', text: 'already delivered' }],
          toolCalls: [],
          origin,
        },
      },
      ...taskHistoryRecords([completed, waitCompleted]),
      {
        type: 'task.waitDelivered',
        agentId: 'main',
        keys: [`${waitCompleted.taskId}\0completed\0task:${waitCompleted.taskId}:completed`],
      },
    ];

    await ctx.restore(records);
    ctx.get(IAgentLoopService).flushReminders();

    const origins = ctx.get(IAgentLoopService).history().map((message) => message.origin);
    expect(origins.filter((candidate) => candidate?.kind === 'task' && candidate.taskId === completed.taskId)).toHaveLength(1);
    expect(origins.some((candidate) => candidate?.kind === 'task' && candidate.taskId === waitCompleted.taskId)).toBe(false);
    expect(ctx.allEvents.filter((event) => event.event === 'task.notified')).toHaveLength(0);
    expect((await ctx.persistedWireRecords()).filter((record) => record.type === 'task.waitDelivered')).toHaveLength(1);
  });

  it('reads restored output exclusively from output.log', async () => {
    const completed = processInfo({
      status: 'completed',
      endedAt: 200,
      exitCode: 0,
      terminalNotificationSuppressed: true,
    });
    const persistence = createAgentTaskPersistence(sessionDir);
    await persistence.appendTaskOutput(completed.taskId, 'persisted output');

    await restoreTaskHistory(ctx, [completed]);

    const tasks = ctx.get(IAgentTaskService);
    expect(await tasks.readOutput(completed.taskId)).toBe('persisted output');
    expect(await tasks.getOutputSnapshot(completed.taskId, 100)).toMatchObject({
      outputPath: persistence.taskOutputFile(completed.taskId),
      outputSizeBytes: 16,
      fullOutputAvailable: true,
      preview: 'persisted output',
    });
  });

  it('keeps repeated restores idempotent without synthesizing terminal records', async () => {
    ctx.mockNextResponse({ type: 'text', text: 'restored lost task acknowledged' });
    await restoreTaskHistory(ctx, [processInfo()]);
    await vi.waitFor(() => {
      expect(ctx.get(IAgentLoopService).history().filter((message) =>
        message.origin?.kind === 'task' && message.origin.status === 'lost')).toHaveLength(1);
    });
    await ctx.get(IAgentLoopService).settled();
    await ctx.restore(await ctx.persistedWireRecords());
    await ctx.get(IAgentLoopService).settled();

    expect(ctx.get(IAgentTaskService).list(false)).toHaveLength(1);
    expect(ctx.get(IAgentTaskService).getTask('bash-00000001')?.endedAt).toBeNull();
    expect(ctx.get(IAgentLoopService).history().filter((message) =>
      message.origin?.kind === 'task' && message.origin.status === 'lost')).toHaveLength(1);
    expect((await ctx.persistedWireRecords()).filter((record) => record.type === 'task.terminated')).toEqual([]);
  });
});

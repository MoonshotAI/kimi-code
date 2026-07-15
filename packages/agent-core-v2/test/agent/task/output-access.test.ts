import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { Readable } from 'node:stream';
import type { Writable } from 'node:stream';
import { join } from 'pathe';
import type { IProcess } from '#/session/process/processRunner';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { IAgentTaskService } from '#/agent/task/task';
import { IAgentLoopService } from '#/agent/loop/loop';
import { TERMINAL_STATUSES } from '#/agent/task/types';
import { TaskOutputTool } from '#/agent/task/tools/task-output';
import { ProcessTask } from '#/os/backends/node-local/tools/process-task';
import { createAgentTaskPersistence, type TaskServiceTestManager } from './stubs';
import { taskServices, createTestAgent, homeDirServices, type TestAgentContext } from '../../harness';
import { executeTool, type TestExecutableToolContext } from '../../tools/fixtures/execute-tool';

interface TaskServiceFixture {
  readonly ctx: TestAgentContext;
  readonly manager: TaskServiceTestManager;
  readonly persistence: ReturnType<typeof createAgentTaskPersistence>;
}

function createTaskService(homedir: string): TaskServiceFixture {
  const persistence = createAgentTaskPersistence(homedir);
  const ctx = createTestAgent(homeDirServices(homedir), taskServices());
  const manager = ctx.get(IAgentTaskService) as TaskServiceTestManager;
  return {
    ctx,
    manager,
    persistence,
  };
}

function registerProcess(
  manager: IAgentTaskService,
  proc: IProcess,
  command: string,
  description: string,
): string {
  return manager.registerTask(new ProcessTask(proc, command, description));
}

function toolContext<Input>(
  toolCallId: string,
  args: Input,
): TestExecutableToolContext<Input> {
  return {
    turnId: 0,
    toolCallId,
    args,
    signal: new AbortController().signal,
  };
}

function outputString(result: { readonly output: string | readonly unknown[] }): string {
  return typeof result.output === 'string' ? result.output : JSON.stringify(result.output);
}

async function waitForOutput(
  manager: IAgentTaskService,
  taskId: string,
  expected: string,
): Promise<void> {
  for (let i = 0; i < 20; i++) {
    const output = await manager.readOutput(taskId);
    if (output.includes(expected)) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(`Timed out waiting for output: ${expected}`);
}

async function waitForTaskNotifications(
  ctx: TestAgentContext,
  manager: TaskServiceTestManager,
): Promise<void> {
  const tasks = manager.list(false).filter(
    (task) =>
      TERMINAL_STATUSES.has(task.status) &&
      task.detached !== false &&
      task.terminalNotificationSuppressed !== true,
  );
  if (tasks.length === 0) return;

  ctx.mockNextResponse({ type: 'text', text: 'notification drain ack' });
  await vi.waitFor(() => {
    const delivered = ctx.allEvents.filter((e) => e.event === 'task.notified').length;
    expect(delivered).toBeGreaterThanOrEqual(tasks.length);
  });
  await vi.waitFor(() => {
    const loop = ctx.get(IAgentLoopService);
    expect(loop.status().state).toBe('idle');
    expect(loop.hasPendingRequests()).toBe(false);
  });

  const origins = ctx.context.get().map((message) => message.origin);
  for (const task of tasks) {
    expect(origins).toContainEqual({
      kind: 'task',
      taskId: task.taskId,
      status: task.status,
      notificationId: `task:${task.taskId}:${task.status}`,
    });
  }
}

function immediateProcess(exitCode: number, stdoutText = ''): IProcess {
  return {
    stdin: { write: vi.fn(), end: vi.fn() } as unknown as Writable,
    stdout: Readable.from(stdoutText ? [stdoutText] : []),
    stderr: Readable.from([]),
    pid: 50000 + exitCode,
    exitCode,
    wait: vi.fn().mockResolvedValue(exitCode) as IProcess['wait'],
    kill: vi.fn().mockResolvedValue(undefined) as IProcess['kill'],
    dispose: vi.fn().mockResolvedValue(undefined) as IProcess['dispose'],
  };
}

describe('AgentTaskService — readOutput / getOutputSnapshot', () => {
  let sessionDir: string;
  let ctx: TestAgentContext;
  let manager: TaskServiceTestManager;
  let persistence: ReturnType<typeof createAgentTaskPersistence>;

  beforeEach(() => {
    sessionDir = mkdtempSync(join(tmpdir(), 'bpm-output-'));
    const fixture = createTaskService(sessionDir);
    ctx = fixture.ctx;
    manager = fixture.manager;
    persistence = fixture.persistence;
  });

  afterEach(async () => {
    try {
      await waitForTaskNotifications(ctx, manager);
      await ctx.expectResumeMatches();
    } finally {
      await ctx.dispose();
      rmSync(sessionDir, { recursive: true, force: true });
    }
  });

  it('getOutputSnapshot returns output.log path when persisted output exists', async () => {
    const taskId = registerProcess(manager, immediateProcess(0, 'hello\n'), 'echo', 'demo');

    await waitForOutput(manager, taskId, 'hello');
    const snapshot = await manager.getOutputSnapshot(taskId, 1_000);
    await manager.wait(taskId);

    expect(snapshot.outputPath).toBeDefined();
    expect(snapshot.outputPath).toContain(sessionDir);
    expect(snapshot.outputPath).toContain(taskId);
    expect(snapshot.outputPath!.endsWith('output.log')).toBe(true);
    expect(snapshot.fullOutputAvailable).toBe(true);
  });

  it('getOutputSnapshot truncates large persisted output to a tail preview with paging metadata', async () => {
    const head = 'HEAD-MARKER\n';
    const tail = 'TAIL-MARKER\n';
    const output = head + 'x'.repeat(200 * 1024) + tail;
    const taskId = registerProcess(manager, immediateProcess(0, output), 'echo big', 'large');

    await manager.wait(taskId);
    const snapshot = await manager.getOutputSnapshot(taskId, 32 * 1024);

    expect(snapshot.outputPath).toBeDefined();
    expect(snapshot.outputSizeBytes).toBe(Buffer.byteLength(output));
    expect(snapshot.previewBytes).toBe(32 * 1024);
    expect(snapshot.truncated).toBe(true);
    expect(snapshot.fullOutputAvailable).toBe(true);
    expect(snapshot.preview).toContain(tail);
    expect(snapshot.preview).not.toContain(head);
  });

  it('getOutputSnapshot omits outputPath when no persisted log file exists', async () => {
    const taskId = registerProcess(manager, immediateProcess(0), 'sleep 1', 'silent task');

    await manager.wait(taskId);
    const snapshot = await manager.getOutputSnapshot(taskId, 1_000);

    expect(snapshot.outputPath).toBeUndefined();
    expect(snapshot.fullOutputAvailable).toBe(false);
  });

  it('getOutputSnapshot returns an empty snapshot for unknown task ids', async () => {
    await expect(manager.getOutputSnapshot('bash-deadbeef', 1_000)).resolves.toEqual({
      outputSizeBytes: 0,
      previewBytes: 0,
      truncated: false,
      fullOutputAvailable: false,
      preview: '',
    });
  });

  it('readOutput returns live ring-buffer content while task is in memory', async () => {
    const taskId = registerProcess(
      manager,
      immediateProcess(0, 'live content\n'),
      'echo',
      'demo',
    );

    await waitForOutput(manager, taskId, 'live content');

    expect(await manager.readOutput(taskId)).toContain('live content');
    await manager.wait(taskId);
  });

  it('readOutput prefers disk over the live ring buffer when persisted output exists', async () => {
    const taskId = registerProcess(manager, immediateProcess(0, 'ring-only\n'), 'echo', 'demo');

    await waitForOutput(manager, taskId, 'ring-only');
    await persistence.appendTaskOutput(taskId, 'disk-only\n');

    expect(await manager.readOutput(taskId)).toContain('disk-only');
    await manager.wait(taskId);
  });

  it('readOutput falls back to disk for ghost tasks', async () => {
    const taskId = registerProcess(
      manager,
      immediateProcess(0, 'persisted line\n'),
      'echo',
      'demo',
    );
    await waitForOutput(manager, taskId, 'persisted line');
    await manager.wait(taskId);

    const freshFixture = createTaskService(sessionDir);
    const fresh = freshFixture.manager;
    try {
      await fresh.loadFromDisk();
      await fresh.reconcile();

      expect(await fresh.readOutput(taskId)).toContain('persisted line');
      await freshFixture.ctx.expectResumeMatches();
    } finally {
      await freshFixture.ctx.dispose();
    }
  });

  it('TaskOutputTool reads persisted output for a ghost task loaded after restart', async () => {
    const taskId = registerProcess(
      manager,
      immediateProcess(0, 'persisted output\n'),
      'echo persisted output',
      'persist output test',
    );
    await waitForOutput(manager, taskId, 'persisted output');
    await manager.wait(taskId);

    const freshFixture = createTaskService(sessionDir);
    const fresh = freshFixture.manager;
    try {
      await fresh.loadFromDisk();
      await fresh.reconcile();

      const result = await executeTool(
        new TaskOutputTool(fresh),
        toolContext('task_output_restored', { task_id: taskId }),
      );
      const output = outputString(result);

      expect(result.isError ?? false).toBe(false);
      expect(output).toContain('status: completed');
      expect(output).toContain('output_path:');
      expect(output).toContain('persisted output');
      await freshFixture.ctx.expectResumeMatches();
    } finally {
      await freshFixture.ctx.dispose();
    }
  });

  it('readOutput respects tail length', async () => {
    const taskId = registerProcess(
      manager,
      immediateProcess(0, 'aaaaa-bbbbb-ccccc-ddddd'),
      'echo',
      'demo',
    );

    await waitForOutput(manager, taskId, 'ddddd');

    expect(await manager.readOutput(taskId, 5)).toBe('ddddd');
    await manager.wait(taskId);
  });
});

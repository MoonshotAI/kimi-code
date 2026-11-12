import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'pathe';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { IAgentTaskService, type AgentTaskInfo } from '#/agent/task/task';
import { IAgentLoopService } from '#/agent/loop/loop';
import { TERMINAL_STATUSES } from '#/agent/task/types';
import { IAgentTaskOutputService } from '#/agent/task/taskOutput';
import {
  taskServices,
  createTestAgent,
  homeDirServices,
  type TestAgentContext,
} from '../../harness';
import {
  TASK_TEST_AGENT_SCOPE,
  createAgentTaskPersistence,
  startControlledTaskInLoop,
} from './stubs';

const MAX_OUTPUT_BYTES = 1024 * 1024;
const tick = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 5));

async function drainPendingNotifications(
  ctx: TestAgentContext,
  background: IAgentTaskService,
): Promise<void> {
  const expectsNotification = background.list(false).some(
    (task) => TERMINAL_STATUSES.has(task.status) && task.detached !== false,
  );
  if (expectsNotification) {
    ctx.mockNextResponse({ type: 'text', text: 'notification drain ack' });
    await vi.waitFor(() => {
      expect(ctx.context.history().some((message) => message.origin?.kind === 'task')).toBe(true);
    });
  }
  await ctx.get(IAgentLoopService).settled();
}

describe('AgentTaskService — foreground persistence', () => {
  let sessionDir: string;
  let persistence: ReturnType<typeof createAgentTaskPersistence>;
  let ctx: TestAgentContext;
  let background: IAgentTaskService;

  beforeEach(() => {
    sessionDir = mkdtempSync(join(tmpdir(), 'bpm-fg-'));
    persistence = createAgentTaskPersistence(sessionDir);
    ctx = createTestAgent(homeDirServices(sessionDir), taskServices());
    background = ctx.get(IAgentTaskService);
  });

  afterEach(async () => {
    try {
      await drainPendingNotifications(ctx, background);
      await ctx.expectResumeMatches();
    } finally {
      await ctx.dispose();
      rmSync(sessionDir, { recursive: true, force: true });
    }
  });

  const taskJsonPath = (taskId: string): string =>
    join(sessionDir, TASK_TEST_AGENT_SCOPE, 'tasks', `${taskId}.json`);

  it('writes only output.log for a foreground task that does not spill or detach', async () => {
    const changes: AgentTaskInfo[] = [];
    background.onDidChangeTask((info) => changes.push(info));
    const controlled = await startControlledTaskInLoop(ctx, {
      description: 'demo',
      detached: false,
      output: 'hello\n',
      completion: Promise.resolve(''),
    });
    const taskId = controlled.handler.taskId;

    await background.wait(taskId);
    await vi.waitFor(() => {
      expect(changes.at(-1)).toMatchObject({ taskId, status: 'completed', detached: false });
    });

    expect(existsSync(taskJsonPath(taskId))).toBe(false);
    expect(existsSync(persistence.taskOutputFile(taskId))).toBe(true);

    const snapshot = await background.getOutputSnapshot(taskId, 1_000);
    expect(snapshot.fullOutputAvailable).toBe(true);
    expect(snapshot.preview).toContain('hello');
  });

  it('flushes complete pre-detach output to disk when a foreground task detaches', async () => {
    const controlled = await startControlledTaskInLoop(ctx, {
      description: 'demo',
      detached: false,
    });
    const taskId = controlled.handler.taskId;

    controlled.write('before-detach\n');
    await ctx.get(IAgentTaskOutputService).open(taskId).flush();
    await tick();
    expect(existsSync(persistence.taskOutputFile(taskId))).toBe(true);

    expect(background.detach(taskId)?.detached).toBe(true);

    controlled.write('after-detach\n');
    controlled.resolve('');
    await background.wait(taskId);

    expect(await background.readOutput(taskId)).toBe('before-detach\nafter-detach\n');
    expect(existsSync(taskJsonPath(taskId))).toBe(false);
  });

  it('spills to disk and keeps the log when foreground output exceeds the buffer', async () => {
    const big = 'a'.repeat(MAX_OUTPUT_BYTES + 1024);
    const controlled = await startControlledTaskInLoop(ctx, {
      description: 'demo',
      detached: false,
      output: big,
      completion: Promise.resolve(''),
    });
    const taskId = controlled.handler.taskId;

    await background.wait(taskId);

    const snapshot = await background.getOutputSnapshot(taskId, 1_000);

    expect(existsSync(persistence.taskOutputFile(taskId))).toBe(true);
    expect(existsSync(taskJsonPath(taskId))).toBe(false);
    expect(snapshot.fullOutputAvailable).toBe(true);
    expect(snapshot.outputSizeBytes).toBe(big.length);
  });
});

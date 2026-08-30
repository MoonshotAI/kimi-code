import { mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'pathe';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { AgentTask, type TaskRuntime } from '#/features/task/taskAgentRuntime';
import type { AgentTaskInfo } from '#/features/task/types';
import { IEventBus } from '#/app/event/eventBus';
import {
  taskServices,
  createTestAgent,
  homeDirServices,
  type TestAgentContext,
} from '../../harness';
import {
  createAgentTaskPersistence,
  writeLegacyTaskFile,
  type TaskServiceTestManager,
} from './stubs';

let sessionDir: string;
let persistence: ReturnType<typeof createAgentTaskPersistence>;

function runningGhost(taskId: string): Extract<AgentTaskInfo, { kind: 'process' }> {
  return {
    taskId,
    kind: 'process',
    command: 'some_old_cmd',
    description: 'ghost from a prior crash',
    pid: 1234,
    startedAt: Date.now() - 60 * 60 * 1000,
    endedAt: null,
    exitCode: null,
    status: 'running',
  };
}

beforeEach(async () => {
  sessionDir = join(
    tmpdir(),
    `kimi-hb-stale-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  );
  await mkdir(sessionDir, { recursive: true });
  persistence = createAgentTaskPersistence(sessionDir);
});

afterEach(async () => {
  await rm(sessionDir, { recursive: true, force: true });
});

describe('Background reconcile — stale ghost detection', () => {
  let ctx: TestAgentContext;
  let background: TaskServiceTestManager;
  let emittedEvents: unknown[];

  beforeEach(() => {
    ctx = createTestAgent(homeDirServices(sessionDir), taskServices());
    background = ctx.resolve(AgentTask) as TaskServiceTestManager;
    emittedEvents = [];
    const events = ctx.get(IEventBus);
    events.subscribe((event) => {
      emittedEvents.push(event);
    });
  });

  afterEach(async () => {
    try {
      await ctx.expectResumeMatches();
    } finally {
      await ctx.dispose();
    }
  });

  it('emits a terminated event with status=lost for a running ghost', async () => {
    await writeLegacyTaskFile(sessionDir, runningGhost('bash-stale000'));

    await background.loadFromDisk();
    await background.reconcile();

    expect(emittedEvents).toContainEqual(
      expect.objectContaining({
        type: 'task.terminated',
        info: expect.objectContaining({
          taskId: 'bash-stale000',
          status: 'lost',
        }),
      }),
    );
  });

  it('second reconcile does not emit a duplicate termination event', async () => {
    await writeLegacyTaskFile(sessionDir, runningGhost('bash-dedup000'));

    await background.loadFromDisk();
    await background.reconcile();
    await background.reconcile();

    expect(
      emittedEvents.filter(
        (event) => (event as { type?: string }).type === 'task.terminated',
      ),
    ).toHaveLength(1);
  });
});

/**
 * AgentTaskService reconcile + persistence integration tests.
 */

import { mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'pathe';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  IAgentTaskService,
  type AgentTaskInfo,
} from '#/agent/task/task';
import { IEventBus } from '#/app/event/eventBus';
import {
  taskServices,
  createTestAgent,
  homeDirServices,
  type TestAgentContext,
} from '../../harness';
import {
  createAgentTaskPersistence,
  type TaskServiceTestManager,
} from './stubs';

let sessionDir: string;
let persistence: ReturnType<typeof createAgentTaskPersistence>;

function persistedProcess(
  overrides: Partial<Extract<AgentTaskInfo, { kind: 'process' }>> = {},
): Extract<AgentTaskInfo, { kind: 'process' }> {
  return {
    taskId: 'bash-orphan00',
    kind: 'process',
    command: 'npm install',
    description: 'install',
    pid: 99999,
    startedAt: 1_700_000_000,
    endedAt: null,
    exitCode: null,
    status: 'running',
    ...overrides,
  };
}

beforeEach(async () => {
  sessionDir = join(
    tmpdir(),
    `kimi-bg-reconcile-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  );
  await mkdir(sessionDir, { recursive: true });
  persistence = createAgentTaskPersistence(sessionDir);
});

afterEach(async () => {
  await rm(sessionDir, { recursive: true, force: true });
});

describe('AgentTaskService — loadFromDisk + reconcile', () => {
  describe('without persisted tasks', () => {
    let ctx: TestAgentContext;
    let background: TaskServiceTestManager;

    beforeEach(() => {
      ctx = createTestAgent(taskServices());
      background = ctx.get(IAgentTaskService) as TaskServiceTestManager;
    });

    afterEach(async () => {
      try {
        await ctx.expectResumeMatches();
      } finally {
        await ctx.dispose();
      }
    });

    it('loadFromDisk does nothing when no tasks are persisted', async () => {
      await background.loadFromDisk();

      expect(background.list(false)).toEqual([]);
    });
  });

  describe('with persistence', () => {
    let ctx: TestAgentContext;
    let background: TaskServiceTestManager;
    let emittedEvents: unknown[];

    beforeEach(() => {
      ctx = createTestAgent(homeDirServices(sessionDir), taskServices());
      background = ctx.get(IAgentTaskService) as TaskServiceTestManager;
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

    it('reconciles a previously-running task as lost', async () => {
      await persistence.writeTask(persistedProcess());

      await background.loadFromDisk();
      await background.reconcile();

      expect(background.getTask('bash-orphan00')).toMatchObject({
        taskId: 'bash-orphan00',
        status: 'lost',
      });
      expect(await persistence.readTask('bash-orphan00')).toMatchObject({
        taskId: 'bash-orphan00',
        status: 'lost',
      });
      expect(emittedEvents).toContainEqual({
        type: 'task.terminated',
        info: expect.objectContaining({
          taskId: 'bash-orphan00',
          status: 'lost',
        }),
      });
    });

    it('runtime restore reconciles persisted tasks through the task resume hook', async () => {
      await persistence.writeTask(
        persistedProcess({
          taskId: 'bash-restore0',
          command: 'sleep 9999',
          description: 'restore hook check',
          pid: 4242,
        }),
      );

      await ctx.restore([]);

      expect(background.getTask('bash-restore0')).toMatchObject({
        taskId: 'bash-restore0',
        status: 'lost',
      });
      expect(await persistence.readTask('bash-restore0')).toMatchObject({
        taskId: 'bash-restore0',
        status: 'lost',
      });
      expect(emittedEvents).toContainEqual({
        type: 'task.terminated',
        info: expect.objectContaining({
          taskId: 'bash-restore0',
          status: 'lost',
        }),
      });
    });

    it('does not reclassify already-terminal tasks', async () => {
      await persistence.writeTask(
        persistedProcess({
          taskId: 'bash-done0000',
          command: 'echo hi',
          description: 'echo',
          pid: 88888,
          endedAt: 1_700_000_010,
          exitCode: 0,
          status: 'completed',
        }),
      );
      await persistence.writeTask(
        persistedProcess({
          taskId: 'bash-running0',
          command: 'sleep 1000',
          description: 'sleep',
          pid: 77777,
        }),
      );

      await background.loadFromDisk();
      await background.reconcile();

      expect(await persistence.readTask('bash-done0000')).toMatchObject({
        status: 'completed',
      });
      expect(await persistence.readTask('bash-running0')).toMatchObject({
        status: 'lost',
      });
      const terminationEvents = emittedEvents.filter(
        (event) => (event as { type?: string }).type === 'task.terminated',
      );
      expect(terminationEvents).toHaveLength(1);
      expect(terminationEvents[0]).toMatchObject({
        type: 'task.terminated',
        info: { taskId: 'bash-running0', status: 'lost' },
      });
    });

    it('list(activeOnly=false) includes ghosts; list(true) excludes them', async () => {
      await persistence.writeTask(
        persistedProcess({
          taskId: 'bash-lost0000',
          command: 'x',
          description: 'd',
          pid: 1,
        }),
      );

      await background.loadFromDisk();
      await background.reconcile();

      expect(background.list(true)).toEqual([]);
      expect(background.list(false)).toEqual([
        expect.objectContaining({ taskId: 'bash-lost0000', status: 'lost' }),
      ]);
    });

    it('getTask returns ghost when the live process map has no entry', async () => {
      await persistence.writeTask(
        persistedProcess({
          taskId: 'bash-ghost000',
          command: 'x',
          description: 'd',
          pid: 1,
        }),
      );

      await background.loadFromDisk();
      await background.reconcile();

      expect(background.getTask('bash-ghost000')).toMatchObject({
        taskId: 'bash-ghost000',
        status: 'lost',
      });
    });

    it('reconcile emits nothing when no ghosts were loaded', async () => {
      await background.loadFromDisk();
      await background.reconcile();

      expect(emittedEvents).toEqual([]);
    });

    it('marks multiple persisted tasks as lost in a single reconcile pass', async () => {
      await persistence.writeTask(persistedProcess({ taskId: 'bash-orphan01', command: 'sleep 1', description: 'orphan 1', pid: 101 }));
      await persistence.writeTask(persistedProcess({ taskId: 'bash-orphan02', command: 'sleep 2', description: 'orphan 2', pid: 102 }));
      await persistence.writeTask(persistedProcess({ taskId: 'bash-orphan03', command: 'sleep 3', description: 'orphan 3', pid: 103 }));

      await background.loadFromDisk();
      await background.reconcile();

      expect(background.getTask('bash-orphan01')).toMatchObject({ taskId: 'bash-orphan01', status: 'lost' });
      expect(background.getTask('bash-orphan02')).toMatchObject({ taskId: 'bash-orphan02', status: 'lost' });
      expect(background.getTask('bash-orphan03')).toMatchObject({ taskId: 'bash-orphan03', status: 'lost' });
      expect(await persistence.readTask('bash-orphan01')).toMatchObject({ status: 'lost' });
      expect(await persistence.readTask('bash-orphan02')).toMatchObject({ status: 'lost' });
      expect(await persistence.readTask('bash-orphan03')).toMatchObject({ status: 'lost' });
      const terminationEvents = emittedEvents.filter(
        (event) => (event as { type?: string }).type === 'task.terminated',
      );
      expect(terminationEvents).toHaveLength(3);
    });

    it('loadFromDisk followed by reconcile is idempotent when called twice', async () => {
      await persistence.writeTask(persistedProcess({ taskId: 'bash-idempot', pid: 42 }));

      await background.loadFromDisk();
      await background.reconcile();
      const emittedBefore = emittedEvents.length;

      await background.loadFromDisk();
      await background.reconcile();

      expect(emittedEvents.length).toBe(emittedBefore);
      expect(background.getTask('bash-idempot')).toMatchObject({ status: 'lost' });
    });

    it('reconcile does not emit events for tasks that are already marked lost on disk', async () => {
      await persistence.writeTask(persistedProcess({ taskId: 'bash-already-lost', pid: 1, status: 'lost', endedAt: 1_700_000_010, exitCode: 143 }));

      await background.loadFromDisk();
      await background.reconcile();

      const terminationEvents = emittedEvents.filter(
        (event) => (event as { type?: string }).type === 'task.terminated',
      );
      expect(terminationEvents).toHaveLength(0);
    });

    it('does not emit duplicate termination events on a second reconcile pass', async () => {
      await persistence.writeTask(
        persistedProcess({
          taskId: 'bash-nodup000',
          command: 'sleep 9999',
          description: 'dedupe check',
          pid: 42,
        }),
      );

      await background.loadFromDisk();
      await background.reconcile();
      await background.reconcile();

      expect(
        emittedEvents.filter(
          (event) => (event as { type?: string }).type === 'task.terminated',
        ),
      ).toHaveLength(1);
    });

    it('restores terminal ghost notifications into context', async () => {
      await persistence.writeTask(
        persistedProcess({
          taskId: 'bash-done0001',
          command: 'echo done',
          description: 'one-shot',
          pid: 42,
          endedAt: 1_700_000_010,
          exitCode: 0,
          status: 'completed',
        }),
      );

      await background.loadFromDisk();
      await background.reconcile();

      expect(background.getTask('bash-done0001')).toMatchObject({
        taskId: 'bash-done0001',
        status: 'completed',
      });
      expect(
        emittedEvents.filter(
          (event) => (event as { type?: string }).type === 'task.terminated',
        ),
      ).toEqual([]);
    });
  });
});

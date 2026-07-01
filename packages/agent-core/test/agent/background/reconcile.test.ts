/**
 * BackgroundManager reconcile + persistence integration tests.
 */

import { mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'pathe';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  BackgroundTaskPersistence,
  type BackgroundTaskInfo,
} from '../../../src/agent/background';
import { createBackgroundManager } from './helpers';

let sessionDir: string;
let persistence: BackgroundTaskPersistence;

function persistedProcess(
  overrides: Partial<Extract<BackgroundTaskInfo, { kind: 'process' }>> = {},
): Extract<BackgroundTaskInfo, { kind: 'process' }> {
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
  persistence = new BackgroundTaskPersistence(sessionDir);
});

afterEach(async () => {
  await rm(sessionDir, { recursive: true, force: true });
});

describe('BackgroundManager — loadFromDisk + reconcile', () => {
  it('loadFromDisk does nothing when persistence is not configured', async () => {
    const { manager } = createBackgroundManager();

    await manager.loadFromDisk();

    expect(manager.list(false)).toEqual([]);
  });

  it('reconciles a previously-running task as lost', async () => {
    await persistence.writeTask(persistedProcess());
    const { agent, manager } = createBackgroundManager({ sessionDir });

    await manager.loadFromDisk();
    await manager.reconcile();

    expect(manager.getTask('bash-orphan00')).toMatchObject({
      taskId: 'bash-orphan00',
      status: 'lost',
    });
    expect(await persistence.readTask('bash-orphan00')).toMatchObject({
      taskId: 'bash-orphan00',
      status: 'lost',
    });
    expect(agent.emittedEvents).toContainEqual({
      type: 'background.task.terminated',
      info: expect.objectContaining({
        taskId: 'bash-orphan00',
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
    const { agent, manager } = createBackgroundManager({ sessionDir });

    await manager.loadFromDisk();
    await manager.reconcile();

    expect(await persistence.readTask('bash-done0000')).toMatchObject({
      status: 'completed',
    });
    expect(await persistence.readTask('bash-running0')).toMatchObject({
      status: 'lost',
    });
    expect(agent.emittedEvents).toHaveLength(1);
    expect(agent.emittedEvents[0]).toMatchObject({
      type: 'background.task.terminated',
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
    const { manager } = createBackgroundManager({ sessionDir });

    await manager.loadFromDisk();
    await manager.reconcile();

    expect(manager.list(true)).toEqual([]);
    expect(manager.list(false)).toEqual([
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
    const { manager } = createBackgroundManager({ sessionDir });

    await manager.loadFromDisk();
    await manager.reconcile();

    expect(manager.getTask('bash-ghost000')).toMatchObject({
      taskId: 'bash-ghost000',
      status: 'lost',
    });
  });

  it('reconcile emits nothing when no ghosts were loaded', async () => {
    const { agent, manager } = createBackgroundManager({ sessionDir });

    await manager.loadFromDisk();
    await manager.reconcile();

    expect(agent.emittedEvents).toEqual([]);
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
    const { agent, manager } = createBackgroundManager({ sessionDir });

    await manager.loadFromDisk();
    await manager.reconcile();
    await manager.reconcile();

    expect(
      agent.emittedEvents.filter(
        (event) => event.type === 'background.task.terminated',
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
    const { agent, manager } = createBackgroundManager({ sessionDir });

    await manager.loadFromDisk();
    await manager.reconcile();

    expect(agent.context.appendUserMessage).toHaveBeenCalledWith(
      [
        expect.objectContaining({
          type: 'text',
          text: expect.stringContaining('task.completed'),
        }),
      ],
      expect.objectContaining({
        kind: 'background_task',
        taskId: 'bash-done0001',
        status: 'completed',
      }),
    );
    expect(agent.emittedEvents).toEqual([]);
  });

  it('preserves running tasks when trimming loaded ghosts exceeds the bound', async () => {
    // Simulate a resumed session with >100 persisted task records: one
    // still-running task and 110 completed tasks. The trim must not drop
    // the running task before reconcile marks it lost — otherwise the
    // lost-task notification is suppressed and the user is never told
    // their background process died.
    const runningTask = persistedProcess({
      taskId: 'bash-running0',
      command: 'sleep 9999',
      description: 'long sleep',
      pid: 77777,
      // Give the running task a recent startedAt so it survives the
      // post-reconcile trim (oldest terminal ghosts are dropped first).
      startedAt: 1_700_999_000,
    });
    await persistence.writeTask(runningTask);
    for (let i = 0; i < 110; i++) {
      await persistence.writeTask(
        persistedProcess({
          taskId: `bash-done${String(i).padStart(4, '0')}`,
          command: 'echo done',
          description: 'completed',
          pid: 1000 + i,
          startedAt: 1_700_000_001 + i,
          endedAt: 1_700_000_010 + i,
          exitCode: 0,
          status: 'completed',
        }),
      );
    }
    const { agent, manager } = createBackgroundManager({ sessionDir });

    await manager.loadFromDisk();
    await manager.reconcile();

    // The running task must have been reclassified as lost and emitted.
    expect(manager.getTask('bash-running0')).toMatchObject({
      taskId: 'bash-running0',
      status: 'lost',
    });
    expect(agent.emittedEvents).toContainEqual({
      type: 'background.task.terminated',
      info: expect.objectContaining({
        taskId: 'bash-running0',
        status: 'lost',
      }),
    });
    // The ghost set should be bounded to 100 after reconcile.
    expect(manager.list(false)).toHaveLength(100);
  });

  it('emits lost-task notification even when the running task is the oldest', async () => {
    // Edge case: the running task has the oldest startedAt, so after
    // reconcile marks it lost, the post-reconcile trim would drop it.
    // The notification must still be emitted before the trim runs.
    const runningTask = persistedProcess({
      taskId: 'bash-running0',
      command: 'sleep 9999',
      description: 'long sleep',
      pid: 77777,
      startedAt: 1_700_000_000,
    });
    await persistence.writeTask(runningTask);
    for (let i = 0; i < 110; i++) {
      await persistence.writeTask(
        persistedProcess({
          taskId: `bash-done${String(i).padStart(4, '0')}`,
          command: 'echo done',
          description: 'completed',
          pid: 1000 + i,
          startedAt: 1_700_000_001 + i,
          endedAt: 1_700_000_010 + i,
          exitCode: 0,
          status: 'completed',
        }),
      );
    }
    const { agent, manager } = createBackgroundManager({ sessionDir });

    await manager.loadFromDisk();
    await manager.reconcile();

    // The notification must be emitted even though the task is trimmed
    // from the ghost map afterward.
    expect(agent.emittedEvents).toContainEqual({
      type: 'background.task.terminated',
      info: expect.objectContaining({
        taskId: 'bash-running0',
        status: 'lost',
      }),
    });
    // The ghost set should be bounded to 100 after reconcile.
    expect(manager.list(false)).toHaveLength(100);
  });

  it('trims oldest terminal ghosts by startedAt, keeping recent tasks', async () => {
    // With 105 terminal tasks, the 5 oldest (by startedAt) should be
    // dropped and the 100 newest retained.
    for (let i = 0; i < 105; i++) {
      await persistence.writeTask(
        persistedProcess({
          taskId: `bash-task${String(i).padStart(4, '0')}`,
          command: 'echo',
          description: 'old',
          pid: i,
          startedAt: 1_700_000_000 + i,
          endedAt: 1_700_000_010 + i,
          exitCode: 0,
          status: 'completed',
        }),
      );
    }
    const { manager } = createBackgroundManager({ sessionDir });

    await manager.loadFromDisk();
    await manager.reconcile();

    const tasks = manager.list(false);
    expect(tasks).toHaveLength(100);
    // The 5 oldest (i=0..4) should be gone; the newest 100 retained.
    expect(manager.getTask('bash-task0000')).toBeUndefined();
    expect(manager.getTask('bash-task0004')).toBeUndefined();
    expect(manager.getTask('bash-task0005')).toBeDefined();
    expect(manager.getTask('bash-task0104')).toBeDefined();
  });
});

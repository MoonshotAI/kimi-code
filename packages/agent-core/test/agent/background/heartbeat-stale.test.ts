/**
 * Reconcile marks running persisted tasks from a prior process as lost.
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

function runningGhost(taskId: string): Extract<BackgroundTaskInfo, { kind: 'process' }> {
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
  persistence = new BackgroundTaskPersistence(sessionDir);
});

afterEach(async () => {
  await rm(sessionDir, { recursive: true, force: true });
});

describe('Background reconcile — stale ghost detection', () => {
  it('emits a terminated event with status=lost for a running ghost', async () => {
    await persistence.writeTask(runningGhost('bash-stale000'));
    const { agent, manager } = createBackgroundManager({ sessionDir });

    await manager.loadFromDisk();
    await manager.reconcile();

    expect(agent.emittedEvents).toContainEqual({
      type: 'background.task.terminated',
      info: expect.objectContaining({
        taskId: 'bash-stale000',
        status: 'lost',
      }),
    });
  });

  it('second reconcile does not emit a duplicate termination event', async () => {
    await persistence.writeTask(runningGhost('bash-dedup000'));
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
});

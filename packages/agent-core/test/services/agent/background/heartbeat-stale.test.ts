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
  type IBackgroundService,
} from '../../../../src/services/agent/background/background';
import { testAgent, type TestAgentContext } from '../harness';

let sessionDir: string;
let persistence: BackgroundTaskPersistence;

type BackgroundServiceTestManager = IBackgroundService & {
  loadFromDisk(): Promise<void>;
  reconcile(): Promise<readonly BackgroundTaskInfo[]>;
};

function testAgentWithBackground(): {
  ctx: TestAgentContext;
  background: BackgroundServiceTestManager;
} {
  const ctx = testAgent({ background: { persistence: new BackgroundTaskPersistence(sessionDir) } });
  return {
    ctx,
    background: ctx.background as BackgroundServiceTestManager,
  };
}

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

    const { ctx, background } = testAgentWithBackground();

    const emittedEvents: any[] = [];
    ctx.events.on((event) => {
      emittedEvents.push(event);
    });

    await background.loadFromDisk();
    await background.reconcile();

    expect(emittedEvents).toContainEqual({
      type: 'background.task.terminated',
      info: expect.objectContaining({
        taskId: 'bash-stale000',
        status: 'lost',
      }),
    });
  });

  it('second reconcile does not emit a duplicate termination event', async () => {
    await persistence.writeTask(runningGhost('bash-dedup000'));

    const { ctx, background } = testAgentWithBackground();

    const emittedEvents: any[] = [];
    ctx.events.on((event) => {
      emittedEvents.push(event);
    });

    await background.loadFromDisk();
    await background.reconcile();
    await background.reconcile();

    expect(
      emittedEvents.filter(
        (event) => event.type === 'background.task.terminated',
      ),
    ).toHaveLength(1);
  });
});

import { mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'pathe';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { AgentTask } from '#/actor/task/taskAgentRuntime';
import type { AgentTaskInfo, NohupTaskRecovery } from '#/actor/task/types';
import type { ProcessTaskInfo } from '#/agent/tools/os/bash/process-task';
import {
  killProcessGroup,
  NohupTask,
  spawnNohupProcess,
} from '#/agent/tools/os/bash/nohup-task';
import { IEventBus } from '#/app/event/eventBus';
import type { WireRecord } from '#/wire/record';
import {
  taskServices,
  createTestAgent,
  homeDirServices,
  wireRecordPersistenceServices,
  withMetadata,
  InMemoryWireRecordPersistence,
  type TestAgentContext,
} from '../../harness';
import {
  createAgentTaskPersistence,
  writeLegacyTaskFile,
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
      background = ctx.resolve(AgentTask) as TaskServiceTestManager;
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

    it('reconciles a previously-running task as lost', async () => {
      await writeLegacyTaskFile(sessionDir, persistedProcess());

      await background.loadFromDisk();
      await background.reconcile();

      expect(background.getTask('bash-orphan00')).toMatchObject({
        taskId: 'bash-orphan00',
        status: 'lost',
      });
      expect(emittedEvents).toContainEqual(
        expect.objectContaining({
          type: 'task.terminated',
          info: expect.objectContaining({
            taskId: 'bash-orphan00',
            status: 'lost',
          }),
        }),
      );
    });

    it('runtime restore reconciles persisted tasks through the task resume hook', async () => {
      await writeLegacyTaskFile(sessionDir, 
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
      expect(emittedEvents).toContainEqual(
        expect.objectContaining({
          type: 'task.terminated',
          info: expect.objectContaining({
            taskId: 'bash-restore0',
            status: 'lost',
          }),
        }),
      );
    });

    it('does not reclassify already-terminal tasks', async () => {
      await writeLegacyTaskFile(sessionDir, 
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
      await writeLegacyTaskFile(sessionDir, 
        persistedProcess({
          taskId: 'bash-running0',
          command: 'sleep 1000',
          description: 'sleep',
          pid: 77777,
        }),
      );

      await background.loadFromDisk();
      await background.reconcile();

      expect(background.getTask('bash-done0000')).toMatchObject({ status: 'completed' });
      expect(background.getTask('bash-running0')).toMatchObject({ status: 'lost' });
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
      await writeLegacyTaskFile(sessionDir, 
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
      await writeLegacyTaskFile(sessionDir, 
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

    it('does not emit duplicate termination events on a second reconcile pass', async () => {
      await writeLegacyTaskFile(sessionDir, 
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
      await writeLegacyTaskFile(sessionDir, 
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

describe('AgentTaskService — nohup revive', () => {
  const spawnedPgids: number[] = [];
  const contexts: TestAgentContext[] = [];

  afterEach(async () => {
    for (const ctx of contexts.splice(0)) await ctx.dispose();
    for (const pgid of spawnedPgids.splice(0)) killProcessGroup(pgid, 'SIGKILL');
  });

  function track(ctx: TestAgentContext): TestAgentContext {
    contexts.push(ctx);
    return ctx;
  }

  async function spawnSleeper(seconds: number, outputName: string) {
    const spawned = await spawnNohupProcess({
      shellPath: '/bin/bash',
      command: `sleep ${String(seconds)}`,
      env: { NO_COLOR: '1', TERM: 'dumb', SHELL: '/bin/bash' },
      outputPath: join(sessionDir, outputName),
    });
    spawnedPgids.push(spawned.pgid);
    return spawned;
  }

  function recoveryOf(
    spawned: { readonly pid: number; readonly pgid: number; readonly startEvidence: string },
    outputPath: string,
  ): NohupTaskRecovery {
    return {
      pid: spawned.pid,
      pgid: spawned.pgid,
      startedAt: Date.now(),
      outputPath,
      startEvidence: spawned.startEvidence,
    };
  }

  function ghostRecord(info: ProcessTaskInfo): WireRecord {
    return { type: 'task.started', agentId: 'main', info, time: 1 } as unknown as WireRecord;
  }

  function ghostInfo(
    taskId: string,
    recovery: NohupTaskRecovery,
    overrides: Partial<ProcessTaskInfo> = {},
  ): ProcessTaskInfo {
    return {
      taskId,
      kind: 'process',
      command: 'sleep 30',
      description: 'nohup ghost',
      pid: recovery.pid,
      exitCode: null,
      status: 'running',
      detached: true,
      startedAt: Date.now(),
      endedAt: null,
      nohup: recovery,
      ...overrides,
    };
  }

  function restoreCtx(records: readonly WireRecord[]): TestAgentContext {
    return track(
      createTestAgent(
        homeDirServices(sessionDir),
        taskServices(),
        wireRecordPersistenceServices(
          new InMemoryWireRecordPersistence(withMetadata(records)),
        ),
      ),
    );
  }

  it('stopAllOnExit leaves a nohup task running and restore reattaches it', async () => {
    const spawned = await spawnSleeper(30, 'nohup-live.log');
    const writer = track(createTestAgent(homeDirServices(sessionDir), taskServices()));
    const recovery = recoveryOf(spawned, join(sessionDir, 'nohup-live.log'));
    const taskId = writer
      .resolve(AgentTask)
      .registerTask(new NohupTask(spawned.child, 'sleep 30', 'nohup live', recovery));

    const stopped = await writer.resolve(AgentTask).stopAllOnExit('Session closed');
    expect(stopped.map((info) => info.taskId)).toEqual([taskId]);
    expect(writer.resolve(AgentTask).getTask(taskId)).toMatchObject({
      status: 'running',
      terminalNotificationSuppressed: undefined,
    });
    expect(() => process.kill(spawned.pid, 0)).not.toThrow();

    const reader = restoreCtx(await writer.persistedWireRecords());
    await reader.restorePersisted();
    expect(reader.resolve(AgentTask).getTask(taskId)?.status).toBe('running');

    await reader.resolve(AgentTask).stop(taskId, 'reattached cleanup');
    await vi.waitFor(
      () => {
        expect(() => process.kill(spawned.pid, 0)).toThrow();
      },
      { timeout: 10_000 },
    );
    expect(reader.resolve(AgentTask).getTask(taskId)?.status).toBe('killed');
  });

  it('leaves a reattached nohup task running across a second close and reattaches again on the next restore', async () => {
    const spawned = await spawnSleeper(30, 'nohup-reattach.log');
    const recovery = recoveryOf(spawned, join(sessionDir, 'nohup-reattach.log'));
    const info = ghostInfo('bash-nohup008', recovery);
    const first = restoreCtx([ghostRecord(info)]);
    await first.restorePersisted();
    expect(first.resolve(AgentTask).getTask(info.taskId)?.status).toBe('running');

    const stopped = await first.resolve(AgentTask).stopAllOnExit('Session closed');
    expect(stopped.map((entry) => entry.taskId)).toEqual([info.taskId]);
    expect(first.resolve(AgentTask).getTask(info.taskId)?.status).toBe('running');
    expect(() => process.kill(spawned.pid, 0)).not.toThrow();
    expect(
      (await first.persistedWireRecords()).filter((record) => record.type === 'task.terminated'),
    ).toEqual([]);

    const second = restoreCtx(await first.persistedWireRecords());
    await second.restorePersisted();
    expect(second.resolve(AgentTask).getTask(info.taskId)?.status).toBe('running');

    await second.resolve(AgentTask).stop(info.taskId, 'second close cleanup');
    await vi.waitFor(
      () => {
        expect(() => process.kill(spawned.pid, 0)).toThrow();
      },
      { timeout: 10_000 },
    );
  });

  it('settles a reattached nohup task as completed with a null exit code when the process exits unobserved', async () => {
    const spawned = await spawnSleeper(1, 'nohup-short.log');
    const recovery = recoveryOf(spawned, join(sessionDir, 'nohup-short.log'));
    const info = ghostInfo('bash-nohup002', recovery);
    const reader = restoreCtx([ghostRecord(info)]);
    await reader.restorePersisted();
    expect(reader.resolve(AgentTask).getTask(info.taskId)?.status).toBe('running');

    await vi.waitFor(
      () => {
        const current = reader.resolve(AgentTask).getTask(info.taskId);
        expect(current?.status).toBe('completed');
        expect(current?.kind === 'process' ? current.exitCode : undefined).toBeNull();
      },
      { timeout: 15_000 },
    );
  });

  it('marks a nohup ghost lost when the pid is dead', async () => {
    const spawned = await spawnSleeper(1, 'nohup-dead.log');
    await vi.waitFor(
      () => {
        expect(() => process.kill(spawned.pid, 0)).toThrow();
      },
      { timeout: 15_000 },
    );

    const recovery = recoveryOf(spawned, join(sessionDir, 'nohup-dead.log'));
    const info = ghostInfo('bash-nohup003', recovery);
    const reader = restoreCtx([ghostRecord(info)]);
    await reader.restorePersisted();

    expect(reader.resolve(AgentTask).getTask(info.taskId)?.status).toBe('lost');
  });

  it('marks a nohup ghost lost without touching the pid when the start evidence does not match', async () => {
    const spawned = await spawnSleeper(30, 'nohup-evidence.log');
    const recovery: NohupTaskRecovery = {
      ...recoveryOf(spawned, join(sessionDir, 'nohup-evidence.log')),
      startEvidence: 'bogus evidence',
    };
    const info = ghostInfo('bash-nohup004', recovery);
    const reader = restoreCtx([ghostRecord(info)]);
    await reader.restorePersisted();

    expect(reader.resolve(AgentTask).getTask(info.taskId)?.status).toBe('lost');
    expect(() => process.kill(spawned.pid, 0)).not.toThrow();
  });

  it('marks a nohup ghost lost without touching the pid when the process group does not match', async () => {
    const spawned = await spawnSleeper(30, 'nohup-pgid.log');
    const recovery: NohupTaskRecovery = {
      ...recoveryOf(spawned, join(sessionDir, 'nohup-pgid.log')),
      pgid: spawned.pgid + 1,
    };
    const info = ghostInfo('bash-nohup005', recovery);
    const reader = restoreCtx([ghostRecord(info)]);
    await reader.restorePersisted();

    expect(reader.resolve(AgentTask).getTask(info.taskId)?.status).toBe('lost');
    expect(() => process.kill(spawned.pid, 0)).not.toThrow();
  });

  it('reattaches a nohup ghost even when the output file is missing', async () => {
    const spawned = await spawnSleeper(30, 'nohup-output.log');
    const recovery = recoveryOf(spawned, join(sessionDir, 'missing-output.log'));
    const info = ghostInfo('bash-nohup006', recovery);
    const reader = restoreCtx([ghostRecord(info)]);
    await reader.restorePersisted();

    expect(reader.resolve(AgentTask).getTask(info.taskId)?.status).toBe('running');
  });

  it('re-arms the remaining timeout budget on reattach', async () => {
    const spawned = await spawnSleeper(30, 'nohup-timeout.log');
    const recovery = recoveryOf(spawned, join(sessionDir, 'nohup-timeout.log'));
    const info = ghostInfo('bash-nohup007', recovery, {
      timeoutMs: 1_500,
      startedAt: Date.now() - 1_000,
    });
    const reader = restoreCtx([ghostRecord(info)]);
    await reader.restorePersisted();

    await vi.waitFor(
      () => {
        expect(reader.resolve(AgentTask).getTask(info.taskId)?.status).toBe('timed_out');
      },
      { timeout: 15_000 },
    );
    await vi.waitFor(
      () => {
        expect(() => process.kill(spawned.pid, 0)).toThrow();
      },
      { timeout: 15_000 },
    );
  });
});

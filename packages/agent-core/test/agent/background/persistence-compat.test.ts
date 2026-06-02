import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'pathe';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { BackgroundManager, BackgroundTaskPersistence } from '../../../src/agent/background';

let sessionDir: string;

beforeEach(async () => {
  sessionDir = join(
    tmpdir(),
    `kimi-bg-persist-compat-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  );
  await mkdir(join(sessionDir, 'tasks'), { recursive: true });
});

afterEach(async () => {
  await rm(sessionDir, { recursive: true, force: true });
});

async function writeLegacyTask(taskId: string, task: Record<string, unknown>): Promise<void> {
  await writeFile(join(sessionDir, 'tasks', `${taskId}.json`), JSON.stringify(task), 'utf-8');
}

describe('BackgroundTaskPersistence legacy compatibility', () => {
  it('normalizes legacy snake_case process task records', async () => {
    await writeLegacyTask('bash-legacy01', {
      task_id: 'bash-legacy01',
      command: 'sleep 60',
      description: 'legacy shell task',
      pid: 12345,
      started_at: 1_700_000_000,
      ended_at: null,
      exit_code: null,
      status: 'running',
    });

    const persistence = new BackgroundTaskPersistence(sessionDir);

    expect(await persistence.readTask('bash-legacy01')).toMatchObject({
      taskId: 'bash-legacy01',
      kind: 'process',
      command: 'sleep 60',
      description: 'legacy shell task',
      pid: 12345,
      startedAt: 1_700_000_000,
      endedAt: null,
      exitCode: null,
      status: 'running',
    });
  });

  it('normalizes legacy timed-out agent records', async () => {
    await writeLegacyTask('agent-timeout1', {
      task_id: 'agent-timeout1',
      command: '[agent] slow task',
      description: 'slow legacy agent',
      pid: 0,
      started_at: 1_700_000_000,
      ended_at: 1_700_000_100,
      exit_code: 1,
      status: 'failed',
      timed_out: true,
      stop_reason: 'deadline',
      agent_id: 'agent-session-id',
      subagent_type: 'reviewer',
    });

    const persistence = new BackgroundTaskPersistence(sessionDir);
    const tasks = await persistence.listTasks();

    expect(tasks).toHaveLength(1);
    expect(tasks[0]).toMatchObject({
      taskId: 'agent-timeout1',
      kind: 'agent',
      description: 'slow legacy agent',
      startedAt: 1_700_000_000,
      endedAt: 1_700_000_100,
      status: 'timed_out',
      stopReason: 'deadline',
      agentId: 'agent-session-id',
      subagentType: 'reviewer',
    });
  });

  it('migrates legacy records through load/reconcile writeback', async () => {
    await writeLegacyTask('bash-orphan01', {
      task_id: 'bash-orphan01',
      command: 'sleep 60',
      description: 'legacy orphan',
      pid: 12345,
      started_at: 1_700_000_000,
      ended_at: null,
      exit_code: null,
      status: 'running',
    });

    const persistence = new BackgroundTaskPersistence(sessionDir);
    const agent = {
      emitEvent: vi.fn(),
      telemetry: { track: vi.fn() },
      context: { appendUserMessage: vi.fn() },
      turn: { steer: vi.fn() },
      hooks: undefined,
    };
    const manager = new BackgroundManager(agent as never, persistence);

    await manager.loadFromDisk();
    await manager.reconcile();

    expect(manager.getTask('bash-orphan01')).toMatchObject({
      taskId: 'bash-orphan01',
      kind: 'process',
      status: 'lost',
    });
    const raw = JSON.parse(
      await readFile(join(sessionDir, 'tasks', 'bash-orphan01.json'), 'utf-8'),
    ) as Record<string, unknown>;
    expect(raw['taskId']).toBe('bash-orphan01');
    expect(raw['task_id']).toBeUndefined();
    expect(raw['kind']).toBe('process');
    expect(raw['status']).toBe('lost');
  });
});

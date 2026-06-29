/**
 * Background task persistence tests.
 */

import { mkdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'pathe';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  BackgroundTaskPersistence,
  type BackgroundTaskInfo,
} from '../../../src/agent/background';

let sessionDir: string;
let persistence: BackgroundTaskPersistence;

function sample(overrides: Partial<Extract<BackgroundTaskInfo, { kind: 'process' }>> = {}): Extract<BackgroundTaskInfo, { kind: 'process' }> {
  return {
    taskId: 'bash-11111111',
    kind: 'process',
    command: 'npm install',
    description: 'install deps',
    pid: 12345,
    startedAt: 1_700_000_000,
    endedAt: null,
    exitCode: null,
    status: 'running',
    detached: true,
    ...overrides,
  };
}

beforeEach(async () => {
  sessionDir = join(
    tmpdir(),
    `kimi-bg-persist-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  );
  await mkdir(sessionDir, { recursive: true });
  persistence = new BackgroundTaskPersistence(sessionDir);
});

afterEach(async () => {
  await rm(sessionDir, { recursive: true, force: true });
});

describe('BackgroundTaskPersistence', () => {
  it('round-trips a task via write/read', async () => {
    await persistence.writeTask(sample());
    const loaded = await persistence.readTask('bash-11111111');
    expect(loaded).toEqual(sample());
  });

  it('returns undefined when task file is missing', async () => {
    expect(await persistence.readTask('bash-missing0')).toBeUndefined();
  });

  it('overwrites on subsequent write', async () => {
    await persistence.writeTask(sample({ status: 'running' }));
    await persistence.writeTask(
      sample({ status: 'completed', exitCode: 0, endedAt: 1_700_000_100 }),
    );
    const task = await persistence.readTask('bash-11111111');
    expect(task).toMatchObject({
      status: 'completed',
      kind: 'process',
      exitCode: 0,
      endedAt: 1_700_000_100,
    });
  });

  it('listTasks enumerates all persisted entries', async () => {
    await persistence.writeTask(sample({ taskId: 'bash-11111111' }));
    await persistence.writeTask(sample({ taskId: 'bash-22222222', command: 'pnpm test' }));
    const all = await persistence.listTasks();
    expect(all).toHaveLength(2);
    expect(all.map((task) => task.taskId).toSorted()).toEqual([
      'bash-11111111',
      'bash-22222222',
    ]);
  });

  it('listTasks returns empty when tasks dir does not exist', async () => {
    expect(await persistence.listTasks()).toEqual([]);
  });

  it('listTasks skips corrupt files', async () => {
    await persistence.writeTask(sample());
    await writeFile(join(sessionDir, 'tasks', 'bash-baaaaaaa.json'), '{not json', 'utf-8');
    const all = await persistence.listTasks();
    expect(all.map((task) => task.taskId)).toEqual(['bash-11111111']);
  });

  it.skipIf(process.platform === 'win32')('writeTask creates tasks dir with mode 0700', async () => {
    await persistence.writeTask(sample());
    const st = await stat(join(sessionDir, 'tasks'));
    // eslint-disable-next-line no-bitwise
    expect(st.mode & 0o777).toBe(0o700);
  });

  it('rejects path-traversal task ids', async () => {
    await expect(
      persistence.writeTask(sample({ taskId: '../../etc/passwd' })),
    ).rejects.toThrow(/Invalid task id/);
    await expect(persistence.readTask('../etc/passwd')).rejects.toThrow(/Invalid task id/);
    expect(() => persistence.taskOutputFile('../etc/passwd')).toThrow(/Invalid task id/);
  });

  it('listTasks silently skips non-validating task id files', async () => {
    await persistence.writeTask(sample());
    await writeFile(
      join(sessionDir, 'tasks', 'BAD-ID!!!.json'),
      JSON.stringify(sample({ taskId: 'BAD-ID!!!' })),
      'utf-8',
    );
    const all = await persistence.listTasks();
    expect(all.map((task) => task.taskId)).toEqual(['bash-11111111']);
  });

  it('listTasks skips unrecognized records', async () => {
    await persistence.writeTask(sample());
    await writeFile(
      join(sessionDir, 'tasks', 'bash-cccccccc.json'),
      JSON.stringify({ oops: 1 }),
      'utf-8',
    );
    const all = await persistence.listTasks();
    expect(all.map((task) => task.taskId)).toEqual(['bash-11111111']);
  });

  it('readTask for an unknown task does not create a directory', async () => {
    const { readdir } = await import('node:fs/promises');
    expect(await persistence.readTask('bash-noexis00')).toBeUndefined();
    const top = await readdir(sessionDir);
    expect(top.includes('tasks')).toBe(false);
  });

  describe('readTaskOutputBytes / taskOutputSizeBytes', () => {
    it('taskOutputSizeBytes reports the full byte size of output.log', async () => {
      await persistence.appendTaskOutput('bash-size0000', 'abcdefghij');
      expect(await persistence.taskOutputSizeBytes('bash-size0000')).toBe(10);
    });

    it('taskOutputSizeBytes returns 0 when output.log is absent', async () => {
      expect(await persistence.taskOutputSizeBytes('bash-none0000')).toBe(0);
    });

    it('readTaskOutputBytes returns the exact byte window for offset + maxBytes', async () => {
      await persistence.appendTaskOutput('bash-page0000', 'abcdefghijklmnopqrstuvwxyz');

      expect(await persistence.readTaskOutputBytes('bash-page0000', 5, 10)).toBe('fghijklmno');
      expect(await persistence.readTaskOutputBytes('bash-page0000', 0, 3)).toBe('abc');
      expect(await persistence.readTaskOutputBytes('bash-page0000', 20, 100)).toBe('uvwxyz');
      expect(await persistence.readTaskOutputBytes('bash-page0000', 26, 10)).toBe('');
    });

    it('readTaskOutputBytes returns empty string when output.log is absent', async () => {
      expect(await persistence.readTaskOutputBytes('bash-none0001', 0, 100)).toBe('');
    });
  });
});

/**
 * Background task persistence tests.
 */

import { mkdir, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'pathe';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  appendTaskOutput,
  listTasks,
  readTask,
  readTaskOutputBytes,
  removeTask,
  taskOutputSizeBytes,
  writeTask,
  type PersistedTask,
} from '../../../src/tools/background/persist';

let sessionDir: string;

function sample(overrides: Partial<PersistedTask> = {}): PersistedTask {
  return {
    task_id: 'bash-11111111',
    command: 'npm install',
    description: 'install deps',
    pid: 12345,
    started_at: 1_700_000_000,
    ended_at: null,
    exit_code: null,
    status: 'running',
    ...overrides,
  };
}

beforeEach(async () => {
  sessionDir = join(
    tmpdir(),
    `kimi-bg-persist-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  );
  await mkdir(sessionDir, { recursive: true });
});

afterEach(async () => {
  await rm(sessionDir, { recursive: true, force: true });
});

describe('background/persist', () => {
  it('round-trips a task via write/read', async () => {
    await writeTask(sessionDir, sample());
    const loaded = await readTask(sessionDir, 'bash-11111111');
    expect(loaded).toEqual(sample());
  });

  it('returns undefined when task file is missing', async () => {
    expect(await readTask(sessionDir, 'bash-missing0')).toBeUndefined();
  });

  it('overwrites on subsequent write', async () => {
    await writeTask(sessionDir, sample({ status: 'running' }));
    await writeTask(
      sessionDir,
      sample({ status: 'completed', exit_code: 0, ended_at: 1_700_000_100 }),
    );
    const t = await readTask(sessionDir, 'bash-11111111');
    expect(t?.status).toBe('completed');
    expect(t?.exit_code).toBe(0);
    expect(t?.ended_at).toBe(1_700_000_100);
  });

  it('listTasks enumerates all persisted entries', async () => {
    await writeTask(sessionDir, sample({ task_id: 'bash-11111111' }));
    await writeTask(sessionDir, sample({ task_id: 'bash-22222222', command: 'pnpm test' }));
    const all = await listTasks(sessionDir);
    expect(all).toHaveLength(2);
    expect(all.map((t) => t.task_id).toSorted()).toEqual(['bash-11111111', 'bash-22222222']);
  });

  it('listTasks returns empty when tasks dir does not exist', async () => {
    expect(await listTasks(sessionDir)).toEqual([]);
  });

  it('listTasks skips corrupt files', async () => {
    await writeTask(sessionDir, sample());
    // Corrupt a sibling file
    const { writeFile } = await import('node:fs/promises');
    // Needs a *valid-format* id for listTasks to even attempt parsing
    // (invalid-id files are silently skipped).
    await writeFile(join(sessionDir, 'tasks', 'bash-baaaaaaa.json'), '{not json', 'utf-8');
    const all = await listTasks(sessionDir);
    expect(all).toHaveLength(1);
    expect(all[0]?.task_id).toBe('bash-11111111');
  });

  it('removeTask deletes file (idempotent)', async () => {
    await writeTask(sessionDir, sample());
    await removeTask(sessionDir, 'bash-11111111');
    expect(await readTask(sessionDir, 'bash-11111111')).toBeUndefined();
    // Second remove no-op
    await expect(removeTask(sessionDir, 'bash-11111111')).resolves.toBeUndefined();
  });

  it('writeTask creates tasks dir with mode 0700', async () => {
    await writeTask(sessionDir, sample());
    const st = await stat(join(sessionDir, 'tasks'));
    // eslint-disable-next-line no-bitwise
    expect(st.mode & 0o777).toBe(0o700);
  });

  it('rejects path-traversal task ids', async () => {
    await expect(writeTask(sessionDir, sample({ task_id: '../../etc/passwd' }))).rejects.toThrow(
      /Invalid task id/,
    );
    await expect(readTask(sessionDir, '../etc/passwd')).rejects.toThrow(/Invalid task id/);
    await expect(removeTask(sessionDir, '../etc/passwd')).rejects.toThrow(/Invalid task id/);
  });

  it('listTasks silently skips non-validating task_id files', async () => {
    // Seed a valid task alongside a sibling file whose basename does
    // NOT match `^(bash|agent)-[0-9a-z]{8}$`.
    await writeTask(sessionDir, sample());
    const { writeFile } = await import('node:fs/promises');
    await writeFile(
      join(sessionDir, 'tasks', 'BAD-ID!!!.json'),
      JSON.stringify(sample({ task_id: 'BAD-ID!!!' })),
      'utf-8',
    );
    const all = await listTasks(sessionDir);
    expect(all).toHaveLength(1);
    expect(all[0]?.task_id).toBe('bash-11111111');
  });

  it('listTasks skips specs missing required fields', async () => {
    await writeTask(sessionDir, sample());
    const { writeFile } = await import('node:fs/promises');
    // Valid JSON, valid filename, but shape is wrong (missing status / pid).
    await writeFile(
      join(sessionDir, 'tasks', 'bash-cccccccc.json'),
      JSON.stringify({ task_id: 'bash-cccccccc', command: 'x' }),
      'utf-8',
    );
    const all = await listTasks(sessionDir);
    expect(all).toHaveLength(1);
    expect(all[0]?.task_id).toBe('bash-11111111');
  });

  // ── shell_info round-trip ─────────────────────────────────────────

  it('shell_info round-trips through write/read', async () => {
    const task = sample({
      task_id: 'bash-abc12345',
      shell_info: {
        name: 'bash',
        path: '/bin/bash',
        cwd: '/tmp/work',
      },
    });
    await writeTask(sessionDir, task);
    const loaded = await readTask(sessionDir, 'bash-abc12345');
    expect(loaded?.shell_info).toEqual({
      name: 'bash',
      path: '/bin/bash',
      cwd: '/tmp/work',
    });
  });

  it('stop_reason round-trips through write/read', async () => {
    await writeTask(
      sessionDir,
      sample({
        task_id: 'bash-stop0000',
        status: 'killed',
        stop_reason: 'no longer needed',
      }),
    );
    const loaded = await readTask(sessionDir, 'bash-stop0000');
    expect(loaded?.stop_reason).toBe('no longer needed');
  });

  // All read paths for an unknown task must return defaults AND must
  // NOT create the on-disk task directory as a side effect.
  it('readTask for an unknown task does not create a directory', async () => {
    const { readdir } = await import('node:fs/promises');
    expect(await readTask(sessionDir, 'bash-noexis00')).toBeUndefined();
    const top = await readdir(sessionDir);
    expect(top.includes('tasks')).toBe(false);
  });

  // listTasks must filter directories whose name does not match the
  // valid task-id format — stray subdirectories must not appear.
  it('listTasks skips invalid task directories', async () => {
    await writeTask(sessionDir, sample({ task_id: 'bash-88888888' }));
    const { mkdir } = await import('node:fs/promises');
    await mkdir(join(sessionDir, 'tasks', 'b-invalid'), { recursive: true });
    const all = await listTasks(sessionDir);
    expect(all.map((t) => t.task_id)).toEqual(['bash-88888888']);
  });

  // Even if a stray directory has a spec.json file inside, list_views
  // still skips it when the directory name fails task-id validation.
  it('listTasks skips a directory whose name fails validation even when it contains a spec file', async () => {
    await writeTask(sessionDir, sample({ task_id: 'bash-77777777' }));
    const { mkdir, writeFile } = await import('node:fs/promises');
    await mkdir(join(sessionDir, 'tasks', 'bad-task!'), { recursive: true });
    await writeFile(
      join(sessionDir, 'tasks', 'bad-task!', 'spec.json'),
      JSON.stringify({}),
      'utf-8',
    );
    const all = await listTasks(sessionDir);
    expect(all.map((t) => t.task_id)).toEqual(['bash-77777777']);
  });

  // Corrupt runtime.json content (truncated JSON missing closing brace)
  // must NOT raise — readTask returns undefined and listTasks silently
  // skips that entry. Py treats this as "fall back to default runtime".
  it('readTask on truncated JSON returns undefined (does not throw)', async () => {
    const { writeFile, mkdir } = await import('node:fs/promises');
    await mkdir(join(sessionDir, 'tasks'), { recursive: true });
    await writeFile(
      join(sessionDir, 'tasks', 'bash-99999998.json'),
      '{"status":"running"',
      'utf-8',
    );
    const loaded = await readTask(sessionDir, 'bash-99999998');
    expect(loaded).toBeUndefined();
  });

  // listTasks skips a task whose spec is unparseable / missing required
  // fields, while still returning sibling valid tasks.
  it('listTasks skips a task with a corrupted spec while keeping siblings', async () => {
    await writeTask(sessionDir, sample({ task_id: 'bash-99999996' }));
    const { writeFile, mkdir } = await import('node:fs/promises');
    await mkdir(join(sessionDir, 'tasks'), { recursive: true });
    await writeFile(
      join(sessionDir, 'tasks', 'bash-99999997.json'),
      JSON.stringify({ oops: 1 }),
      'utf-8',
    );
    const all = await listTasks(sessionDir);
    expect(all.map((t) => t.task_id)).toEqual(['bash-99999996']);
  });

  // ── byte-paged output read ────────────────────────────────────────

  describe('readTaskOutputBytes / taskOutputSizeBytes', () => {
    it('taskOutputSizeBytes reports the full byte size of output.log', async () => {
      await appendTaskOutput(sessionDir, 'bash-size0000', 'abcdefghij'); // 10 bytes
      expect(await taskOutputSizeBytes(sessionDir, 'bash-size0000')).toBe(10);
    });

    it('taskOutputSizeBytes returns 0 when output.log is absent', async () => {
      expect(await taskOutputSizeBytes(sessionDir, 'bash-none0000')).toBe(0);
    });

    it('readTaskOutputBytes returns the exact byte window for offset + maxBytes', async () => {
      // 26 single-byte ASCII chars.
      await appendTaskOutput(sessionDir, 'bash-page0000', 'abcdefghijklmnopqrstuvwxyz');

      // A middle window.
      expect(await readTaskOutputBytes(sessionDir, 'bash-page0000', 5, 10)).toBe('fghijklmno');
      // From the start.
      expect(await readTaskOutputBytes(sessionDir, 'bash-page0000', 0, 3)).toBe('abc');
      // A window that runs past EOF is clamped to whatever remains.
      expect(await readTaskOutputBytes(sessionDir, 'bash-page0000', 20, 100)).toBe('uvwxyz');
      // An offset at/after EOF yields an empty string.
      expect(await readTaskOutputBytes(sessionDir, 'bash-page0000', 26, 10)).toBe('');
    });

    it('readTaskOutputBytes returns empty string when output.log is absent', async () => {
      expect(await readTaskOutputBytes(sessionDir, 'bash-none0001', 0, 100)).toBe('');
    });
  });
});

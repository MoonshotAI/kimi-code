/**
 * Scenario: Agent task document/output persistence and legacy-root compatibility.
 *
 * Constructs the plain `AgentTaskPersistence` helper over real node-fs storage
 * resolved by interface, covering primary writes, local-first reads, the
 * previous v2 session-root fallback, and exact output paths. Run with
 * `pnpm --filter @moonshot-ai/agent-core-v2 exec vitest run test/agent/task/persist.test.ts`.
 */

import { mkdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'pathe';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { SyncDescriptor } from '#/_base/di/descriptors';
import { DisposableStore } from '#/_base/di/lifecycle';
import { TestInstantiationService } from '#/_base/di/test';
import {
  AgentTaskPersistence,
  type AgentTaskInfo,
} from '#/agent/task/task';
import { JsonAtomicDocumentStore } from '#/persistence/backends/node-fs/atomicDocumentStore';
import { FileStorageService } from '#/persistence/backends/node-fs/fileStorageService';
import { IAtomicDocumentStore } from '#/persistence/interface/atomicDocumentStore';
import { IFileSystemStorageService } from '#/persistence/interface/storage';

const SESSION_SCOPE = 'session';
const AGENT_SCOPE = `${SESSION_SCOPE}/agents/main`;

let disposables: DisposableStore;
let sessionDir: string;
let docs: IAtomicDocumentStore;
let bytes: IFileSystemStorageService;
let persistence: AgentTaskPersistence;

function sample(overrides: Partial<Extract<AgentTaskInfo, { kind: 'process' }>> = {}): Extract<AgentTaskInfo, { kind: 'process' }> {
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

  // `AgentTaskPersistence` is a plain (non-DI) helper constructed by
  // `AgentTaskService`, so the test builds it directly. Its `docs`
  // collaborator (`IAtomicDocumentStore`) carries an `@IService` dependency, so
  // it is resolved by interface through the container rather than `new`ed.
  disposables = new DisposableStore();
  const ix = disposables.add(new TestInstantiationService());
  const fs = new FileStorageService(sessionDir, 0o700);
  ix.set(IFileSystemStorageService, fs);
  ix.set(IAtomicDocumentStore, new SyncDescriptor(JsonAtomicDocumentStore));
  docs = ix.get(IAtomicDocumentStore);
  bytes = ix.get(IFileSystemStorageService);
  persistence = new AgentTaskPersistence(sessionDir, SESSION_SCOPE, docs, bytes);
});

afterEach(async () => {
  disposables.dispose();
  await rm(sessionDir, { recursive: true, force: true });
});

describe('AgentTaskPersistence', () => {
  function rootedPersistence(
    scope: string,
    fallbackRoot?: { readonly dir: string; readonly scope: string },
  ): AgentTaskPersistence {
    return new AgentTaskPersistence(join(sessionDir, scope), scope, docs, bytes, fallbackRoot);
  }

  function sessionRoot(): { readonly dir: string; readonly scope: string } {
    return { dir: join(sessionDir, SESSION_SCOPE), scope: SESSION_SCOPE };
  }

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
    await writeFile(join(sessionDir, SESSION_SCOPE, 'tasks', 'bash-baaaaaaa.json'), '{not json', 'utf-8');
    const all = await persistence.listTasks();
    expect(all.map((task) => task.taskId)).toEqual(['bash-11111111']);
  });

  it('writeTask creates tasks dir with mode 0700', async () => {
    await persistence.writeTask(sample());
    const st = await stat(join(sessionDir, SESSION_SCOPE, 'tasks'));
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
      join(sessionDir, SESSION_SCOPE, 'tasks', 'BAD-ID!!!.json'),
      JSON.stringify(sample({ taskId: 'BAD-ID!!!' })),
      'utf-8',
    );
    const all = await persistence.listTasks();
    expect(all.map((task) => task.taskId)).toEqual(['bash-11111111']);
  });

  it('listTasks skips unrecognized records', async () => {
    await persistence.writeTask(sample());
    await writeFile(
      join(sessionDir, SESSION_SCOPE, 'tasks', 'bash-cccccccc.json'),
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

  describe('legacy session-root fallback', () => {
    it('reads a legacy task and reports its real output path when the agent root is empty', async () => {
      const task = sample({
        taskId: 'bash-legacy01',
        description: 'legacy task',
        status: 'completed',
        endedAt: 1_700_000_100,
        exitCode: 0,
      });
      const legacy = rootedPersistence(SESSION_SCOPE);
      const primary = rootedPersistence(AGENT_SCOPE, sessionRoot());
      await legacy.writeTask(task);
      await legacy.appendTaskOutput(task.taskId, 'legacy output');

      expect(await primary.readTask(task.taskId)).toEqual(task);
      expect(await primary.listTasks()).toEqual([task]);
      expect(await primary.readTaskOutputSnapshot(task.taskId, 6)).toEqual({
        outputPath: join(sessionDir, SESSION_SCOPE, 'tasks', task.taskId, 'output.log'),
        outputSizeBytes: 13,
        previewBytes: 6,
        truncated: true,
        preview: 'output',
      });
    });

    it('keeps agent-local task and output authoritative without changing either root', async () => {
      const taskId = 'bash-shared01';
      const legacyTask = sample({ taskId, description: 'legacy task' });
      const localTask = sample({ taskId, description: 'local task' });
      const legacy = rootedPersistence(SESSION_SCOPE);
      const primary = rootedPersistence(AGENT_SCOPE, sessionRoot());
      await legacy.writeTask(legacyTask);
      await legacy.appendTaskOutput(taskId, 'legacy output');
      await primary.writeTask(localTask);
      await primary.appendTaskOutput(taskId, 'local output');

      expect(await primary.readTask(taskId)).toEqual(localTask);
      expect(await primary.listTasks()).toEqual([localTask]);
      expect(await primary.readTaskOutputSnapshot(taskId, 100)).toEqual({
        outputPath: join(sessionDir, AGENT_SCOPE, 'tasks', taskId, 'output.log'),
        outputSizeBytes: 12,
        previewBytes: 12,
        truncated: false,
        preview: 'local output',
      });
      expect(await primary.readTask(taskId)).toEqual(localTask);
      expect(await legacy.readTask(taskId)).toEqual(legacyTask);
      expect(await legacy.readTaskOutputBytes(taskId, 0, 100)).toBe('legacy output');
      expect(await primary.readTaskOutputBytes(taskId, 0, 100)).toBe('local output');
    });

    it('treats a corrupt agent-local task key as authoritative over legacy data', async () => {
      const taskId = 'bash-corrupt1';
      const legacy = rootedPersistence(SESSION_SCOPE);
      const primary = rootedPersistence(AGENT_SCOPE, sessionRoot());
      await legacy.writeTask(sample({ taskId, description: 'legacy task' }));
      await mkdir(join(sessionDir, AGENT_SCOPE, 'tasks'), { recursive: true });
      await writeFile(join(sessionDir, AGENT_SCOPE, 'tasks', `${taskId}.json`), '{not json');

      await expect(primary.readTask(taskId)).rejects.toThrow();
      expect(await primary.listTasks()).toEqual([]);
    });

    it('treats an unrecognized agent-local task document as authoritative over legacy data', async () => {
      const taskId = 'bash-invalid1';
      const legacy = rootedPersistence(SESSION_SCOPE);
      const primary = rootedPersistence(AGENT_SCOPE, sessionRoot());
      await legacy.writeTask(sample({ taskId, description: 'legacy task' }));
      await docs.set(`${AGENT_SCOPE}/tasks`, `${taskId}.json`, { unexpected: true });

      expect(await primary.readTask(taskId)).toBeUndefined();
      expect(await primary.listTasks()).toEqual([]);
    });

    it('treats an empty agent-local output file as authoritative over legacy output', async () => {
      const taskId = 'bash-empty001';
      const legacy = rootedPersistence(SESSION_SCOPE);
      const primary = rootedPersistence(AGENT_SCOPE, sessionRoot());
      await legacy.appendTaskOutput(taskId, 'legacy output');
      await bytes.write(`${AGENT_SCOPE}/tasks/${taskId}`, 'output.log', new Uint8Array(0));

      expect(await primary.readTaskOutputSnapshot(taskId, 100)).toEqual({
        outputPath: join(sessionDir, AGENT_SCOPE, 'tasks', taskId, 'output.log'),
        outputSizeBytes: 0,
        previewBytes: 0,
        truncated: false,
        preview: '',
      });
    });
  });
});

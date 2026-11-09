import { createMapFs } from '../../features/plan/stubs';
import { mkdir, readdir, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'pathe';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { AgentTaskPersistence } from '#/agent/task/task';
import type { AgentTaskSpillTarget } from '#/agent/task/persist';
import { recordingAppendFs } from './stubs';
import { FileStorageService } from '#/persistence/backends/node-fs/fileStorageService';
import { IFileSystemStorageService } from '#/persistence/interface/storage';

const SESSION_SCOPE = 'session';
const AGENT_SCOPE = `${SESSION_SCOPE}/agents/main`;

let sessionDir: string;
let bytes: IFileSystemStorageService;
let persistence: AgentTaskPersistence;

beforeEach(async () => {
  sessionDir = join(
    tmpdir(),
    `kimi-bg-persist-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  );
  await mkdir(sessionDir, { recursive: true });
  bytes = new FileStorageService(sessionDir, 0o700);
  persistence = new AgentTaskPersistence(sessionDir, SESSION_SCOPE, bytes);
});

afterEach(async () => {
  await rm(sessionDir, { recursive: true, force: true });
});

describe('AgentTaskPersistence', () => {
  function rootedPersistence(
    scope: string,
    fallbackRoot?: { readonly dir: string; readonly scope: string },
  ): AgentTaskPersistence {
    return new AgentTaskPersistence(join(sessionDir, scope), scope, bytes, fallbackRoot);
  }

  function sessionRoot(): { readonly dir: string; readonly scope: string } {
    return { dir: join(sessionDir, SESSION_SCOPE), scope: SESSION_SCOPE };
  }

  function spillPersistence(target: () => AgentTaskSpillTarget | undefined): AgentTaskPersistence {
    return new AgentTaskPersistence(join(sessionDir, AGENT_SCOPE), AGENT_SCOPE, bytes, undefined, target);
  }

  it('round-trips appended output through output.log snapshots', async () => {
    await persistence.appendTaskOutput('bash-11111111', 'first\nsecond\n');

    expect(await persistence.readTaskOutputSnapshot('bash-11111111', 100)).toEqual({
      outputPath: join(sessionDir, 'tasks', 'bash-11111111', 'output.log'),
      outputSizeBytes: 13,
      previewBytes: 13,
      truncated: false,
      preview: 'first\nsecond\n',
    });
  });

  it('returns undefined when output.log is missing', async () => {
    expect(await persistence.readTaskOutputSnapshot('bash-missing0', 100)).toBeUndefined();
  });

  it('appends subsequent writes without replacing earlier output', async () => {
    const output = persistence.open('bash-11111111');
    expect(output.append('one')).toBe(0);
    expect(output.append('two')).toBe(3);
    await output.flush();

    expect(await output.read(0, 100)).toBe('onetwo');
    expect(await persistence.readTaskOutputBytes('bash-11111111', 0, 100)).toBe('onetwo');
    await output.close();
    await output.close();
    expect(output.append('ignored')).toBeUndefined();
    const restored = persistence.open('bash-11111111');
    expect(await restored.read(0, 100)).toBe('onetwo');
    await restored.close();
  });

  it('isolates output by task id', async () => {
    await persistence.appendTaskOutput('bash-11111111', 'first');
    await persistence.appendTaskOutput('bash-22222222', 'second');

    expect(await persistence.readTaskOutputBytes('bash-11111111', 0, 100)).toBe('first');
    expect(await persistence.readTaskOutputBytes('bash-22222222', 0, 100)).toBe('second');
  });

  it('rejects path-traversal task ids for every output entry point', async () => {
    await expect(persistence.appendTaskOutput('../../etc/passwd', 'x')).rejects.toThrow(/Invalid task id/);
    await expect(persistence.readTaskOutputSnapshot('../etc/passwd', 10)).rejects.toThrow(/Invalid task id/);
    await expect(persistence.readTaskOutputTail('../etc/passwd', 10)).rejects.toThrow(/Invalid task id/);
    expect(() => persistence.taskOutputFile('../etc/passwd')).toThrow(/Invalid task id/);
  });

  it('creates the output tasks dir with mode 0700', async () => {
    await persistence.appendTaskOutput('bash-11111111', 'output');

    const st = await stat(join(sessionDir, SESSION_SCOPE, 'tasks'));
    expect(st.mode & 0o777).toBe(0o700);
  });

  it('does not create a directory when reading missing output', async () => {
    expect(await persistence.readTaskOutputSnapshot('bash-noexis00', 100)).toBeUndefined();

    expect(await readdir(sessionDir)).toEqual([]);
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
      const output = persistence.open('bash-page0000');
      output.append('abcdefghijklmnopqrstuvwxyz');
      output.append('世界➜');
      await output.flush();

      expect(await persistence.readTaskOutputBytes('bash-page0000', 5, 10)).toBe('fghijklmno');
      expect(await persistence.readTaskOutputBytes('bash-page0000', 0, 3)).toBe('abc');
      expect(await persistence.readTaskOutputBytes('bash-page0000', 20, 100)).toBe('uvwxyz世界➜');
      expect(await persistence.readTaskOutputBytes('bash-page0000', 35, 10)).toBe('');
      expect(await output.read(26, 6)).toBe('世界');
      expect(await output.read(32, 3)).toBe('➜');
      await output.close();
    });

    it('readTaskOutputBytes returns empty string when output.log is absent', async () => {
      expect(await persistence.readTaskOutputBytes('bash-none0001', 0, 100)).toBe('');
    });

    it('taskOutputExists distinguishes present and absent logs', async () => {
      await persistence.appendTaskOutput('bash-exists00', '');

      expect(await persistence.taskOutputExists('bash-exists00')).toBe(false);
      await persistence.appendTaskOutput('bash-exists00', 'x');
      expect(await persistence.taskOutputExists('bash-exists00')).toBe(true);
      expect(await persistence.taskOutputExists('bash-none0002')).toBe(false);
    });

    it('readTaskOutputTail returns bytes and their absolute offset', async () => {
      await persistence.appendTaskOutput('bash-tail0000', 'abcdef');

      const tail = await persistence.readTaskOutputTail('bash-tail0000', 3);
      expect(tail?.offset).toBe(3);
      expect(Buffer.from(tail!.data).toString('utf-8')).toBe('def');
    });

    it('readTaskOutputTail returns undefined for a missing log', async () => {
      expect(await persistence.readTaskOutputTail('bash-none0003', 10)).toBeUndefined();
    });

    it('snapshots return a tail preview with full output metadata', async () => {
      await persistence.appendTaskOutput('bash-preview0', '0123456789');

      expect(await persistence.readTaskOutputSnapshot('bash-preview0', 4)).toEqual({
        outputPath: join(sessionDir, 'tasks', 'bash-preview0', 'output.log'),
        outputSizeBytes: 10,
        previewBytes: 4,
        truncated: true,
        preview: '6789',
      });
    });

    it('zero-byte previews preserve the full output size and path', async () => {
      await persistence.appendTaskOutput('bash-preview1', 'content');

      expect(await persistence.readTaskOutputSnapshot('bash-preview1', 0)).toMatchObject({
        outputSizeBytes: 7,
        previewBytes: 0,
        truncated: true,
        preview: '',
      });
    });
  });

  describe('legacy session-root output fallback', () => {
    it('reads legacy output and reports its real path when the agent root is empty', async () => {
      const taskId = 'bash-legacy01';
      const legacy = rootedPersistence(SESSION_SCOPE);
      const primary = rootedPersistence(AGENT_SCOPE, sessionRoot());
      await legacy.appendTaskOutput(taskId, 'legacy output');

      expect(await primary.readTaskOutputSnapshot(taskId, 6)).toEqual({
        outputPath: join(sessionDir, SESSION_SCOPE, 'tasks', taskId, 'output.log'),
        outputSizeBytes: 13,
        previewBytes: 6,
        truncated: true,
        preview: 'output',
      });
    });

    it('keeps agent-local output authoritative without changing either root', async () => {
      const taskId = 'bash-shared01';
      const legacy = rootedPersistence(SESSION_SCOPE);
      const primary = rootedPersistence(AGENT_SCOPE, sessionRoot());
      await legacy.appendTaskOutput(taskId, 'legacy output');
      await primary.appendTaskOutput(taskId, 'local output');

      expect(await primary.readTaskOutputSnapshot(taskId, 100)).toEqual({
        outputPath: join(sessionDir, AGENT_SCOPE, 'tasks', taskId, 'output.log'),
        outputSizeBytes: 12,
        previewBytes: 12,
        truncated: false,
        preview: 'local output',
      });
      expect(await legacy.readTaskOutputBytes(taskId, 0, 100)).toBe('legacy output');
      expect(await primary.readTaskOutputBytes(taskId, 0, 100)).toBe('local output');
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

    it('reads output tails from the authoritative agent-local root', async () => {
      const taskId = 'bash-tail0001';
      const legacy = rootedPersistence(SESSION_SCOPE);
      const primary = rootedPersistence(AGENT_SCOPE, sessionRoot());
      await legacy.appendTaskOutput(taskId, 'legacy output');
      await primary.appendTaskOutput(taskId, 'local output');

      const tail = await primary.readTaskOutputTail(taskId, 5);
      expect(tail?.offset).toBe(7);
      expect(Buffer.from(tail!.data).toString('utf-8')).toBe('utput');
    });
  });

  describe('environment spill mirror', () => {
    it('mirrors appended output into the spill target and reports the spill path', async () => {
      const writes: { path: string; data: string }[] = [];
      const fs = recordingAppendFs(writes);
      const spill = spillPersistence(() => ({ fs, dir: '/remote/tmp/kimi-code/task-output' }));

      await spill.appendTaskOutput('bash-mirror01', 'chunk-one');
      await spill.appendTaskOutput('bash-mirror01', 'chunk-two');

      expect(writes).toEqual([
        { path: '/remote/tmp/kimi-code/task-output/bash-mirror01.log', data: 'chunk-one' },
        { path: '/remote/tmp/kimi-code/task-output/bash-mirror01.log', data: 'chunk-two' },
      ]);
      const snapshot = await spill.readTaskOutputSnapshot('bash-mirror01', 100);
      expect(snapshot?.outputPath).toBe('/remote/tmp/kimi-code/task-output/bash-mirror01.log');
      expect(snapshot?.outputSizeBytes).toBe('chunk-onechunk-two'.length);
    });

    it('isolates failures by task and repairs a missing chunk before advertising the mirror', async () => {
      const files = new Map<string, string>();
      let failedTask: string | undefined;
      const fs = createMapFs(files);
      const write = fs.writeText;
      const append = fs.appendText;
      fs.writeText = async (path, data) => {
        if (path.includes(failedTask ?? '\0')) throw new Error('offline');
        await write(path, data);
      };
      fs.appendText = async (path, data) => {
        if (path.includes(failedTask ?? '\0')) throw new Error('offline');
        await append(path, data);
      };
      const target = { fs, dir: '/remote/task-output' };
      const spill = spillPersistence(() => target);
      const a = 'bash-00000001';
      const b = 'bash-00000002';
      await spill.appendTaskOutput(a, 'a');
      failedTask = a;
      await spill.appendTaskOutput(a, 'b');
      await spill.appendTaskOutput(b, 'other');
      expect((await spill.readTaskOutputSnapshot(a, 100))?.outputPath).toBe(spill.taskOutputFile(a));
      expect((await spill.readTaskOutputSnapshot(b, 100))?.outputPath).toBe(`${target.dir}/${b}.log`);
      expect(files.get(`${target.dir}/${a}.log`)).toBe('a');
      failedTask = undefined;
      await spill.appendTaskOutput(a, 'c');
      expect(files.get(`${target.dir}/${a}.log`)).toBe('abc');
      expect((await spill.readTaskOutputSnapshot(a, 100))?.outputPath).toBe(`${target.dir}/${a}.log`);
    });

    it('serializes concurrent appends and snapshot repair for each task', async () => {
      const files = new Map<string, string>();
      const fs = createMapFs(files);
      const write = fs.writeText;
      let release!: () => void;
      const gate = new Promise<void>((resolve) => { release = resolve; });
      fs.writeText = async (path, data) => { await gate; await write(path, data); };
      const spill = spillPersistence(() => ({ fs, dir: '/remote/task-output' }));
      const first = spill.appendTaskOutput('bash-concur01', 'a');
      const second = spill.appendTaskOutput('bash-concur01', 'b');
      const snapshot = spill.readTaskOutputSnapshot('bash-concur01', 100);
      release();
      await Promise.all([first, second]);
      const result = await snapshot;
      expect(result?.preview).toBe('ab');
      expect(files.get(result!.outputPath)).toBe('ab');
    });
    it('rejects malformed task ids at the persistence path boundary', () => {
    const rejected = [
      '',
      'x',
      '-bash',
      'BASH-12345678',
      'bash_12345678',
      '../escape',
      'bash-1234567',
      'bash-123456789',
      'agent-ABCDEFGH',
      'bg_12345678',
      'a'.repeat(26),
    ];
    for (const bad of rejected) {
      expect(() => persistence.taskOutputFile(bad)).toThrow(/Invalid task id/);
    }
  });
  });
});

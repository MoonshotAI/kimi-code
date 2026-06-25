import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { Readable } from 'node:stream';
import type { Writable } from 'node:stream';
import { join } from 'pathe';

import type { KaosProcess } from '@moonshot-ai/kaos';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  BackgroundTaskPersistence,
  type IBackgroundService,
  ProcessBackgroundTask,
} from '../../../../src/services/agent/background/background';
import { testAgent, type TestAgentContext } from '../harness';

type BackgroundServiceTestManager = IBackgroundService & {
  loadFromDisk(): Promise<void>;
  reconcile(): Promise<readonly unknown[]>;
};

interface BackgroundServiceFixture {
  readonly ctx: TestAgentContext;
  readonly manager: BackgroundServiceTestManager;
  readonly persistence: BackgroundTaskPersistence;
}

function createBackgroundService(sessionDir: string): BackgroundServiceFixture {
  const persistence = new BackgroundTaskPersistence(sessionDir);
  const ctx = testAgent({ background: { persistence } });
  return {
    ctx,
    manager: ctx.background as BackgroundServiceTestManager,
    persistence,
  };
}

function registerProcess(
  manager: IBackgroundService,
  proc: KaosProcess,
  command: string,
  description: string,
): string {
  return manager.registerTask(new ProcessBackgroundTask(proc, command, description));
}

async function waitForOutput(
  manager: IBackgroundService,
  taskId: string,
  expected: string,
): Promise<void> {
  for (let i = 0; i < 20; i++) {
    const output = await manager.readOutput(taskId);
    if (output.includes(expected)) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(`Timed out waiting for output: ${expected}`);
}

function immediateProcess(exitCode: number, stdoutText = ''): KaosProcess {
  return {
    stdin: { write: vi.fn(), end: vi.fn() } as unknown as Writable,
    stdout: Readable.from(stdoutText ? [stdoutText] : []),
    stderr: Readable.from([]),
    pid: 50000 + exitCode,
    exitCode,
    wait: vi.fn().mockResolvedValue(exitCode) as KaosProcess['wait'],
    kill: vi.fn().mockResolvedValue(undefined) as KaosProcess['kill'],
    dispose: vi.fn().mockResolvedValue(undefined) as KaosProcess['dispose'],
  };
}

describe('BackgroundManager — readOutput / getOutputSnapshot', () => {
  let sessionDir: string;
  let manager: BackgroundServiceTestManager;
  let persistence: BackgroundTaskPersistence;
  let ctx: TestAgentContext;

  beforeEach(() => {
    sessionDir = mkdtempSync(join(tmpdir(), 'bpm-output-'));
    const fixture = createBackgroundService(sessionDir);
    ctx = fixture.ctx;
    manager = fixture.manager;
    persistence = fixture.persistence;
  });

  afterEach(async () => {
    await ctx.close();
    rmSync(sessionDir, { recursive: true, force: true });
  });

  it('getOutputSnapshot returns output.log path when persisted output exists', async () => {
    const taskId = registerProcess(manager, immediateProcess(0, 'hello\n'), 'echo', 'demo');

    await waitForOutput(manager, taskId, 'hello');
    const snapshot = await manager.getOutputSnapshot(taskId, 1_000);

    expect(snapshot.outputPath).toBeDefined();
    expect(snapshot.outputPath).toContain(sessionDir);
    expect(snapshot.outputPath).toContain(taskId);
    expect(snapshot.outputPath!.endsWith('output.log')).toBe(true);
    expect(snapshot.fullOutputAvailable).toBe(true);
  });

  it('getOutputSnapshot omits outputPath when no persisted log file exists', async () => {
    const taskId = registerProcess(manager, immediateProcess(0), 'sleep 1', 'silent task');

    await manager.wait(taskId);
    const snapshot = await manager.getOutputSnapshot(taskId, 1_000);

    expect(snapshot.outputPath).toBeUndefined();
    expect(snapshot.fullOutputAvailable).toBe(false);
  });

  it('getOutputSnapshot returns an empty snapshot for unknown task ids', async () => {
    await expect(manager.getOutputSnapshot('bash-deadbeef', 1_000)).resolves.toEqual({
      outputSizeBytes: 0,
      previewBytes: 0,
      truncated: false,
      fullOutputAvailable: false,
      preview: '',
    });
  });

  it('readOutput returns live ring-buffer content while task is in memory', async () => {
    const taskId = registerProcess(
      manager,
      immediateProcess(0, 'live content\n'),
      'echo',
      'demo',
    );

    await waitForOutput(manager, taskId, 'live content');

    expect(await manager.readOutput(taskId)).toContain('live content');
  });

  it('readOutput prefers disk over the live ring buffer when persisted output exists', async () => {
    const taskId = registerProcess(manager, immediateProcess(0, 'ring-only\n'), 'echo', 'demo');

    await waitForOutput(manager, taskId, 'ring-only');
    await persistence.appendTaskOutput(taskId, 'disk-only\n');

    expect(await manager.readOutput(taskId)).toContain('disk-only');
  });

  it('readOutput falls back to disk for ghost tasks', async () => {
    const taskId = registerProcess(
      manager,
      immediateProcess(0, 'persisted line\n'),
      'echo',
      'demo',
    );
    await waitForOutput(manager, taskId, 'persisted line');
    await manager.wait(taskId);

    const fresh = createBackgroundService(sessionDir).manager;
    await fresh.loadFromDisk();
    await fresh.reconcile();

    expect(await fresh.readOutput(taskId)).toContain('persisted line');
  });

  it('readOutput respects tail length', async () => {
    const taskId = registerProcess(
      manager,
      immediateProcess(0, 'aaaaa-bbbbb-ccccc-ddddd'),
      'echo',
      'demo',
    );

    await waitForOutput(manager, taskId, 'ddddd');

    expect(await manager.readOutput(taskId, 5)).toBe('ddddd');
  });
});

/**
 * Foreground task persistence: foreground commands keep their output in memory
 * and only touch disk once they detach or spill past the in-memory buffer. A
 * foreground command that finishes without either leaves nothing on disk, so
 * undiscoverable logs don't accumulate.
 */

import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { Readable } from 'node:stream';
import type { Writable } from 'node:stream';
import { join } from 'pathe';

import type { KaosProcess } from '@moonshot-ai/kaos';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ProcessBackgroundTask, type BackgroundManager } from '../../../src/agent/background';
import { createBackgroundManager, waitForTerminal } from './helpers';

const MAX_OUTPUT_BYTES = 1024 * 1024;

const tick = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 5));

function immediateProcess(exitCode: number, stdoutText = ''): KaosProcess {
  return {
    stdin: { write: vi.fn(), end: vi.fn() } as unknown as Writable,
    stdout: Readable.from(stdoutText ? [stdoutText] : []),
    stderr: Readable.from([]),
    pid: 60000 + exitCode,
    exitCode,
    wait: vi.fn().mockResolvedValue(exitCode) as KaosProcess['wait'],
    kill: vi.fn().mockResolvedValue(undefined) as KaosProcess['kill'],
    dispose: vi.fn().mockResolvedValue(undefined) as KaosProcess['dispose'],
  };
}

/** A process whose stdout and exit are driven by the test, for timing control. */
function controllableProcess(): {
  proc: KaosProcess;
  pushStdout: (text: string) => void;
  finish: (exitCode: number) => void;
} {
  const stdout = new Readable({ read() {} });
  let resolveWait!: (code: number) => void;
  const waitPromise = new Promise<number>((resolve) => {
    resolveWait = resolve;
  });
  const proc: KaosProcess = {
    stdin: { write: vi.fn(), end: vi.fn() } as unknown as Writable,
    stdout,
    stderr: Readable.from([]),
    pid: 61000,
    exitCode: null,
    wait: vi.fn(() => waitPromise) as KaosProcess['wait'],
    kill: vi.fn().mockResolvedValue(undefined) as KaosProcess['kill'],
    dispose: vi.fn().mockResolvedValue(undefined) as KaosProcess['dispose'],
  };
  return {
    proc,
    pushStdout: (text) => stdout.push(text),
    finish: (exitCode) => {
      (proc as { exitCode: number | null }).exitCode = exitCode;
      stdout.push(null);
      resolveWait(exitCode);
    },
  };
}

function registerForeground(
  manager: BackgroundManager,
  proc: KaosProcess,
  command: string,
  description: string,
): string {
  return manager.registerTask(new ProcessBackgroundTask(proc, command, description), {
    detached: false,
  });
}

describe('BackgroundManager — foreground persistence', () => {
  let sessionDir: string;
  let manager: BackgroundManager;
  let persistence: NonNullable<ReturnType<typeof createBackgroundManager>['persistence']>;

  beforeEach(() => {
    sessionDir = mkdtempSync(join(tmpdir(), 'bpm-fg-'));
    const fixture = createBackgroundManager({ sessionDir });
    manager = fixture.manager;
    persistence = fixture.persistence!;
  });

  afterEach(() => {
    rmSync(sessionDir, { recursive: true, force: true });
  });

  const taskJsonPath = (taskId: string): string => join(sessionDir, 'tasks', `${taskId}.json`);

  it('writes nothing to disk for a foreground task that does not spill or detach', async () => {
    const taskId = registerForeground(manager, immediateProcess(0, 'hello\n'), 'echo', 'demo');

    await waitForTerminal(manager, taskId);

    expect(existsSync(taskJsonPath(taskId))).toBe(false);
    expect(existsSync(persistence.taskOutputFile(taskId))).toBe(false);

    // Output is still readable from the in-memory ring buffer.
    const snapshot = await manager.getOutputSnapshot(taskId, 1_000);
    expect(snapshot.fullOutputAvailable).toBe(false);
    expect(snapshot.preview).toContain('hello');
  });

  it('flushes complete pre-detach output to disk when a foreground task detaches', async () => {
    const { proc, pushStdout, finish } = controllableProcess();
    const taskId = registerForeground(manager, proc, 'stream', 'demo');

    pushStdout('before-detach\n');
    await tick(); // buffered in memory, not yet on disk
    expect(existsSync(persistence.taskOutputFile(taskId))).toBe(false);

    expect(manager.detach(taskId)?.detached).toBe(true);

    pushStdout('after-detach\n');
    await tick();
    finish(0);
    await waitForTerminal(manager, taskId);

    // output.log is the complete, in-order record across the detach boundary.
    expect(await manager.readOutput(taskId)).toBe('before-detach\nafter-detach\n');
    expect(existsSync(taskJsonPath(taskId))).toBe(true);
  });

  it('spills to disk and keeps the log when foreground output exceeds the buffer', async () => {
    const big = 'a'.repeat(MAX_OUTPUT_BYTES + 1024);
    const taskId = registerForeground(manager, immediateProcess(0, big), 'flood', 'demo');

    await waitForTerminal(manager, taskId);

    // getOutputSnapshot drains the output write queue before reporting size.
    const snapshot = await manager.getOutputSnapshot(taskId, 1_000);

    // Spilled artifacts are persisted complete and NOT deleted on completion.
    expect(existsSync(persistence.taskOutputFile(taskId))).toBe(true);
    expect(existsSync(taskJsonPath(taskId))).toBe(true);
    expect(snapshot.fullOutputAvailable).toBe(true);
    expect(snapshot.outputSizeBytes).toBe(big.length);
  });
});

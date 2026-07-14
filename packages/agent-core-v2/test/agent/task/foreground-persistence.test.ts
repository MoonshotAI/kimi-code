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

import type { IProcess } from '#/session/process/processRunner';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { IAgentTaskService } from '#/agent/task/task';
import { IAgentLoopService } from '#/agent/loop/loop';
import { TERMINAL_STATUSES } from '#/agent/task/types';
import { ProcessTask } from '#/os/backends/node-local/tools/process-task';
import {
  taskServices,
  createTestAgent,
  homeDirServices,
  type TestAgentContext,
} from '../../harness';
import {
  TASK_TEST_AGENT_SCOPE,
  createAgentTaskPersistence,
} from './stubs';

const MAX_OUTPUT_BYTES = 1024 * 1024;

const tick = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 5));

function immediateProcess(exitCode: number, stdoutText = ''): IProcess {
  return {
    stdin: { write: vi.fn(), end: vi.fn() } as unknown as Writable,
    stdout: Readable.from(stdoutText ? [stdoutText] : []),
    stderr: Readable.from([]),
    pid: 60000 + exitCode,
    exitCode,
    wait: vi.fn().mockResolvedValue(exitCode) as IProcess['wait'],
    kill: vi.fn().mockResolvedValue(undefined) as IProcess['kill'],
    dispose: vi.fn().mockResolvedValue(undefined) as IProcess['dispose'],
  };
}

function controllableProcess(): {
  proc: IProcess;
  pushStdout: (text: string) => void;
  finish: (exitCode: number) => void;
} {
  const stdout = new Readable({ read() {} });
  let resolveWait!: (code: number) => void;
  const waitPromise = new Promise<number>((resolve) => {
    resolveWait = resolve;
  });
  const proc: IProcess = {
    stdin: { write: vi.fn(), end: vi.fn() } as unknown as Writable,
    stdout,
    stderr: Readable.from([]),
    pid: 61000,
    exitCode: null,
    wait: vi.fn(() => waitPromise) as IProcess['wait'],
    kill: vi.fn().mockResolvedValue(undefined) as IProcess['kill'],
    dispose: vi.fn().mockResolvedValue(undefined) as IProcess['dispose'],
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
  background: IAgentTaskService,
  proc: IProcess,
  command: string,
  description: string,
): string {
  return background.registerTask(new ProcessTask(proc, command, description), {
    detached: false,
  });
}

async function drainPendingNotifications(
  ctx: TestAgentContext,
  background: IAgentTaskService,
): Promise<void> {
  const expectsNotification = background
    .list(false)
    .some(
      (task) =>
        TERMINAL_STATUSES.has(task.status) &&
        task.detached !== false &&
        task.terminalNotificationSuppressed !== true,
    );
  if (!expectsNotification) return;
  ctx.mockNextResponse({ type: 'text', text: 'notification drain ack' });
  await vi.waitFor(() => {
    const delivered = ctx.allEvents.filter((e) => e.event === 'task.notified').length;
    expect(delivered).toBeGreaterThanOrEqual(1);
  });
  await vi.waitFor(() => {
    const loop = ctx.get(IAgentLoopService);
    expect(loop.status().state).toBe('idle');
    expect(loop.hasPendingRequests()).toBe(false);
  });
}

describe('AgentTaskService — foreground persistence', () => {
  let sessionDir: string;
  let persistence: ReturnType<typeof createAgentTaskPersistence>;
  let ctx: TestAgentContext;
  let background: IAgentTaskService;

  beforeEach(() => {
    sessionDir = mkdtempSync(join(tmpdir(), 'bpm-fg-'));
    persistence = createAgentTaskPersistence(sessionDir);
    ctx = createTestAgent(homeDirServices(sessionDir), taskServices());
    background = ctx.get(IAgentTaskService);
  });

  afterEach(async () => {
    try {
      await drainPendingNotifications(ctx, background);
      await ctx.expectResumeMatches();
    } finally {
      await ctx.dispose();
      rmSync(sessionDir, { recursive: true, force: true });
    }
  });

  const taskJsonPath = (taskId: string): string =>
    join(sessionDir, TASK_TEST_AGENT_SCOPE, 'tasks', `${taskId}.json`);

  it('writes nothing to disk for a foreground task that does not spill or detach', async () => {
    const taskId = registerForeground(background, immediateProcess(0, 'hello\n'), 'echo', 'demo');

    await background.wait(taskId);

    expect(existsSync(taskJsonPath(taskId))).toBe(false);
    expect(existsSync(persistence.taskOutputFile(taskId))).toBe(false);

    const snapshot = await background.getOutputSnapshot(taskId, 1_000);
    expect(snapshot.fullOutputAvailable).toBe(false);
    expect(snapshot.preview).toContain('hello');
  });

  it('flushes complete pre-detach output to disk when a foreground task detaches', async () => {
    const { proc, pushStdout, finish } = controllableProcess();
    const taskId = registerForeground(background, proc, 'stream', 'demo');

    pushStdout('before-detach\n');
    await tick();
    expect(existsSync(persistence.taskOutputFile(taskId))).toBe(false);

    expect(background.detach(taskId)?.detached).toBe(true);

    pushStdout('after-detach\n');
    await tick();
    finish(0);
    await background.wait(taskId);

    expect(await background.readOutput(taskId)).toBe('before-detach\nafter-detach\n');
    expect(existsSync(taskJsonPath(taskId))).toBe(true);
  });

  it('spills to disk and keeps the log when foreground output exceeds the buffer', async () => {
    const big = 'a'.repeat(MAX_OUTPUT_BYTES + 1024);
    const taskId = registerForeground(background, immediateProcess(0, big), 'flood', 'demo');

    await background.wait(taskId);

    const snapshot = await background.getOutputSnapshot(taskId, 1_000);

    expect(existsSync(persistence.taskOutputFile(taskId))).toBe(true);
    expect(existsSync(taskJsonPath(taskId))).toBe(true);
    expect(snapshot.fullOutputAvailable).toBe(true);
    expect(snapshot.outputSizeBytes).toBe(big.length);
  });
});

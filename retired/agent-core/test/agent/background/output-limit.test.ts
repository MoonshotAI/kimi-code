/**
 * Output ceiling for shell (process) tasks.
 *
 * A single shell command that streams more output than the per-command limit
 * must be force-terminated instead of growing the (unbounded) live-forward
 * buffer or the on-disk write chain until the process runs out of memory or
 * fills the disk. The ceiling applies to process tasks, foreground and
 * background alike. Subagent and user-question tasks append their bounded result
 * in one shot and must always be persisted, so they are not capped.
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { Readable, type Writable } from 'node:stream';

import type { KaosProcess } from '@moonshot-ai/kaos';
import { join } from 'pathe';
import { describe, expect, it, vi } from 'vitest';

import { ProcessBackgroundTask } from '../../../src/agent/background';
import { agentTask, createBackgroundManager, waitForTerminal } from './helpers';

const MiB = 1024 * 1024;
const LIMIT_BYTES = 16 * MiB;

/**
 * A process that streams `chunks` of stdout, then exits 0 on its own — unless
 * it is killed first, in which case `wait()` resolves with the signal's exit
 * code and the stream is destroyed (simulating the child dying on SIGTERM).
 */
function streamingProcess(chunks: string[]): {
  proc: KaosProcess;
  kill: ReturnType<typeof vi.fn>;
} {
  const stdout = Readable.from(chunks);
  const stderr = Readable.from([]);
  let resolveWait!: (code: number) => void;
  const waitP = new Promise<number>((resolve) => {
    resolveWait = resolve;
  });
  stdout.on('end', () => {
    resolveWait(0);
  });
  const kill = vi.fn(async (signal: string) => {
    stdout.destroy();
    resolveWait(signal === 'SIGKILL' ? 137 : 143);
  });
  const proc = {
    stdin: { write: vi.fn(), end: vi.fn() } as unknown as Writable,
    stdout,
    stderr,
    pid: 4242,
    exitCode: null,
    wait: () => waitP,
    kill,
    dispose: vi.fn().mockResolvedValue(undefined),
  } as unknown as KaosProcess;
  return { proc, kill };
}

/**
 * A process that keeps streaming all of `chunks` regardless of SIGTERM (only
 * SIGKILL stops it) — simulating a producer that ignores the graceful stop and
 * keeps writing through the SIGTERM grace window.
 */
function sigtermIgnoringProcess(chunks: string[]): { proc: KaosProcess; kill: ReturnType<typeof vi.fn> } {
  const stdout = Readable.from(chunks);
  const stderr = Readable.from([]);
  let resolveWait!: (code: number) => void;
  const waitP = new Promise<number>((resolve) => {
    resolveWait = resolve;
  });
  stdout.on('end', () => {
    resolveWait(0);
  });
  const kill = vi.fn(async (signal: string) => {
    if (signal === 'SIGKILL') {
      stdout.destroy();
      resolveWait(137);
    }
    // SIGTERM is intentionally ignored.
  });
  const proc = {
    stdin: { write: vi.fn(), end: vi.fn() } as unknown as Writable,
    stdout,
    stderr,
    pid: 4243,
    exitCode: null,
    wait: () => waitP,
    kill,
    dispose: vi.fn().mockResolvedValue(undefined),
  } as unknown as KaosProcess;
  return { proc, kill };
}

describe('BackgroundManager — output ceiling (foreground + background)', () => {
  it('terminates a foreground command that exceeds the output limit and stops forwarding', async () => {
    const { manager } = createBackgroundManager();
    // 20 MiB total, well past the 16 MiB ceiling.
    const chunks = Array.from({ length: 20 }, () => 'x'.repeat(MiB));
    const { proc, kill } = streamingProcess(chunks);

    let forwardedChars = 0;
    const onOutput = vi.fn((_kind: 'stdout' | 'stderr', text: string) => {
      forwardedChars += text.length;
    });

    const taskId = manager.registerTask(
      new ProcessBackgroundTask(proc, 'b3sum --length 18446744073709551615', 'hash', onOutput),
      { detached: false, signal: new AbortController().signal, timeoutMs: 60_000 },
    );

    const info = await waitForTerminal(manager, taskId);

    expect(info?.status).toBe('killed');
    expect(info?.stopReason ?? '').toMatch(/output limit/i);
    expect(kill).toHaveBeenCalledWith('SIGTERM');
    // The live-forward path is capped at the ceiling rather than draining the
    // full 20 MiB into the (unbounded) transcript/stderr buffer.
    expect(forwardedChars).toBeLessThanOrEqual(LIMIT_BYTES);
  });

  it('also terminates a detached (background) task that exceeds the output limit', async () => {
    const { manager } = createBackgroundManager();
    const chunks = Array.from({ length: 20 }, () => 'x'.repeat(MiB));
    const { proc, kill } = streamingProcess(chunks);

    const taskId = manager.registerTask(new ProcessBackgroundTask(proc, 'producer', 'bg'), {
      detached: true,
      timeoutMs: 60_000,
    });

    const info = await waitForTerminal(manager, taskId);

    expect(info?.status).toBe('killed');
    expect(info?.stopReason ?? '').toMatch(/output limit/i);
    expect(kill).toHaveBeenCalledWith('SIGTERM');
  });

  it('stops enqueuing output to disk once the foreground cap trips', async () => {
    const sessionDir = mkdtempSync(join(tmpdir(), 'bpm-limit-'));
    try {
      const { manager, persistence } = createBackgroundManager({ sessionDir });
      let persistedChars = 0;
      const spy = vi
        .spyOn(persistence!, 'appendTaskOutput')
        .mockImplementation(async (_id: string, chunk: string) => {
          persistedChars += chunk.length;
        });

      // 20 MiB, and the producer ignores SIGTERM so it keeps writing through
      // the whole grace window.
      const chunks = Array.from({ length: 20 }, () => 'x'.repeat(MiB));
      const { proc } = sigtermIgnoringProcess(chunks);

      const taskId = manager.registerTask(
        new ProcessBackgroundTask(proc, 'runaway', 'hash', () => {}),
        { detached: false, signal: new AbortController().signal, timeoutMs: 60_000 },
      );

      const info = await waitForTerminal(manager, taskId);

      expect(info?.status).toBe('killed');
      // Before the fix every chunk of the 20 MiB is enqueued into the disk
      // write chain (retaining each string until its write drains); afterwards
      // enqueuing stops at the ceiling so the chain cannot grow unbounded.
      expect(persistedChars).toBeLessThanOrEqual(17 * MiB);

      spy.mockRestore();
    } finally {
      rmSync(sessionDir, { recursive: true, force: true });
    }
  });

  it('stops enqueuing output to disk once the cap trips for a background task', async () => {
    const sessionDir = mkdtempSync(join(tmpdir(), 'bpm-limit-bg-'));
    try {
      const { manager, persistence } = createBackgroundManager({ sessionDir });
      let persistedChars = 0;
      const spy = vi
        .spyOn(persistence!, 'appendTaskOutput')
        .mockImplementation(async (_id: string, chunk: string) => {
          persistedChars += chunk.length;
        });

      // 20 MiB, and the producer ignores SIGTERM so it keeps writing through
      // the whole grace window. Background tasks now share the same ceiling.
      const chunks = Array.from({ length: 20 }, () => 'x'.repeat(MiB));
      const { proc } = sigtermIgnoringProcess(chunks);

      const taskId = manager.registerTask(new ProcessBackgroundTask(proc, 'runaway', 'bg', () => {}), {
        detached: true,
        timeoutMs: 60_000,
      });

      const info = await waitForTerminal(manager, taskId);

      expect(info?.status).toBe('killed');
      // Same guarantee as the foreground case: once the cap trips, subsequent
      // chunks are dropped before they reach the disk write chain.
      expect(persistedChars).toBeLessThanOrEqual(17 * MiB);

      spy.mockRestore();
    } finally {
      rmSync(sessionDir, { recursive: true, force: true });
    }
  });

  it('does not cap or drop a detached subagent result larger than the limit', async () => {
    const sessionDir = mkdtempSync(join(tmpdir(), 'bpm-limit-agent-'));
    try {
      const { manager, persistence } = createBackgroundManager({ sessionDir });
      let persistedChars = 0;
      const spy = vi
        .spyOn(persistence!, 'appendTaskOutput')
        .mockImplementation(async (_id: string, chunk: string) => {
          persistedChars += chunk.length;
        });

      // 20 MiB result — well past the 16 MiB ceiling — delivered in one shot,
      // exactly how a subagent appends its completed result.
      const bigResult = 'y'.repeat(20 * MiB);
      const taskId = manager.registerTask(
        agentTask(Promise.resolve({ result: bigResult }), 'big subagent result'),
        { detached: true, timeoutMs: 60_000 },
      );

      const info = await waitForTerminal(manager, taskId);

      // Non-process tasks must complete normally and have their full result
      // persisted; the shell-output ceiling must not drop it.
      expect(info?.status).toBe('completed');
      expect(persistedChars).toBe(bigResult.length);

      spy.mockRestore();
    } finally {
      rmSync(sessionDir, { recursive: true, force: true });
    }
  });
});

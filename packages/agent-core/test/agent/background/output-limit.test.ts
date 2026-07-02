/**
 * Foreground output ceiling.
 *
 * A single non-detached command that streams more output than the per-command
 * limit must be force-terminated instead of growing the (unbounded)
 * live-forward buffer until the process runs out of memory. Detached
 * (background) tasks are exempt: their output is ring-buffered and spilled to
 * disk, so it never accumulates in memory.
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { Readable, type Writable } from 'node:stream';

import type { KaosProcess } from '@moonshot-ai/kaos';
import { join } from 'pathe';
import { describe, expect, it, vi } from 'vitest';

import { ProcessBackgroundTask } from '../../../src/agent/background';
import { createBackgroundManager, waitForTerminal } from './helpers';

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

describe('BackgroundManager — foreground output ceiling', () => {
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

  it('does not terminate a detached (background) task for the same output', async () => {
    const { manager } = createBackgroundManager();
    const chunks = Array.from({ length: 20 }, () => 'x'.repeat(MiB));
    const { proc, kill } = streamingProcess(chunks);

    const taskId = manager.registerTask(new ProcessBackgroundTask(proc, 'producer', 'bg'), {
      detached: true,
      timeoutMs: 60_000,
    });

    const info = await waitForTerminal(manager, taskId);

    expect(info?.status).toBe('completed');
    expect(kill).not.toHaveBeenCalledWith('SIGTERM');
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
});

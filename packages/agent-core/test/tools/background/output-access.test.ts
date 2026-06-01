/**
 * BackgroundManager — output retrieval surface.
 *
 * Covers the two methods consumed by the `/tasks` UI:
 *   - `readOutput(taskId, tail?)` reads the persisted
 *     `<sessionDir>/tasks/<id>/output.log` first so callers are not
 *     limited by the in-memory ring buffer.
 *   - `getOutputPath(taskId)` returns the absolute path when the
 *     persisted output log exists so callers can hand it to a pager.
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'pathe';
import { Readable } from 'node:stream';
import type { Writable } from 'node:stream';

import type { KaosProcess } from '@moonshot-ai/kaos';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { BackgroundManager } from '../../../src/agent/background';
import { appendTaskOutput } from '../../../src/agent/background/persist';

function immediateProcess(exitCode: number, stdoutText = ''): KaosProcess {
  return {
    stdin: { write: vi.fn(), end: vi.fn() } as unknown as Writable,
    stdout: Readable.from(stdoutText ? [stdoutText] : []),
    stderr: Readable.from([]),
    pid: 50000 + exitCode,
    exitCode,
    wait: vi.fn().mockResolvedValue(exitCode) as KaosProcess['wait'],
    kill: vi.fn().mockResolvedValue(undefined) as KaosProcess['kill'],
  };
}

async function waitForLiveOutput(
  manager: BackgroundManager,
  taskId: string,
  expected: string,
): Promise<void> {
  for (let i = 0; i < 20; i++) {
    if (manager.getOutput(taskId).includes(expected)) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(`Timed out waiting for live output: ${expected}`);
}

describe('BackgroundManager — readOutput / getOutputPath', () => {
  let sessionDir: string;
  let manager: BackgroundManager;

  beforeEach(() => {
    sessionDir = mkdtempSync(join(tmpdir(), 'bpm-output-'));
    manager = new BackgroundManager();
    manager.attachSessionDir(sessionDir);
  });

  afterEach(() => {
    manager._reset();
    rmSync(sessionDir, { recursive: true, force: true });
  });

  it('getOutputPath returns <sessionDir>/tasks/<id>/output.log when persisted output exists', async () => {
    const taskId = manager.register(immediateProcess(0, 'hello\n'), 'echo', 'demo');
    await waitForLiveOutput(manager, taskId, 'hello');
    await manager.flushOutput(taskId);

    const path = manager.getOutputPath(taskId);
    expect(path).toBeDefined();
    expect(path).toContain(sessionDir);
    expect(path).toContain(taskId);
    expect(path!.endsWith('output.log')).toBe(true);
  });

  it('getOutputPath returns undefined when no persisted log file exists', async () => {
    const taskId = manager.register(immediateProcess(0), 'sleep 1', 'silent task');
    await manager.wait(taskId);
    await manager.flushOutput(taskId);

    expect(manager.getOutputPath(taskId)).toBeUndefined();
  });

  it('getOutputPath returns undefined for unknown task ids', () => {
    expect(manager.getOutputPath('bash-deadbeef')).toBeUndefined();
  });

  it('readOutput returns live ring-buffer content while task is in memory', async () => {
    const taskId = manager.register(immediateProcess(0, 'live content\n'), 'echo', 'demo');
    await new Promise((r) => setTimeout(r, 30));
    const out = await manager.readOutput(taskId);
    expect(out).toContain('live content');
  });

  it('readOutput prefers disk over the live ring buffer when persisted output exists', async () => {
    const taskId = manager.register(immediateProcess(0, 'ring-only\n'), 'echo', 'demo');
    await waitForLiveOutput(manager, taskId, 'ring-only');
    await appendTaskOutput(sessionDir, taskId, 'disk-only\n');

    const out = await manager.readOutput(taskId);

    expect(out).toContain('disk-only');
  });

  it('readOutput falls back to disk for ghost (reconciled lost) tasks', async () => {
    // Stage 1: live manager appends output to disk.
    // Wait deterministically: `manager.wait` resolves only after
    // `persistWriteQueue` drains (so `task.json` is on disk), and
    // `flushOutput` drains `outputWriteQueue` (so `output.log` is too).
    // Sleeping 30ms here was flaky on slow CI disks — `task.json` might
    // still be in flight when the fresh manager scans the session dir,
    // and a missing ghost makes readOutput return ''.
    const taskId = manager.register(immediateProcess(0, 'persisted line\n'), 'echo', 'demo');
    await manager.wait(taskId);
    await manager.flushOutput(taskId);
    expect((await manager.readOutput(taskId)).length).toBeGreaterThan(0);

    // Stage 2: simulate a fresh restart — new manager, same sessionDir.
    const fresh = new BackgroundManager();
    fresh.attachSessionDir(sessionDir);
    await fresh.loadFromDisk();
    await fresh.reconcile();

    // The reloaded task is a ghost (terminal); the in-memory ring buffer
    // is empty but readOutput should still find the disk log.
    const recovered = await fresh.readOutput(taskId);
    expect(recovered).toContain('persisted line');
    fresh._reset();
  });

  it('readOutput respects tail length', async () => {
    const taskId = manager.register(
      immediateProcess(0, 'aaaaa-bbbbb-ccccc-ddddd'),
      'echo',
      'demo',
    );
    await new Promise((r) => setTimeout(r, 30));
    const tail = await manager.readOutput(taskId, 5);
    expect(tail.length).toBeLessThanOrEqual(5);
    expect(tail).toBe('ddddd');
  });
});

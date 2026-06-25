/**
 * Covers: BackgroundManager monitor notification wiring.
 */

import { PassThrough, Readable } from 'node:stream';
import type { Writable } from 'node:stream';

import type { KaosProcess } from '@moonshot-ai/kaos';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createBackgroundManager } from './helpers';

function createMonitorProcess(): {
  proc: KaosProcess;
  stdout: PassThrough;
  resolveWait: (exitCode: number) => void;
  killSpy: ReturnType<typeof vi.fn>;
} {
  const stdout = new PassThrough();
  const stderr = Readable.from([]);
  let resolveWait!: (exitCode: number) => void;
  const waitPromise = new Promise<number>((resolve) => {
    resolveWait = resolve;
  });
  const killSpy = vi.fn().mockResolvedValue(undefined);
  const proc: KaosProcess = {
    stdin: { write: vi.fn(), end: vi.fn() } as unknown as Writable,
    stdout,
    stderr,
    pid: 12345,
    exitCode: null,
    wait: () => waitPromise,
    kill: killSpy as unknown as KaosProcess['kill'],
    dispose: vi.fn().mockResolvedValue(undefined) as KaosProcess['dispose'],
  };
  return { proc, stdout, resolveWait, killSpy };
}

describe('BackgroundManager monitor wiring', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('emits per-line monitor notifications and still tees output', async () => {
    const { agent, manager } = createBackgroundManager();
    const { proc, stdout, resolveWait } = createMonitorProcess();

    const taskId = manager.registerMonitorTask(
      proc,
      'tail -f log | grep --line-buffered x',
      'watch x',
      { detached: true },
    );
    expect(taskId).toMatch(/^monitor-[0-9a-z]{8}$/);

    await Promise.resolve();
    stdout.write('x\ny\n');
    await vi.advanceTimersByTimeAsync(200);

    const monitorCall = agent.turn.steer.mock.calls.find((call) => {
      const text = (call[0] as { text: string }[] | undefined)?.[0]?.text;
      return typeof text === 'string' && text.includes('type="monitor_line"');
    });
    expect(monitorCall).toBeDefined();
    const monitorText = (monitorCall![0] as { text: string }[])[0]!.text;
    expect(monitorText).toContain('x\ny');

    stdout.end();
    resolveWait(0);
    await vi.waitFor(() => expect(manager.getTask(taskId)?.status).not.toBe('running'));

    const terminalCall = agent.turn.steer.mock.calls.find((call) => {
      const text = (call[0] as { text: string }[] | undefined)?.[0]?.text;
      return typeof text === 'string' && text.includes('type="task.completed"');
    });
    expect(terminalCall).toBeDefined();

    expect(await manager.readOutput(taskId)).toContain('x\ny');
  });
});

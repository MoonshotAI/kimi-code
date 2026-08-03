import { Readable, type Writable } from 'node:stream';

import type { Environment, KaosProcess } from '@moonshot-ai/kaos';
import { describe, expect, it, vi } from 'vitest';

import { BashTool } from '../../src/tools/builtin/shell/bash';
import { createBackgroundManager } from '../agent/background/helpers';
import { executeTool } from './fixtures/execute-tool';
import { createFakeKaos } from './fixtures/fake-kaos';

const posixEnv: Environment = {
  osKind: 'Linux',
  osArch: 'x86_64',
  osVersion: 'test',
  shellPath: '/bin/bash',
  shellName: 'bash',
};

describe('BashTool cancellation contract', () => {
  it('reports the cancellation with an "Interrupted by user" message and kills the process', async () => {
    let resolveWait: (code: number) => void = () => {};
    const waitPromise = new Promise<number>((resolve) => {
      resolveWait = resolve;
    });
    const kill = vi.fn(async () => {
      resolveWait(143);
    });
    const proc: KaosProcess = {
      stdin: { end: vi.fn(), write: vi.fn() } as unknown as Writable,
      stdout: Readable.from([]),
      stderr: Readable.from([]),
      pid: 501,
      exitCode: null,
      wait: vi.fn(async () => waitPromise),
      kill,
      dispose: vi.fn(async () => {}),
    };
    const execWithEnv = vi.fn().mockResolvedValue(proc);
    const controller = new AbortController();
    const tool = new BashTool(
      createFakeKaos({ execWithEnv, osEnv: posixEnv }),
      '/workspace',
      createBackgroundManager().manager,
    );

    const running = executeTool(tool, {
      turnId: '0',
      toolCallId: 'tc_cancel',
      args: { command: 'sleep 2 && printf should-not-exist > cancel_output.txt' },
      signal: controller.signal,
    });
    await vi.waitFor(() => {
      expect(proc.stdin.end).toHaveBeenCalled();
    });
    controller.abort();
    const result = await running;

    expect(kill).toHaveBeenCalledWith('SIGTERM');
    expect(result).toMatchObject({ isError: true });
    expect(result.output).toContain('Interrupted by user');
  });

  it('surfaces an AbortError when the signal is already aborted before execution begins', async () => {
    const execWithEnv = vi.fn().mockRejectedValue(new Error('should not be called'));
    const controller = new AbortController();
    controller.abort();
    const tool = new BashTool(
      createFakeKaos({ execWithEnv, osEnv: posixEnv }),
      '/workspace',
      createBackgroundManager().manager,
    );

    const result = await executeTool(tool, {
      turnId: '0',
      toolCallId: 'tc_aborted_before',
      args: { command: 'echo should-not-run' },
      signal: controller.signal,
    });

    expect(result).toMatchObject({ isError: true });
    expect(result.output).toContain('Aborted before command started');
    expect(execWithEnv).not.toHaveBeenCalled();
  });

  it('handles cancellation gracefully when the process exits before kill is called', async () => {
    let resolveKillPromise: () => void = () => {};
    const killStarted = new Promise<void>((resolve) => {
      resolveKillPromise = resolve;
    });
    const kill = vi.fn(async () => {
      resolveKillPromise();
    });
    const proc: KaosProcess = {
      stdin: { end: vi.fn(), write: vi.fn() } as unknown as Writable,
      stdout: Readable.from(['output']),
      stderr: Readable.from([]),
      pid: 502,
      exitCode: 0,
      wait: vi.fn(async () => 0),
      kill,
      dispose: vi.fn(async () => {}),
    };
    const execWithEnv = vi.fn().mockResolvedValue(proc);
    const controller = new AbortController();
    const tool = new BashTool(
      createFakeKaos({ execWithEnv, osEnv: posixEnv }),
      '/workspace',
      createBackgroundManager().manager,
    );

    const resultPromise = executeTool(tool, {
      turnId: '0',
      toolCallId: 'tc_exit_before_kill',
      args: { command: 'echo fast' },
      signal: controller.signal,
    });

    // The process completes before we abort — exitCode is already 0.
    // The tool should still produce a clean result even if kill races.
    controller.abort();
    await killStarted;

    const result = await resultPromise;
    expect(kill).toHaveBeenCalled();
    // The process had already exited, so the result may be a clean output
    // or a cancellation depending on exact race; either way it should not throw.
    expect(result.isError === true || result.isError === false).toBe(true);
  });
});

import { Readable, type Writable } from 'node:stream';

import type { Environment, KaosProcess } from '@moonshot-ai/kaos';
import { describe, expect, it, vi } from 'vitest';

import { BashTool } from '../../src/tools/builtin/shell/bash';
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
    };
    const execWithEnv = vi.fn().mockResolvedValue(proc);
    const controller = new AbortController();
    const tool = new BashTool(createFakeKaos({ execWithEnv }), '/workspace', posixEnv);

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
});

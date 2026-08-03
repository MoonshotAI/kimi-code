/**
 * Windows-only: default Node `kill` does not stop the whole process tree, so
 * background Bash can leave orphaned child processes. Once tree kill lands
 * (e.g. `taskkill /T`), assert grandchildren are reaped within the grace window.
 */
import { describe, expect, it, vi } from 'vitest';

import { BashTool } from '../../src/tools/builtin/shell/bash';
import { createBackgroundManager } from '../agent/background/helpers';
import { executeTool } from './fixtures/execute-tool';
import { createFakeKaos } from './fixtures/fake-kaos';
import { Readable, type Writable } from 'node:stream';
import type { KaosProcess } from '@moonshot-ai/kaos';

const signal = new AbortController().signal;

function fakeProcess(): KaosProcess {
  return {
    stdin: { end: vi.fn(), write: vi.fn() } as unknown as Writable,
    stdout: Readable.from([]),
    stderr: Readable.from([]),
    pid: 401,
    exitCode: 0,
    wait: vi.fn(async () => 0),
    kill: vi.fn(async () => {}),
    dispose: vi.fn(async () => {}),
  };
}

describe.skipIf(process.platform !== 'win32')('BashTool background — Windows kill tree', () => {
  it.todo('stop() terminates grandchild processes via taskkill /T');

  it('invokes kill on the spawned process when aborted mid-flight', async () => {
    const proc = fakeProcess();
    const execWithEnv = vi.fn().mockResolvedValue(proc);
    const controller = new AbortController();
    const tool = new BashTool(
      createFakeKaos({
        execWithEnv,
        osEnv: {
          osKind: 'Windows',
          osArch: 'x64',
          osVersion: 'test',
          shellPath: 'C:\\Program Files\\Git\\bin\\bash.exe',
          shellName: 'bash',
        },
      }),
      'C:\\Users\\me\\project',
      createBackgroundManager().manager,
    );

    const running = executeTool(tool, {
      turnId: '0',
      toolCallId: 'call_kill',
      args: { command: 'sleep 10', timeout: 60 },
      signal: controller.signal,
    });
    await vi.waitFor(() => {
      expect(proc.stdin.end).toHaveBeenCalled();
    });
    controller.abort();
    const result = await running;

    expect(proc.kill).toHaveBeenCalledWith('SIGTERM');
    expect(result).toMatchObject({ isError: true });
  });
});
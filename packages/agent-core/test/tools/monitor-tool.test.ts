/**
 * Covers: MonitorTool.
 */

import { Readable } from 'node:stream';
import type { Writable } from 'node:stream';

import type { Kaos, KaosProcess } from '@moonshot-ai/kaos';
import { describe, expect, it, vi } from 'vitest';

import type { BackgroundManager } from '../../src/agent/background';
import type { RunnableToolExecution } from '../../src/loop/types';
import { MonitorTool } from '../../src/tools/background/monitor';

function fakeKaos(proc: KaosProcess): Kaos {
  return {
    osEnv: {
      shellPath: '/bin/bash',
      shellName: 'bash',
      osKind: 'Linux',
    },
    execWithEnv: vi.fn().mockResolvedValue(proc),
  } as unknown as Kaos;
}

function fakeProcess(): KaosProcess {
  return {
    stdin: { write: vi.fn(), end: vi.fn() } as unknown as Writable,
    stdout: Readable.from([]),
    stderr: Readable.from([]),
    pid: 12345,
    exitCode: null,
    wait: vi.fn().mockResolvedValue(0),
    kill: vi.fn().mockResolvedValue(undefined),
    dispose: vi.fn().mockResolvedValue(undefined),
  };
}

function fakeBackgroundManager(taskId = 'monitor-test123'): BackgroundManager {
  return {
    registerMonitorTask: vi.fn().mockReturnValue(taskId),
  } as unknown as BackgroundManager;
}

describe('MonitorTool', () => {
  it('registers a detached monitor task and returns its task id', async () => {
    const proc = fakeProcess();
    const kaos = fakeKaos(proc);
    const background = fakeBackgroundManager();
    const tool = new MonitorTool(kaos, '/workspace', background);

    const execution = tool.resolveExecution({
      command: 'tail -f log.txt | grep --line-buffered ERROR',
      description: 'watch errors',
      timeout_ms: 300000,
      persistent: false,
    });

    const result = await (execution as RunnableToolExecution).execute({
      turnId: 'turn-1',
      toolCallId: 'call-1',
      signal: new AbortController().signal,
    });

    expect(result.isError).toBe(false);
    expect(result.output).toContain('task_id: monitor-test123');
    expect(result.output).toContain('persistent: false');
    expect(background.registerMonitorTask).toHaveBeenCalledWith(
      proc,
      'tail -f log.txt | grep --line-buffered ERROR',
      'watch errors',
      { detached: true, timeoutMs: 300000 },
    );
  });

  it('passes undefined timeout for persistent monitors', async () => {
    const proc = fakeProcess();
    const kaos = fakeKaos(proc);
    const background = fakeBackgroundManager('monitor-persist');
    const tool = new MonitorTool(kaos, '/workspace', background);

    const execution = tool.resolveExecution({
      command: 'tail -F app.log',
      description: 'watch log',
      timeout_ms: 300000,
      persistent: true,
    });

    const result = await (execution as RunnableToolExecution).execute({
      turnId: 'turn-1',
      toolCallId: 'call-1',
      signal: new AbortController().signal,
    });

    expect(result.isError).toBe(false);
    expect(result.output).toContain('persistent: true');
    expect(background.registerMonitorTask).toHaveBeenCalledWith(
      proc,
      'tail -F app.log',
      'watch log',
      { detached: true, timeoutMs: undefined },
    );
  });
});

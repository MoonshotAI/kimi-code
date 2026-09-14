import { Readable } from 'node:stream';
import type { Writable } from 'node:stream';

import type { IHostProcess } from '#/os/interface/hostProcess';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  IAgentTaskService,
} from '#/agent/task/task';
import { taskStorageKey } from '#/agent/task/persist';
import {
  SubagentTask,
  type SubagentHandle,
} from '#/agent/tools/agent/subagent-task';
import { ProcessTask } from '#/agent/tools/os/bash/process-task';
import { createTestAgent, type TestAgentContext } from '../../harness';

function registerProcess(
  manager: IAgentTaskService,
  proc: IHostProcess,
  command: string,
  description: string,
): string {
  return manager.registerTask(new ProcessTask(proc, command, description, undefined, undefined, 'call_process'));
}

function agentTask(
  completion: Promise<{ result: string }>,
  description: string,
): SubagentTask {
  const handle: SubagentHandle = {
    agentId: 'agent-child',
    profileName: 'coder',
    parentToolCallId: 'call_agent',
    completion,
  };
  return new SubagentTask(
    handle,
    description,
    new AbortController(),
  );
}

function pendingProcess(): IHostProcess & { resolve(code: number): void } {
  let resolveWait: (code: number) => void = () => {};
  const waitPromise = new Promise<number>((resolve) => {
    resolveWait = resolve;
  });
  let currentExitCode: number | null = null;
  return {
    _serviceBrand: undefined,
    stdin: { write: vi.fn(), end: vi.fn() } as unknown as Writable,
    stdout: Readable.from([]),
    stderr: Readable.from([]),
    pid: 54321,
    get exitCode(): number | null {
      return currentExitCode;
    },
    wait: () => waitPromise,
    kill: vi.fn().mockResolvedValue(undefined) as IHostProcess['kill'],
    dispose: vi.fn().mockResolvedValue(undefined) as IHostProcess['dispose'],
    resolve(code: number): void {
      currentExitCode = code;
      resolveWait(code);
    },
  };
}

describe('background task id format', () => {
  let ctx: TestAgentContext;
  let background: IAgentTaskService;

  beforeEach(() => {
    ctx = createTestAgent();
    background = ctx.get(IAgentTaskService);
  });

  afterEach(async () => {
    try {
      await ctx.expectResumeMatches();
    } finally {
      await ctx.dispose();
    }
  });

  it('uses the spawning tool call id as the process task id', async () => {
    const proc = pendingProcess();
    const id = registerProcess(background, proc, 'sleep 60', 'process task');

    expect(id).toBe('call_process');
    expect(background.getTask(id)).toMatchObject({ taskId: id, kind: 'process' });
    proc.resolve(0);
    await background.wait(id);
  });

  it('uses the spawning tool call id as the agent task id', async () => {
    let resolveCompletion!: (value: { result: string }) => void;
    const completion = new Promise<{ result: string }>((resolve) => {
      resolveCompletion = resolve;
    });
    const id = background.registerTask(
      agentTask(completion, 'agent task'),
    );

    expect(id).toBe('call_agent');
    expect(background.getTask(id)).toMatchObject({ taskId: id, kind: 'agent' });
    resolveCompletion({ result: 'done' });
    await background.wait(id);
  });

  it('derives bounded portable storage keys for path-unsafe ids', () => {
    expect(taskStorageKey('call_abc-DEF_123')).toBe('call_abc-DEF_123');
    expect(taskStorageKey('Bash:21')).toBe('enc~%42ash%3A21');
    expect(taskStorageKey('bash:21')).toBe('enc~bash%3A21');
    expect(taskStorageKey('CON')).toBe('enc~%43%4F%4E');
    expect(taskStorageKey('com1')).toBe('enc~com1');
    expect(taskStorageKey('..')).toBe('enc~%2E%2E');
    expect(taskStorageKey('../escape')).toBe('enc~%2E%2E%2Fescape');
    expect(taskStorageKey('a\\b')).toBe('enc~a%5Cb');
    expect(taskStorageKey('a\0b')).toBe('enc~a%00b');
    expect(taskStorageKey('任务')).toBe('enc~%u4EFB%u52A1');
    expect(taskStorageKey('\uD800')).toBe('enc~%uD800');
    expect(taskStorageKey('\uDC00')).toBe('enc~%uDC00');
    expect(taskStorageKey('\uFFFD')).toBe('enc~%uFFFD');
    const longId = 'x'.repeat(100);
    const key = taskStorageKey(longId);
    expect(key).toMatch(/^enc~x{40}~[0-9a-f]{16}$/);
    expect(taskStorageKey(longId)).toBe(key);
  });
});

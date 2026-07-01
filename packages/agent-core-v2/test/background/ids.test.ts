import { Readable } from 'node:stream';
import type { Writable } from 'node:stream';

import type { IProcess } from '#/session/process';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  AgentBackgroundTask,
  IAgentBackgroundService,
  ProcessBackgroundTask,
} from '#/agent/background';
import type { SubagentDetachHandle } from '#/agent/background';
import type { SubagentHandle } from '#/agent/agentTool';
import { createTestAgent, type TestAgentContext } from '../harness';
import { createBackgroundTaskPersistence } from './stubs';

function registerProcess(
  manager: IAgentBackgroundService,
  proc: IProcess,
  command: string,
  description: string,
): string {
  return manager.registerTask(new ProcessBackgroundTask(proc, command, description));
}

function agentTask(
  completion: Promise<{ result: string }>,
  description: string,
): AgentBackgroundTask {
  const handle: SubagentHandle = {
    agentId: 'agent-child',
    profileName: 'coder',
    resumed: false,
    completion,
  };
  return new AgentBackgroundTask(
    handle,
    description,
    { markActiveChildDetached: vi.fn() } as unknown as Pick<
      SubagentDetachHandle,
      'markActiveChildDetached'
    >,
    new AbortController(),
  );
}

function pendingProcess(): IProcess & { resolve(code: number): void } {
  let resolveWait: (code: number) => void = () => {};
  const waitPromise = new Promise<number>((resolve) => {
    resolveWait = resolve;
  });
  let currentExitCode: number | null = null;
  return {
    stdin: { write: vi.fn(), end: vi.fn() } as unknown as Writable,
    stdout: Readable.from([]),
    stderr: Readable.from([]),
    pid: 54321,
    get exitCode(): number | null {
      return currentExitCode;
    },
    wait: () => waitPromise,
    kill: vi.fn().mockResolvedValue(undefined) as IProcess['kill'],
    dispose: vi.fn().mockResolvedValue(undefined) as IProcess['dispose'],
    resolve(code: number): void {
      currentExitCode = code;
      resolveWait(code);
    },
  };
}

describe('background task id format', () => {
  let ctx: TestAgentContext;
  let background: IAgentBackgroundService;

  beforeEach(() => {
    ctx = createTestAgent();
    background = ctx.get(IAgentBackgroundService);
  });

  afterEach(async () => {
    try {
      await ctx.expectResumeMatches();
    } finally {
      await ctx.dispose();
    }
  });

  it('assigns bash-prefixed ids to process tasks', async () => {
    const proc = pendingProcess();
    const id = registerProcess(background, proc, 'sleep 60', 'process task');

    expect(id).toMatch(/^bash-[0-9a-z]{8}$/);
    expect(background.getTask(id)).toMatchObject({ taskId: id, kind: 'process' });
    proc.resolve(0);
    await background.wait(id);
  });

  it('assigns agent-prefixed ids to agent tasks', async () => {
    let resolveCompletion!: (value: { result: string }) => void;
    const completion = new Promise<{ result: string }>((resolve) => {
      resolveCompletion = resolve;
    });
    const id = background.registerTask(
      agentTask(completion, 'agent task'),
    );

    expect(id).toMatch(/^agent-[0-9a-z]{8}$/);
    expect(background.getTask(id)).toMatchObject({ taskId: id, kind: 'agent' });
    resolveCompletion({ result: 'done' });
    await background.wait(id);
  });

  it('rejects malformed ids at the persistence path boundary', () => {
    const persistence = createBackgroundTaskPersistence('/tmp/kimi-bg-id-test');
    const rejected = [
      '',
      'x',
      '-bash',
      'BASH-12345678',
      'bash_12345678',
      '../escape',
      'bash-1234567',
      'bash-123456789',
      'agent-ABCDEFGH',
      'bg_12345678',
      'a'.repeat(26),
    ];

    for (const bad of rejected) {
      expect(() => persistence.taskOutputFile(bad)).toThrow(/Invalid task id/);
    }
  });
});

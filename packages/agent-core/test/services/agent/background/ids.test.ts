import { Readable } from 'node:stream';
import type { Writable } from 'node:stream';

import type { KaosProcess } from '@moonshot-ai/kaos';
import { describe, expect, it, vi } from 'vitest';

import {
  AgentBackgroundTask,
  BackgroundTaskPersistence,
  type IBackgroundService,
  ProcessBackgroundTask,
} from '../../../../src/services/agent/background/background';
import type { SessionSubagentHost, SubagentHandle } from '../../../../src/session/subagent-host';
import { testAgent } from '../harness';

function registerProcess(
  manager: IBackgroundService,
  proc: KaosProcess,
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
      SessionSubagentHost,
      'markActiveChildDetached'
    >,
    new AbortController(),
  );
}

function pendingProcess(): KaosProcess {
  return {
    stdin: { write: vi.fn(), end: vi.fn() } as unknown as Writable,
    stdout: Readable.from([]),
    stderr: Readable.from([]),
    pid: 54321,
    exitCode: null,
    wait: () => new Promise<number>(() => {}),
    kill: vi.fn().mockResolvedValue(undefined) as KaosProcess['kill'],
    dispose: vi.fn().mockResolvedValue(undefined) as KaosProcess['dispose'],
  };
}

describe('background task id format', () => {
  it('assigns bash-prefixed ids to process tasks', () => {
    const manager = testAgent().background;
    const id = registerProcess(manager, pendingProcess(), 'sleep 60', 'process task');

    expect(id).toMatch(/^bash-[0-9a-z]{8}$/);
    expect(manager.getTask(id)).toMatchObject({ taskId: id, kind: 'process' });
  });

  it('assigns agent-prefixed ids to agent tasks', () => {
    const manager = testAgent().background;
    const id = manager.registerTask(
      agentTask(new Promise(() => {}), 'agent task'),
    );

    expect(id).toMatch(/^agent-[0-9a-z]{8}$/);
    expect(manager.getTask(id)).toMatchObject({ taskId: id, kind: 'agent' });
  });

  it('rejects malformed ids at the persistence path boundary', () => {
    const persistence = new BackgroundTaskPersistence('/tmp/kimi-bg-id-test');
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

import type { BackgroundTaskInfo } from '@moonshot-ai/kimi-code-sdk';
import { describe, expect, it } from 'vitest';

import { pickForegroundTask, pickForegroundTasks } from '@/tui/utils/foreground-task';

function task(overrides: Partial<BackgroundTaskInfo> = {}): BackgroundTaskInfo {
  return {
    taskId: 'bash-aaaaaaaa',
    kind: 'process',
    command: 'sleep 10',
    description: 'Bash: sleep 10',
    status: 'running',
    detached: false,
    pid: 1234,
    exitCode: null,
    startedAt: 1000,
    endedAt: null,
    ...overrides,
  } as BackgroundTaskInfo;
}

describe('pickForegroundTask', () => {
  it('returns undefined for an empty list', () => {
    expect(pickForegroundTask([])).toBeUndefined();
  });

  it('returns undefined when all tasks are detached (already background)', () => {
    expect(pickForegroundTask([task({ detached: true })])).toBeUndefined();
  });

  it('returns undefined when foreground tasks are not running', () => {
    expect(pickForegroundTask([task({ status: 'completed' })])).toBeUndefined();
    expect(pickForegroundTask([task({ status: 'killed' })])).toBeUndefined();
  });

  it('excludes question tasks', () => {
    const question = task({
      kind: 'question',
      questionCount: 1,
    } as Partial<BackgroundTaskInfo>);
    expect(pickForegroundTask([question])).toBeUndefined();
  });

  it('returns the most recently started foreground running task', () => {
    const older = task({ taskId: 'bash-old', startedAt: 1000 });
    const newer = task({ taskId: 'bash-new', startedAt: 2000 });
    expect(pickForegroundTask([older, newer])?.taskId).toBe('bash-new');
  });

  it('ignores detached running tasks even if newer', () => {
    const fg = task({ taskId: 'bash-fg', detached: false, startedAt: 1000 });
    const bg = task({ taskId: 'bash-bg', detached: true, startedAt: 9999 });
    expect(pickForegroundTask([bg, fg])?.taskId).toBe('bash-fg');
  });

  it('accepts agent (subagent) foreground tasks', () => {
    const agent = task({
      taskId: 'agent-aaaaaaaa',
      kind: 'agent',
      agentId: 'child-1',
      subagentType: 'coder',
    } as Partial<BackgroundTaskInfo>);
    expect(pickForegroundTask([agent])?.taskId).toBe('agent-aaaaaaaa');
  });
});

describe('pickForegroundTasks', () => {
  it('returns all foreground running tasks, most recently started first', () => {
    const a = task({ taskId: 'bash-a', startedAt: 1000 });
    const b = task({ taskId: 'agent-b', kind: 'agent', startedAt: 3000 });
    const c = task({ taskId: 'bash-c', startedAt: 2000 });
    expect(pickForegroundTasks([a, b, c]).map((t) => t.taskId)).toEqual([
      'agent-b',
      'bash-c',
      'bash-a',
    ]);
  });

  it('excludes detached, terminal, and question tasks', () => {
    const fg = task({ taskId: 'bash-fg' });
    const detached = task({ taskId: 'bash-bg', detached: true });
    const done = task({ taskId: 'bash-done', status: 'completed' });
    const question = task({ taskId: 'q', kind: 'question' } as Partial<BackgroundTaskInfo>);
    expect(pickForegroundTasks([fg, detached, done, question]).map((t) => t.taskId)).toEqual([
      'bash-fg',
    ]);
  });

  it('returns an empty array when nothing matches', () => {
    expect(pickForegroundTasks([task({ detached: true })])).toEqual([]);
  });
});

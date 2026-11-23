import { beforeEach, describe, expect, it } from 'vitest';
import type { SessionTask } from '@moonshot-ai/app-core/api';

import { tasksStore } from '../src/stores/tasks';

function makeTask(taskId: string, overrides: Partial<SessionTask> = {}): SessionTask {
  return { taskId, kind: 'shell', state: 'running', detached: true, ...overrides };
}

beforeEach(() => {
  tasksStore().resetTasks();
});

describe('tasksStore task table', () => {
  it('appends new tasks and replaces known ones per session and agent', () => {
    const store = tasksStore();

    store.upsertTask('s1', 'main', makeTask('t1'));
    store.upsertTask('s1', 'main', makeTask('t2'));
    store.upsertTask('s1', 'agent-1', makeTask('t3'));
    store.upsertTask('s1', 'main', makeTask('t1', { state: 'completed' }));

    expect(store.tasksOf('s1', 'main').map((task) => [task.taskId, task.state])).toEqual([
      ['t1', 'completed'],
      ['t2', 'running'],
    ]);
    expect(store.tasksOf('s1', 'agent-1').map((task) => task.taskId)).toEqual(['t3']);
    expect(store.tasksOf('s2', 'main')).toEqual([]);
  });

  it('keeps the list identity when a resent task has not changed', () => {
    const store = tasksStore();
    store.upsertTask('s1', 'main', makeTask('t1', { resultSummary: 'done' }));
    const before = store.tasksOf('s1', 'main');

    store.upsertTask('s1', 'main', makeTask('t1', { resultSummary: 'done' }));
    expect(store.tasksOf('s1', 'main')).toBe(before);

    store.upsertTask('s1', 'main', makeTask('t1', { resultSummary: 'done again' }));
    expect(store.tasksOf('s1', 'main')).not.toBe(before);
  });

  it('returns a stable empty list for unknown agents', () => {
    const store = tasksStore();
    expect(store.tasksOf('s1', 'main')).toBe(store.tasksOf('s2', 'agent-1'));
  });
});

describe('tasksStore forgetSessionTasks / resetTasks', () => {
  it('clears the tasks of one session', () => {
    const store = tasksStore();
    store.upsertTask('s1', 'main', makeTask('t1'));
    store.upsertTask('s2', 'main', makeTask('t2'));

    store.forgetSessionTasks('s1');

    expect(store.tasksOf('s1', 'main')).toEqual([]);
    expect(store.tasksOf('s2', 'main')).toHaveLength(1);
  });

  it('resets the table and the pending sets', () => {
    const store = tasksStore();
    store.upsertTask('s1', 'main', makeTask('t1'));
    store.pendingTaskCancellations = { t1: true };
    store.pendingTaskDetachments = { c1: true };

    store.resetTasks();

    expect(store.tasksBySession).toEqual({});
    expect(store.pendingTaskCancellations).toEqual({});
    expect(store.pendingTaskDetachments).toEqual({});
  });
});

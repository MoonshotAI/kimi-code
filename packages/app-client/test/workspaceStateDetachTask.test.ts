import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { KimiEventConnection, SessionTask, TaskCommandResult } from '@moonshot-ai/app-core/api';
import { setEventConn } from '../src/stores/connection';
import { sessionsStore } from '../src/stores/sessions';
import { setTasksHooks, tasksStore } from '../src/stores/tasks';

const connection = {
  backgroundTask: vi.fn<KimiEventConnection['backgroundTask']>(),
};

const pushOperationFailure = vi.fn();

beforeEach(() => {
  connection.backgroundTask.mockReset().mockResolvedValue({ code: 0 });
  pushOperationFailure.mockReset();
  sessionsStore().setActiveSessionId('s1');
  tasksStore().resetTasks();
  setTasksHooks({ pushOperationFailure });
  setEventConn(connection as unknown as KimiEventConnection);
});

afterEach(() => {
  setEventConn(null);
  setTasksHooks(null);
});

function shell(taskId: string, overrides: Partial<SessionTask>): SessionTask {
  return { taskId, kind: 'shell', state: 'running', detached: false, ...overrides };
}

describe('detachTask', () => {
  it('moves the running foreground task of the tool call to the background', async () => {
    tasksStore().replaceRunningTasks('s1', 'main', [
      shell('other-task', { parentToolCallId: 'other-call' }),
      shell('bash-1', { parentToolCallId: 'call-1' }),
    ]);

    await tasksStore().detachTask('call-1');

    expect(connection.backgroundTask).toHaveBeenCalledExactlyOnceWith('s1', 'main', 'bash-1');
    expect(tasksStore().pendingTaskDetachments['call-1']).toBeUndefined();
  });

  it('does nothing when no running foreground task matches the tool call', async () => {
    tasksStore().upsertTask('s1', 'main', shell('bash-1', { parentToolCallId: 'call-1', state: 'completed' }));
    tasksStore().upsertTask('s1', 'main', shell('bash-3', { parentToolCallId: 'call-3', detached: true }));

    await tasksStore().detachTask('call-1');
    await tasksStore().detachTask('call-3');
    await tasksStore().detachTask('call-unknown');

    expect(connection.backgroundTask).not.toHaveBeenCalled();
    expect(pushOperationFailure).not.toHaveBeenCalled();
  });

  it('drops a duplicate detach while the first is still in flight', async () => {
    tasksStore().upsertTask('s1', 'main', shell('bash-1', { parentToolCallId: 'call-1' }));
    let resolveDetach!: (value: TaskCommandResult) => void;
    connection.backgroundTask.mockReturnValue(new Promise((resolve) => { resolveDetach = resolve; }));

    const first = tasksStore().detachTask('call-1');
    await tasksStore().detachTask('call-1');
    expect(connection.backgroundTask).toHaveBeenCalledOnce();

    resolveDetach({ code: 0 });
    await first;
  });

  it('stays silent when the task is already gone (40406) and reports other failures', async () => {
    tasksStore().upsertTask('s1', 'main', shell('bash-1', { parentToolCallId: 'call-1' }));
    connection.backgroundTask.mockResolvedValueOnce({ code: 40406, msg: 'task not found' });
    await tasksStore().detachTask('call-1');
    expect(pushOperationFailure).not.toHaveBeenCalled();

    connection.backgroundTask.mockRejectedValueOnce(new Error('WebSocket closed'));
    await tasksStore().detachTask('call-1');
    expect(pushOperationFailure).toHaveBeenCalledOnce();
  });
});

describe('task list replacement', () => {
  it('keeps ended tasks it knows, drops running ones the list no longer has, and adds the rest', () => {
    tasksStore().upsertTask('s1', 'main', shell('done', { state: 'completed', detached: true }));
    tasksStore().upsertTask('s1', 'main', shell('vanished', { detached: true }));
    tasksStore().upsertTask('s1', 'main', shell('kept', { detached: true }));

    tasksStore().replaceRunningTasks('s1', 'main', [
      shell('kept', { detached: true, command: 'sleep 60' }),
      shell('new', {}),
    ]);

    expect(tasksStore().tasksOf('s1', 'main').map((task) => [task.taskId, task.state, task.command])).toEqual([
      ['done', 'completed', undefined],
      ['kept', 'running', 'sleep 60'],
      ['new', 'running', undefined],
    ]);
    expect(tasksStore().tasksOf('s1', 'agent-1')).toEqual([]);
  });
});

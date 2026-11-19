import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { KimiEventConnection, TaskCommandResult } from '@moonshot-ai/app-core/api';
import { setEventConn } from '../src/stores/connection';
import { sessionsStore } from '../src/stores/sessions';
import { setTasksHooks, tasksStore } from '../src/stores/tasks';

const connection = {
  stopTask: vi.fn<KimiEventConnection['stopTask']>(),
};

const pushOperationFailure = vi.fn();

beforeEach(() => {
  connection.stopTask.mockReset().mockResolvedValue({ code: 0 });
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

describe('cancelTask', () => {
  it('stops the task over the event connection and leaves its state to the task frames', async () => {
    tasksStore().upsertTask('s1', 'main', { taskId: 'bash-1', kind: 'shell', state: 'running', detached: true });

    await tasksStore().cancelTask('bash-1');

    expect(connection.stopTask).toHaveBeenCalledExactlyOnceWith('s1', 'main', 'bash-1');
    expect(tasksStore().tasksOf('s1', 'main')[0]?.state).toBe('running');
    expect(tasksStore().pendingTaskCancellations['bash-1']).toBeUndefined();
  });

  it('drops a duplicate cancel while the first is still in flight', async () => {
    let resolveStop!: (value: TaskCommandResult) => void;
    connection.stopTask.mockReturnValue(new Promise((resolve) => { resolveStop = resolve; }));

    const first = tasksStore().cancelTask('bash-1');
    await tasksStore().cancelTask('bash-1');
    expect(connection.stopTask).toHaveBeenCalledOnce();

    resolveStop({ code: 0 });
    await first;
  });

  it('stays silent when the task is already gone (40406)', async () => {
    connection.stopTask.mockResolvedValue({ code: 40406, msg: 'task not found' });

    await tasksStore().cancelTask('bash-1');

    expect(pushOperationFailure).not.toHaveBeenCalled();
  });

  it('reports other replies, transport failures and a missing connection', async () => {
    connection.stopTask.mockResolvedValueOnce({ code: 50001, msg: 'internal error' });
    await tasksStore().cancelTask('bash-1');
    connection.stopTask.mockRejectedValueOnce(new Error('WebSocket closed'));
    await tasksStore().cancelTask('bash-1');
    setEventConn(null);
    await tasksStore().cancelTask('bash-1');

    expect(pushOperationFailure).toHaveBeenCalledTimes(3);
    expect(pushOperationFailure.mock.calls.map(([, err]) => (err as Error).message)).toEqual([
      'internal error',
      'WebSocket closed',
      'WebSocket is not connected',
    ]);
  });
});

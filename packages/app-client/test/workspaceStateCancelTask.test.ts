import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { KimiWebApi } from '@moonshot-ai/app-core/api';
import { resetKimiClientDeps, setKimiClientDeps } from '../src/client/deps';
import { useWorkspaceState } from '../src/client/useWorkspaceState';

const t = (key: string) => key;

const apiMock = {
  cancelTask: vi.fn(),
};

beforeEach(() => {
  apiMock.cancelTask.mockReset().mockResolvedValue({ cancelled: true });
  setKimiClientDeps({
    api: () => apiMock as unknown as KimiWebApi,
    t,
  });
});

afterEach(() => {
  resetKimiClientDeps();
});

function createState(tasks: unknown[]) {
  const rawState = {
    activeSessionId: 's1',
    tasksBySession: { s1: tasks },
  };
  const ws = useWorkspaceState(rawState as never, {} as never);
  return { rawState, ws };
}

describe('cancelTask', () => {
  it('stamps the row that folded to its agent id while the request was in flight', async () => {
    const { rawState, ws } = createState([
      { id: 'task-9', kind: 'subagent', status: 'running', createdAt: '2026-01-01T00:00:00.000Z' },
    ]);
    rawState.tasksBySession.s1 = [
      {
        id: 'agent-1',
        kind: 'subagent',
        status: 'running',
        backgroundTaskId: 'task-9',
        createdAt: '2026-01-01T00:00:00.000Z',
      },
    ] as never;

    await ws.cancelTask('task-9');

    expect(rawState.tasksBySession.s1[0]).toMatchObject({ status: 'cancelled' });
  });

  it('does not stamp the row when it re-bound to a new task before the response landed', async () => {
    const { rawState, ws } = createState([
      {
        id: 'agent-1',
        kind: 'subagent',
        status: 'running',
        backgroundTaskId: 'task-9',
        createdAt: '2026-01-01T00:00:00.000Z',
      },
    ]);

    const pending = ws.cancelTask('agent-1');
    // The agent resumed and re-bound while the cancel request was in flight.
    rawState.tasksBySession = {
      ...rawState.tasksBySession,
      s1: [
        {
          id: 'agent-1',
          kind: 'subagent',
          status: 'running',
          backgroundTaskId: 'task-10',
          createdAt: '2026-01-01T00:00:00.000Z',
        },
      ] as never,
    };
    await pending;

    expect(rawState.tasksBySession.s1[0]).toMatchObject({ status: 'running' });
  });
});

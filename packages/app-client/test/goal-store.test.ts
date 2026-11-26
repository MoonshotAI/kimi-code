import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { AppGoal, AppSession, KimiWebApi } from '@moonshot-ai/app-core/api';
import { DaemonApiError } from '@moonshot-ai/app-core/api';
import { resetKimiClientDeps, setKimiClientDeps } from '../src/client/deps';
import { goalStore, setGoalHooks, goalErrorMessage } from '../src/stores/goal';
import { modeStore } from '../src/stores/mode';
import { sessionsStore } from '../src/stores/sessions';
import { permissionsStore } from '../src/stores/permissions';
import { workspacesStore } from '../src/stores/workspaces';

function makeGoal(status: string): AppGoal {
  return { objective: 'obj', status, turnsUsed: 1, wallClockMs: 100 } as AppGoal;
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => { resolve = resolvePromise; });
  return { promise, resolve };
}

const apiMock = {
  updateSession: vi.fn(async () => ({})),
};

beforeEach(() => {
  goalStore().resetGoals();
  modeStore().resetMode();
  sessionsStore().setActiveSessionId(undefined);
  apiMock.updateSession.mockReset();
  apiMock.updateSession.mockResolvedValue({});
  setKimiClientDeps({ api: () => apiMock as unknown as KimiWebApi, t: (key) => key });
});

afterEach(() => {
  resetKimiClientDeps();
  setGoalHooks(null);
});

describe('goalStore applyGoalFrame', () => {
  it('replaces the local goal with the frame goal and bumps the version', () => {
    const store = goalStore();
    store.goalBySession = { s1: makeGoal('active') };
    store.goalVersionBySession = { s1: 1 };

    store.applyGoalFrame('s1', { ...makeGoal('paused'), turnsUsed: 4 });

    expect(store.goalBySession.s1).toMatchObject({ status: 'paused', turnsUsed: 4 });
    expect(store.goalVersionBySession.s1).toBe(2);
  });

  it('clears the local goal when the frame has none or it completed', () => {
    const store = goalStore();
    store.goalBySession = { s1: makeGoal('active'), s2: makeGoal('active') };

    store.applyGoalFrame('s1', null);
    store.applyGoalFrame('s2', makeGoal('complete'));

    expect(store.goalBySession.s1).toBeUndefined();
    expect(store.goalBySession.s2).toBeUndefined();
  });
});

describe('goalStore applyGoalDiff', () => {
  it('applies additions and removals to both slices', () => {
    const store = goalStore();

    store.applyGoalDiff({ s1: makeGoal('active') }, { s1: 2 });
    expect(store.goalBySession.s1?.status).toBe('active');
    expect(store.goalVersionBySession.s1).toBe(2);

    store.applyGoalDiff({}, {});
    expect(store.goalBySession).toEqual({});
    expect(store.goalVersionBySession).toEqual({});
  });
});

describe('goalStore createGoalObjective', () => {
  it('writes the objective and clears the plan and staged goal modes', async () => {
    modeStore().planModeBySession = { s1: true };
    modeStore().goalModeBySession = { s1: true };

    const created = await goalStore().createGoalObjective('s1', 'improve coverage');

    expect(created).toBe(true);
    expect(apiMock.updateSession).toHaveBeenCalledExactlyOnceWith('s1', {
      goalObjective: 'improve coverage',
      planMode: false,
    });
    expect(modeStore().planModeBySession.s1).toBe(false);
    expect(modeStore().goalModeBySession.s1).toBe(false);
  });

  it('keeps plan mode when goal mode is not staged', async () => {
    modeStore().planModeBySession = { s1: true };

    const created = await goalStore().createGoalObjective('s1', 'improve coverage');

    expect(created).toBe(true);
    expect(modeStore().planModeBySession.s1).toBe(false);
  });

  it('clears tower mode locally when creating a goal on a tower session', async () => {
    modeStore().towerModeBySession = { s1: true };

    const created = await goalStore().createGoalObjective('s1', 'improve coverage');

    expect(created).toBe(true);
    expect(modeStore().towerModeBySession.s1).toBe(false);
  });

  it('reports an existing goal without creating a duplicate', async () => {
    apiMock.updateSession.mockRejectedValue(
      new DaemonApiError({ code: 40913, msg: 'goal already exists', requestId: 'r' }),
    );
    const failure = vi.fn();
    setGoalHooks({ pushOperationFailure: failure });

    const created = await goalStore().createGoalObjective('s1', 'improve coverage');

    expect(created).toBe(false);
    expect(failure).toHaveBeenCalledWith(
      'createGoal',
      expect.anything(),
      expect.objectContaining({ sessionId: 's1', message: 'warnings.goal.alreadyExists' }),
    );
  });

  it('reports an ambiguous failure without a structured message', async () => {
    apiMock.updateSession.mockRejectedValue(new TypeError('fetch failed'));
    const failure = vi.fn();
    setGoalHooks({ pushOperationFailure: failure });

    const created = await goalStore().createGoalObjective('s1', 'improve coverage');

    expect(created).toBe(false);
    expect(failure).toHaveBeenCalledWith(
      'createGoal',
      expect.anything(),
      expect.objectContaining({ sessionId: 's1', message: undefined }),
    );
  });
});

describe('goalStore controlGoal', () => {
  it('sends the control write for the active session', async () => {
    sessionsStore().setActiveSessionId('s1');

    goalStore().controlGoal('pause');
    await vi.waitFor(() =>
      expect(apiMock.updateSession).toHaveBeenCalledWith('s1', { goalControl: 'pause' }),
    );
  });

  it('is a no-op without an active session', () => {
    goalStore().controlGoal('cancel');
    expect(apiMock.updateSession).not.toHaveBeenCalled();
  });

  it('clears tower mode locally when resuming a goal on a tower session', async () => {
    sessionsStore().setActiveSessionId('s1');
    modeStore().towerModeBySession = { s1: true };

    goalStore().controlGoal('resume');

    await vi.waitFor(() =>
      expect(apiMock.updateSession).toHaveBeenCalledWith('s1', { goalControl: 'resume' }),
    );
    expect(modeStore().towerModeBySession.s1).toBe(false);
  });

  it('reports a control failure', async () => {
    sessionsStore().setActiveSessionId('s1');
    apiMock.updateSession.mockRejectedValue(
      new DaemonApiError({ code: 40915, msg: 'status invalid', requestId: 'r' }),
    );
    const failure = vi.fn();
    setGoalHooks({ pushOperationFailure: failure });

    goalStore().controlGoal('resume');
    await vi.waitFor(() =>
      expect(failure).toHaveBeenCalledWith(
        'controlGoal',
        expect.anything(),
        expect.objectContaining({ sessionId: 's1', message: 'warnings.goal.statusInvalid' }),
      ),
    );
  });
});

describe('goalStore editGoalObjective', () => {
  it('sends the trimmed objective through the session profile', async () => {
    sessionsStore().setActiveSessionId('s1');

    expect(await goalStore().editGoalObjective('  new  ')).toBe(true);
    expect(apiMock.updateSession).toHaveBeenCalledExactlyOnceWith('s1', {
      goalControl: 'edit',
      goalObjective: 'new',
    });
  });

  it('blocks empty and too-long objectives before writing', async () => {
    sessionsStore().setActiveSessionId('s1');
    expect(await goalStore().editGoalObjective('   ')).toBe(false);
    expect(await goalStore().editGoalObjective('x'.repeat(4001))).toBe(false);
    expect(apiMock.updateSession).not.toHaveBeenCalled();
  });

  it.each([
    [40914, 'warnings.goal.notFound'],
    [40915, 'warnings.goal.editComplete'],
    [40917, 'warnings.goal.objectiveEmpty'],
    [40918, 'warnings.goal.objectiveTooLong'],
  ])('reports server error %i with a localized message', async (code, message) => {
    sessionsStore().setActiveSessionId('s1');
    goalStore().applyGoalFrame('s1', makeGoal('active'));
    apiMock.updateSession.mockRejectedValue(
      new DaemonApiError({ code, msg: 'x', requestId: 'r' }),
    );
    const failure = vi.fn();
    setGoalHooks({ pushOperationFailure: failure });

    expect(await goalStore().editGoalObjective('new')).toBe(false);
    expect(failure).toHaveBeenCalledWith(
      'editGoal',
      expect.anything(),
      expect.objectContaining({ sessionId: 's1', message }),
    );
    expect(goalStore().goalBySession.s1?.objective).toBe('obj');
  });
});

describe('goalErrorMessage', () => {
  it('maps known daemon error codes', () => {
    expect(goalErrorMessage(new DaemonApiError({ code: 40918, msg: 'x', requestId: 'r' }))).toBe(
      'warnings.goal.objectiveTooLong',
    );
  });

  it('returns undefined for unknown codes and non-daemon errors', () => {
    expect(goalErrorMessage(new DaemonApiError({ code: 99999, msg: 'x', requestId: 'r' }))).toBeUndefined();
    expect(goalErrorMessage(new TypeError('fetch failed'))).toBeUndefined();
  });
});

describe('goalStore createGoal prompt outcome', () => {
  beforeEach(() => {
    permissionsStore().$reset();
    sessionsStore().setSessions([
      { id: 's1', title: 'S1', createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z', cwd: '/workspace' } as AppSession,
    ]);
    sessionsStore().setActiveSessionId('s1');
    permissionsStore().pickInSession('s1', 'auto');
  });

  it.each([
    ['rejected', true],
    ['ok', false],
    ['queued', false],
  ] as const)('maps send outcome %s to promptRejected=%s', async (outcome, expected) => {
    setGoalHooks({
      pushOperationFailure: vi.fn(),
      createDraftSession: vi.fn(),
      sendPrompt: vi.fn(async () => outcome),
      submitPromptInternal: vi.fn(),
    });
    const result = await goalStore().createGoal('improve coverage');
    expect(result.promptRejected).toBe(expected);
  });
});

describe('goal confirmation after default workspace rollback', () => {
  beforeEach(() => {
    permissionsStore().$reset();
    sessionsStore().setSessions([]);
    workspacesStore().workspaceRecencyFloor = {};
    workspacesStore().hiddenWorkspaceRoots = [];
    workspacesStore().workspaces = [
      { id: 'a', root: '/a', name: 'A', sessionCount: 0, lastOpenedAt: '2026-10-20T02:00:00Z' },
      { id: 'b', root: '/b', name: 'B', sessionCount: 0, lastOpenedAt: '2026-10-20T01:00:00Z' },
    ];
    workspacesStore().workspaceSortMode = 'recent';
    workspacesStore().storedActiveWorkspaceId = 'default-workspace';
  });

  afterEach(() => {
    workspacesStore().workspaces = [];
    workspacesStore().storedActiveWorkspaceId = null;
    workspacesStore().workspaceSortMode = 'manual';
  });

  it.each([false, true])('only creates the goal in the confirmed workspace (reordered=%s)', async (reordered) => {
    const confirmation = deferred<boolean>();
    const confirmGoalStart = vi.fn(() => confirmation.promise);
    const createDraftSession = vi.fn(async () => 'created');
    const submitPromptInternal = vi.fn(async () => 'ok' as const);
    setGoalHooks({
      pushOperationFailure: vi.fn(),
      confirmGoalStart,
      createDraftSession,
      sendPrompt: vi.fn(async () => 'ok' as const),
      submitPromptInternal,
      flushQueueHead: vi.fn(),
    });
    expect(workspacesStore().activeWorkspaceId).toBe('a');
    const pending = goalStore().createGoal('improve coverage');
    expect(confirmGoalStart).toHaveBeenCalledOnce();
    if (reordered) {
      workspacesStore().upsertWorkspacePreserveOrder({
        id: 'b', root: '/b', name: 'B', sessionCount: 0, lastOpenedAt: '2026-10-20T03:00:00Z',
      });
      expect(workspacesStore().activeWorkspaceId).toBe('b');
    }
    confirmation.resolve(true);
    const result = await pending;
    if (reordered) {
      expect(createDraftSession).not.toHaveBeenCalled();
      expect(apiMock.updateSession).not.toHaveBeenCalled();
      expect(submitPromptInternal).not.toHaveBeenCalled();
      expect(result.sessionId).toBeNull();
    } else {
      expect(createDraftSession).toHaveBeenCalledExactlyOnceWith('a');
      expect(submitPromptInternal).toHaveBeenCalledOnce();
      expect(result.sessionId).toBe('created');
    }
  });
});

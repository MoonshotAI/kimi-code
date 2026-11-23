import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { AppSession, KimiWebApi } from '@moonshot-ai/app-core/api';
import { DaemonApiError, SESSION_BUSY_CODE } from '@moonshot-ai/app-core/api';
import { resetKimiClientDeps, setKimiClientDeps } from '../src/client/deps';
import { createSessionActions } from '../src/client/sessionActions';
import { useConfirmDialog } from '../src/composables/useConfirmDialog';
import { noopProductTracker, setProductTracker } from '../src/contracts';
import { promptStore } from '../src/stores/prompt';
import { sessionRuntimeStore } from '../src/stores/sessionRuntime';
import { sessionsStore } from '../src/stores/sessions';
import { warningsStore } from '../src/stores/warnings';

const trackMock = vi.fn();

const apiMock = {
  forkSession: vi.fn(async () => ({ id: 'fork-1', cwd: '/workspace' } as AppSession)),
  reloadSession: vi.fn(async () => ({ id: 's1', cwd: '/workspace' } as AppSession)),
  undoSession: vi.fn(async () => ({})),
  getSession: vi.fn(async () => ({ id: 's1', lastTurnReason: 'complete' })),
  compactSession: vi.fn(async () => ({})),
  exportSession: vi.fn(async () => ({ blob: new Blob(['x']), fileName: 's1.jsonl' })),
  getSessionWarnings: vi.fn(async () => []),
};

const deps = {
  mainUndoTarget: vi.fn((_sid: string, turnId?: string) => ({ turnId: turnId ?? 't_last', text: 'last prompt' })),
  updateSession: vi.fn(),
  selectSession: vi.fn(async () => {}),
  upsertSessionSorted: vi.fn(),
  isCompactionRunning: vi.fn(() => false),
};

function occupiedError(): DaemonApiError {
  return new DaemonApiError({
    code: 40931,
    msg: 'session occupied',
    requestId: 'req-1',
    details: { holder: { pid: 1234, clientIdentity: 'cli' } },
  });
}

function staleError(): DaemonApiError {
  return new DaemonApiError({ code: 40932, msg: 'session stale', requestId: 'req-2' });
}

beforeEach(() => {
  for (const mock of Object.values(apiMock)) mock.mockClear();
  for (const mock of Object.values(deps)) mock.mockClear();
  trackMock.mockClear();
  setProductTracker({ track: trackMock });
  useConfirmDialog().settle(false);
  deps.isCompactionRunning.mockReturnValue(false);
  sessionsStore().setSessions([{ id: 's1', cwd: '/workspace' } as AppSession]);
  sessionsStore().setActiveSessionId('s1');
  warningsStore().resetWarnings();
  promptStore().queueBySession = {};
  setKimiClientDeps({ api: () => apiMock as unknown as KimiWebApi, t: (key) => key, traceKeyEvent: vi.fn() });
});

afterEach(() => {
  setProductTracker(noopProductTracker);
  resetKimiClientDeps();
});

describe('sessionActions undo', () => {
  it('undoes the turn it is given, or the last undoable turn, and returns its text', async () => {
    sessionRuntimeStore().lastTurnReasonChangeBySession = { s1: 7 };

    const actions = createSessionActions(deps);
    await actions.undo();
    expect(apiMock.undoSession).toHaveBeenLastCalledWith('s1', 't_last');
    const result = await actions.undo('t_2');

    expect(apiMock.undoSession).toHaveBeenLastCalledWith('s1', 't_2');
    expect(result).toEqual({ text: 'last prompt' });
    await vi.waitFor(() =>
      expect(deps.updateSession).toHaveBeenCalledWith('s1', expect.any(Function)),
    );
  });

  it('returns null and reports when the undo fails', async () => {
    apiMock.undoSession.mockRejectedValueOnce(new Error('boom'));

    const actions = createSessionActions(deps);
    const result = await actions.undo();

    expect(result).toBeNull();
    expect(warningsStore().warnings).toHaveLength(1);
  });

  it('is a no-op without an active session', async () => {
    sessionsStore().setActiveSessionId(undefined);

    const actions = createSessionActions(deps);
    const result = await actions.undo();

    expect(result).toBeNull();
    expect(apiMock.undoSession).not.toHaveBeenCalled();
  });
});

describe('sessionActions compact', () => {
  it('sends the compact instruction for the active session when idle', async () => {
    const result = createSessionActions(deps).compact('shorter');
    expect(result).toBe(true);
    await vi.waitFor(() =>
      expect(apiMock.compactSession).toHaveBeenCalledWith('s1', 'shorter'),
    );
    expect(warningsStore().warnings).toHaveLength(0);
  });

  it('retries compact in place with the original instruction after the occupied dialog is confirmed', async () => {
    apiMock.compactSession.mockRejectedValueOnce(occupiedError());

    createSessionActions(deps).compact('shorter');
    await vi.waitFor(() => expect(useConfirmDialog().current.value).not.toBeNull());
    useConfirmDialog().settle(true);

    await vi.waitFor(() => expect(apiMock.compactSession).toHaveBeenCalledTimes(2));
    expect(apiMock.compactSession).toHaveBeenLastCalledWith('s1', 'shorter');
  });

  it('reports the rejection to hooks without a warning when the occupied dialog is cancelled', async () => {
    apiMock.compactSession.mockRejectedValueOnce(occupiedError());

    const onRequestRejected = vi.fn();
    createSessionActions(deps).compact('shorter', { onRequestRejected });
    await vi.waitFor(() => expect(useConfirmDialog().current.value).not.toBeNull());
    useConfirmDialog().settle(false);

    await vi.waitFor(() => expect(onRequestRejected).toHaveBeenCalledTimes(1));
    expect(apiMock.compactSession).toHaveBeenCalledTimes(1);
    expect(warningsStore().warnings).toHaveLength(0);
  });

  it('explains a 40910 refusal with the busy hint once the session is no longer compacting', async () => {
    const unable = () => new DaemonApiError({ code: 40910, msg: 'compaction unavailable', requestId: 'req-3' });
    apiMock.compactSession.mockRejectedValueOnce(unable());
    createSessionActions(deps).compact();
    await vi.waitFor(() =>
      expect(warningsStore().warnings).toMatchObject([{ severity: 'warning', title: 'commands.compactQueue.busy' }]),
    );
  });

  it('explains a 40910 refusal with the compacting hint while a compaction is running', async () => {
    const unable = () => new DaemonApiError({ code: 40910, msg: 'compaction unavailable', requestId: 'req-3' });
    apiMock.compactSession.mockRejectedValueOnce(unable());
    deps.isCompactionRunning.mockReturnValue(true);
    createSessionActions(deps).compact();
    await vi.waitFor(() =>
      expect(warningsStore().warnings).toMatchObject([{ severity: 'warning', title: 'commands.compactQueue.compacting' }]),
    );
  });

  it('reports other compact failures as a generic operation failure', async () => {
    apiMock.compactSession.mockRejectedValueOnce(new Error('boom'));
    const onRequestRejected = vi.fn();
    createSessionActions(deps).compact(undefined, { onRequestRejected });
    await vi.waitFor(() => expect(onRequestRejected).toHaveBeenCalledTimes(1));
    await vi.waitFor(() => expect(warningsStore().warnings).toHaveLength(1));
  });

  it('tracks the compact start from the request until it settles', async () => {
    const store = promptStore();
    let resolveCompact!: () => void;
    apiMock.compactSession.mockImplementationOnce(() => new Promise<void>((resolve) => { resolveCompact = resolve; }));
    createSessionActions(deps).compact();
    expect(store.isCompactStarting('s1')).toBe(true);
    resolveCompact();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(store.isCompactStarting('s1')).toBe(true);
  });

  it('clears the compact start when the compact request fails', async () => {
    const store = promptStore();
    apiMock.compactSession.mockRejectedValueOnce(new Error('boom'));
    createSessionActions(deps).compact();
    expect(store.isCompactStarting('s1')).toBe(true);
    await vi.waitFor(() => expect(store.isCompactStarting('s1')).toBe(false));
  });

  it('returns false without an active session', () => {
    sessionsStore().setActiveSessionId(undefined);
    expect(createSessionActions(deps).compact()).toBe(false);
    expect(apiMock.compactSession).not.toHaveBeenCalled();
  });
});

describe('sessionActions occupancy errors', () => {
  it('resolves undo with the retried result after the occupied dialog is confirmed', async () => {
    apiMock.undoSession.mockRejectedValueOnce(occupiedError());

    let settled = false;
    const pending = createSessionActions(deps).undo('t_2');
    void pending.then(() => { settled = true; });
    await vi.waitFor(() => expect(useConfirmDialog().current.value).not.toBeNull());
    expect(settled).toBe(false);

    useConfirmDialog().settle(true);

    expect(await pending).toEqual({ text: 'last prompt' });
    expect(apiMock.undoSession).toHaveBeenCalledTimes(2);
    expect(apiMock.undoSession).toHaveBeenLastCalledWith('s1', 't_2');
  });

  it('pushes a stale warning on 40932 for undo', async () => {
    apiMock.undoSession.mockRejectedValueOnce(staleError());

    void createSessionActions(deps).undo();

    await vi.waitFor(() => expect(warningsStore().warnings).toEqual([{
      severity: 'warning',
      title: 'warnings.sessionStale.title',
      message: 'warnings.sessionStale.retryMessage',
      position: 'bottom-right',
    }]));
  });
});

describe('sessionActions reloadSession', () => {
  it('reloads, upserts the session, and shows a success notice', async () => {
    const actions = createSessionActions(deps);
    const ok = await actions.reloadSession();

    expect(apiMock.reloadSession).toHaveBeenCalledWith('s1');
    expect(deps.upsertSessionSorted).toHaveBeenCalledWith(
      expect.objectContaining({ id: 's1' }),
    );
    expect(ok).toBe(true);
    expect(warningsStore().warnings.some((w) => w.severity === 'success')).toBe(true);
    expect(trackMock).toHaveBeenCalledWith('session_reload_result', { result: 'success' });
  });

  it('reports the busy message when the session is busy', async () => {
    apiMock.reloadSession.mockRejectedValueOnce(
      new DaemonApiError({ code: SESSION_BUSY_CODE, msg: 'session is busy', requestId: 'r' }),
    );

    const actions = createSessionActions(deps);
    const ok = await actions.reloadSession();

    expect(ok).toBe(false);
    const warnings = warningsStore().warnings;
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatchObject({ severity: 'error', message: 'commands.reload.busy' });
    expect(trackMock).toHaveBeenCalledWith('session_reload_result', { result: 'busy' });
  });

  it('is a no-op without an active session', async () => {
    sessionsStore().setActiveSessionId(undefined);

    const actions = createSessionActions(deps);
    const ok = await actions.reloadSession();

    expect(ok).toBe(false);
    expect(apiMock.reloadSession).not.toHaveBeenCalled();
  });

  it('rejects reloading an archived session with a guard warning', async () => {
    sessionsStore().setSessions([{ id: 's1', cwd: '/workspace', archived: true } as AppSession]);

    const actions = createSessionActions(deps);
    const ok = await actions.reloadSession();

    expect(ok).toBe(false);
    expect(apiMock.reloadSession).not.toHaveBeenCalled();
    expect(deps.upsertSessionSorted).not.toHaveBeenCalled();
    expect(
      warningsStore().warnings.some((w) => w.message === 'commands.reload.archived'),
    ).toBe(true);
    expect(trackMock).toHaveBeenCalledWith('session_reload_result', { result: 'archived' });
  });

  it('preserves the existing pull request badge when the reloaded session lacks it', async () => {
    const pullRequest = { number: 4019, state: 'open', url: 'https://example.com/pr/4019' };
    sessionsStore().setSessions([{ id: 's1', cwd: '/workspace', pullRequest } as AppSession]);

    const actions = createSessionActions(deps);
    const ok = await actions.reloadSession();

    expect(ok).toBe(true);
    expect(deps.upsertSessionSorted).toHaveBeenCalledWith(
      expect.objectContaining({ id: 's1', pullRequest }),
    );
  });

  it('preserves live usage when the reloaded session carries placeholder usage', async () => {
    const usage = {
      inputTokens: 10,
      outputTokens: 20,
      cacheReadTokens: 3,
      cacheCreationTokens: 2,
      totalCostUsd: 0.5,
      contextTokens: 100,
      contextLimit: 1000,
      turnCount: 4,
    };
    sessionsStore().setSessions([{ id: 's1', cwd: '/workspace', usage } as AppSession]);
    apiMock.reloadSession.mockResolvedValueOnce({
      id: 's1',
      cwd: '/workspace',
      usage: {
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheCreationTokens: 0,
        totalCostUsd: 0,
        contextTokens: 0,
        contextLimit: 0,
        turnCount: 0,
      },
    } as AppSession);

    const actions = createSessionActions(deps);
    const ok = await actions.reloadSession();

    expect(ok).toBe(true);
    expect(deps.upsertSessionSorted).toHaveBeenCalledWith(
      expect.objectContaining({ id: 's1', usage }),
    );
  });

  it('refreshes session warnings after a successful reload', async () => {
    const refresh = vi
      .spyOn(warningsStore(), 'refreshSessionWarnings')
      .mockImplementation(() => {});

    const actions = createSessionActions(deps);
    const ok = await actions.reloadSession();

    expect(ok).toBe(true);
    expect(refresh).toHaveBeenCalledWith('s1');
    refresh.mockRestore();
  });
});

describe('sessionActions exportSession', () => {
  it('reports no-session when there is no active session', async () => {
    sessionsStore().setActiveSessionId(undefined);

    const ok = await createSessionActions(deps).exportSession();

    expect(ok).toBe(false);
    expect(warningsStore().warnings).toHaveLength(1);
  });

  it('downloads the exported bundle', async () => {
    const anchor = { href: '', download: '', click: vi.fn(), remove: vi.fn() };
    const createObjectURL = vi.fn(() => 'blob:export');
    const revokeObjectURL = vi.fn();
    vi.stubGlobal('document', {
      createElement: vi.fn(() => anchor),
      body: { append: vi.fn() },
    });
    vi.stubGlobal('URL', { createObjectURL, revokeObjectURL });

    const ok = await createSessionActions(deps).exportSession();

    expect(ok).toBe(true);
    expect(anchor.click).toHaveBeenCalledOnce();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(revokeObjectURL).toHaveBeenCalledWith('blob:export');
  });
});


describe('sessionActions fork', () => {
  it('prepares forked browser tabs before selecting the new session', async () => {
    const onSessionForked = vi.fn(async () => {});
    setKimiClientDeps({ api: () => apiMock as unknown as KimiWebApi, t: key => key, onSessionForked });
    await createSessionActions(deps).forkSession(undefined, 7);
    expect(apiMock.forkSession).toHaveBeenCalledWith('s1', { turnIndex: 7 });
    expect(onSessionForked).toHaveBeenCalledWith('s1', 'fork-1');
    expect(onSessionForked.mock.invocationCallOrder[0]).toBeLessThan(deps.selectSession.mock.invocationCallOrder[0]!);
    expect(deps.selectSession).toHaveBeenCalledWith('fork-1', { skipTrack: true });
  });

  it('still selects the created session and reports a tab-copy failure', async () => {
    setKimiClientDeps({ api: () => apiMock as unknown as KimiWebApi, t: key => key,
      onSessionForked: async () => { throw new Error('tab closed'); },
    });
    await createSessionActions(deps).forkSession();
    expect(deps.selectSession).toHaveBeenCalledWith('fork-1', { skipTrack: true });
    expect(warningsStore().warnings).toHaveLength(1);
  });

  it('does not copy tabs when the server fork fails', async () => {
    const onSessionForked = vi.fn();
    setKimiClientDeps({ api: () => apiMock as unknown as KimiWebApi, t: key => key, onSessionForked });
    apiMock.forkSession.mockRejectedValueOnce(new Error('fork failed'));
    await createSessionActions(deps).forkSession();
    expect(onSessionForked).not.toHaveBeenCalled();
    expect(deps.selectSession).not.toHaveBeenCalled();
  });
});

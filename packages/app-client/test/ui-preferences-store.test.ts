// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DaemonApiError, DaemonNetworkError } from '@moonshot-ai/app-core/api';
import {
  loadSidebarViewMode,
  savePinnedSessions,
  STORAGE_KEYS,
  UI_PREFERENCE_KEYS,
  uiPreferences,
} from '@moonshot-ai/app-core/lib';
import { resetKimiClientDeps, setKimiClientDeps } from '../src/client/deps';
import { sessionsStore } from '../src/stores/sessions';
import { uiPreferencesStore } from '../src/stores/uiPreferences';

const SERVER = 'http://127.0.0.1:58627';
const PINNED = UI_PREFERENCE_KEYS.sidebarPinnedSessions;

interface Op {
  readonly op: string;
  readonly key: string;
  readonly value?: unknown;
}

function fakeServer(initial: Record<string, unknown> = {}) {
  const state = { revision: 0, values: { ...initial } };
  const api = {
    getUiPreferences: vi.fn(async () => ({ revision: state.revision, values: { ...state.values } })),
    importUiPreferences: vi.fn(async (incoming: Record<string, unknown>) => {
      for (const [key, value] of Object.entries(incoming)) {
        if (!Object.hasOwn(state.values, key)) state.values[key] = value;
      }
      state.revision += 1;
      return { revision: state.revision, imported: Object.keys(incoming), skipped: [] };
    }),
    patchUiPreferences: vi.fn(async (ops: readonly Op[]) => {
      const changed: Record<string, unknown> = {};
      for (const op of ops) {
        const current = (state.values[op.key] as unknown[] | undefined) ?? [];
        state.values[op.key] = op.op === 'add' ? [...current, op.value] : op.value;
        changed[op.key] = state.values[op.key];
      }
      state.revision += 1;
      return { revision: state.revision, changed };
    }),
  };
  setKimiClientDeps({ api: () => api as never, t: (key) => key });
  return { api, state };
}

const unreachable = (): DaemonNetworkError =>
  new DaemonNetworkError({
    message: 'offline',
    cause: null,
    method: 'PATCH',
    path: '/ui-preferences',
    url: `${SERVER}/api/v1/ui-preferences`,
    requestId: 'r',
    phase: 'fetch',
    timeoutMs: 0,
  });

beforeEach(() => {
  localStorage.clear();
  uiPreferences.bind(SERVER);
});

afterEach(() => {
  vi.useRealTimers();
  resetKimiClientDeps();
});

describe('UI preferences store', () => {
  it('imports what this browser kept locally once and then shows the server values', async () => {
    localStorage.setItem(STORAGE_KEYS.pinnedSessions, JSON.stringify(['s1']));
    localStorage.setItem(STORAGE_KEYS.sidebarViewMode, 'flat');
    const { api } = fakeServer({ [PINNED]: ['from-desktop'] });
    const sessions = sessionsStore();

    await uiPreferencesStore().refresh();
    await uiPreferencesStore().refresh();

    expect(api.importUiPreferences).toHaveBeenCalledTimes(1);
    expect(api.importUiPreferences.mock.calls[0]?.[0]).toEqual({ [PINNED]: ['s1'], 'sidebar.view_mode': 'flat' });
    expect(uiPreferencesStore().mode).toBe('server');
    expect(sessions.pinnedSessionIds).toEqual(['from-desktop']);
    expect(loadSidebarViewMode()).toBe('flat');
  });

  it('updates pinned sessions when another client pins one', async () => {
    fakeServer({ [PINNED]: ['s1'] });
    const sessions = sessionsStore();
    await uiPreferencesStore().refresh();

    uiPreferencesStore().applyServerEvent(5, { [PINNED]: ['s1', 's2'] });

    expect(sessions.pinnedSessionIds).toEqual(['s1', 's2']);
  });

  it('sends the edits of one tick as one request without waiting for a timer', async () => {
    const { api } = fakeServer({ [PINNED]: ['s1'] });
    await uiPreferencesStore().refresh();

    savePinnedSessions(['s1', 'a']);
    savePinnedSessions(['s1', 'a', 'b']);
    await vi.waitFor(() => expect(uiPreferences.hasQueued()).toBe(false));

    expect(api.patchUiPreferences).toHaveBeenCalledTimes(1);
    expect(api.patchUiPreferences.mock.calls[0]?.[0]).toEqual([
      { op: 'add', key: PINNED, value: 'a' },
      { op: 'add', key: PINNED, value: 'b' },
    ]);
  });

  it('keeps using local storage against a server without UI preferences', async () => {
    localStorage.setItem(STORAGE_KEYS.pinnedSessions, JSON.stringify(['s1']));
    const { api } = fakeServer();
    api.getUiPreferences.mockRejectedValue(new DaemonApiError({ code: 404, msg: 'Not Found', requestId: 'r' }));

    await uiPreferencesStore().refresh();
    savePinnedSessions(['s1', 's2']);

    expect(uiPreferencesStore().mode).toBe('local');
    expect(api.importUiPreferences).not.toHaveBeenCalled();
    expect(localStorage.getItem(STORAGE_KEYS.pinnedSessions)).toBe('["s1","s2"]');
  });

  it('resends an edit made while the server was unreachable after reconnecting', async () => {
    const { api, state } = fakeServer({ [PINNED]: [] });
    await uiPreferencesStore().refresh();
    api.patchUiPreferences.mockRejectedValueOnce(unreachable());

    savePinnedSessions(['offline']);
    await vi.waitFor(() => expect(uiPreferences.hasQueued()).toBe(true));

    await uiPreferencesStore().refresh();
    await vi.waitFor(() => expect(api.patchUiPreferences).toHaveBeenCalledTimes(2));

    expect(state.values[PINNED]).toEqual(['offline']);
  });

  it('resends an edit the page closed before the server confirmed it', async () => {
    const { api, state } = fakeServer({ [PINNED]: [] });
    await uiPreferencesStore().refresh();
    api.patchUiPreferences.mockImplementationOnce(() => new Promise(() => {}));
    savePinnedSessions(['closing']);
    await vi.waitFor(() => expect(api.patchUiPreferences).toHaveBeenCalledTimes(1));

    uiPreferencesStore().$dispose();
    uiPreferences.bind(SERVER);
    expect(sessionsStore().pinnedSessionIds).toEqual(['closing']);
    await uiPreferencesStore().refresh();
    await vi.waitFor(() => expect(api.patchUiPreferences).toHaveBeenCalledTimes(2));

    expect(api.patchUiPreferences.mock.calls[1]?.[0]).toEqual([{ op: 'add', key: PINNED, value: 'closing' }]);
    expect(state.values[PINNED]).toEqual(['closing']);
  });

  it('applies a change that arrives while the snapshot is still loading', async () => {
    const { api } = fakeServer({ [PINNED]: ['s1'] });
    let release: () => void = () => {};
    api.getUiPreferences.mockImplementationOnce(
      () => new Promise((resolve) => {
        release = () => resolve({ revision: 2, values: { [PINNED]: ['s1'] } });
      }),
    );

    const loading = uiPreferencesStore().refresh();
    uiPreferencesStore().applyServerEvent(3, { [PINNED]: ['s1', 'late'] });
    release();
    await loading;

    expect(sessionsStore().pinnedSessionIds).toEqual(['s1', 'late']);
  });

  it('loads the preferences again when the server started over with a lower revision', async () => {
    const { api, state } = fakeServer({ [PINNED]: ['s1'] });
    state.revision = 12;
    await uiPreferencesStore().refresh();
    state.revision = 1;
    state.values = { [PINNED]: ['restored'] };

    uiPreferencesStore().applyServerEvent(1, { [PINNED]: ['restored'] });

    await vi.waitFor(() => expect(sessionsStore().pinnedSessionIds).toEqual(['restored']));
    expect(api.getUiPreferences).toHaveBeenCalledTimes(2);
  });

  it('imports again when the server comes back without any preferences', async () => {
    localStorage.setItem(STORAGE_KEYS.pinnedSessions, JSON.stringify(['s1']));
    const { api, state } = fakeServer();
    await uiPreferencesStore().refresh();
    state.revision = 0;
    state.values = {};

    await uiPreferencesStore().refresh();

    expect(api.importUiPreferences).toHaveBeenCalledTimes(2);
    expect(state.values).toEqual({ [PINNED]: ['s1'] });
    expect(sessionsStore().pinnedSessionIds).toEqual(['s1']);
  });
});

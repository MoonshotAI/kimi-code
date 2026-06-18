// apps/kimi-web/test/session-url.test.ts
//
// Session ↔ URL binding without a router: clicking a session pushes
// /sessions/<id>; loading the app honours a deep link (fetching the session
// when it is beyond the first page); back/forward drive selection via
// popstate without re-writing the URL; archiving the active session repairs
// the address bar with replaceState.

import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AppSession, AppWarning, KimiEventHandlers, KimiWebApi } from '../src/api/types';
import { readSessionIdFromLocation, sessionUrl } from '../src/lib/sessionRoute';

const now = '2026-06-11T00:00:00.000Z';

function session(id: string): AppSession {
  return {
    id,
    title: id,
    createdAt: now,
    updatedAt: now,
    status: 'idle',
    archived: false,
    cwd: '/repo',
    model: 'kimi-test',
    usage: {
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
      totalCostUsd: 0,
      contextTokens: 0,
      contextLimit: 128_000,
      turnCount: 0,
    },
    messageCount: 0,
    lastSeq: 0,
  };
}

async function setup(opts: {
  sessions?: AppSession[];
  /** Sessions only reachable via getSession (beyond the first page). */
  extraSessions?: AppSession[];
  /** Sessions that vanish when their transcript is loaded. */
  messageMissingSessions?: string[];
  snapshotErrors?: Record<string, unknown>;
  initialPath?: string;
}) {
  vi.resetModules();
  vi.stubGlobal('WebSocket', class WebSocket {});
  window.history.replaceState(null, '', opts.initialPath ?? '/');

  const listed = opts.sessions ?? [];
  const extras = opts.extraSessions ?? [];
  const messageMissingSessions = new Set(opts.messageMissingSessions ?? []);
  const snapshotErrors = opts.snapshotErrors ?? {};

  let handlers: KimiEventHandlers | undefined;
  const eventConn = {
    subscribe: vi.fn(),
    unsubscribe: vi.fn(),
    bindNextPromptId: vi.fn(),
    seedSnapshot: vi.fn(),
    abort: vi.fn(),
    close: vi.fn(),
  };
  const api = {
    getHealth: vi.fn(async () => ({ status: 'ok', uptimeSec: 1 })),
    getMeta: vi.fn(async () => ({ daemonVersion: 't', serverId: 's', startedAt: now, capabilities: {} })),
    getAuth: vi.fn(async () => ({ ready: true, defaultModel: 'kimi-test', managedProvider: null })),
    listModels: vi.fn(async () => []),
    listWorkspaces: vi.fn(async () => []),
    getFsHome: vi.fn(async () => ({ home: '/home', recentRoots: [] })),
    listSessions: vi.fn(async () => ({ items: listed, hasMore: false })),
    getSession: vi.fn(async (id: string) => {
      const found = extras.find((s) => s.id === id) ?? listed.find((s) => s.id === id);
      if (!found) throw new Error('SESSION_NOT_FOUND');
      return found;
    }),
    archiveSession: vi.fn(async () => ({ archived: true })),
    getSessionSnapshot: vi.fn(async (id: string) => {
      if (Object.prototype.hasOwnProperty.call(snapshotErrors, id)) {
        throw snapshotErrors[id];
      }
      if (messageMissingSessions.has(id)) {
        throw Object.assign(new Error(`session ${id} does not exist`), {
          name: 'DaemonApiError',
          code: 40401,
        });
      }
      const found = extras.find((s) => s.id === id) ?? listed.find((s) => s.id === id) ?? session(id);
      return {
        asOfSeq: 0,
        epoch: 'ep_test',
        session: found,
        messages: [],
        hasMoreMessages: false,
        inFlightTurn: null,
        pendingApprovals: [],
        pendingQuestions: [],
      };
    }),
    listTasks: vi.fn(async () => []),
    getGitStatus: vi.fn(async () => ({ branch: 'main', ahead: 0, behind: 0, entries: {}, additions: 0, deletions: 0 })),
    getSessionStatus: vi.fn(async () => ({
      model: 'kimi-test',
      thinkingLevel: 'high',
      permission: 'manual',
      planMode: false,
      swarmMode: false,
      contextTokens: 0,
      maxContextTokens: 128_000,
      contextUsage: 0,
    })),
    connectEvents: vi.fn((nextHandlers: KimiEventHandlers) => {
      handlers = nextHandlers;
      return eventConn;
    }),
    getFileUrl: vi.fn((fileId: string) => `/files/${fileId}`),
  } as unknown as KimiWebApi;

  vi.doMock('../src/api', () => ({ getKimiWebApi: () => api }));
  const { useKimiWebClient } = await import('../src/composables/useKimiWebClient');

  return {
    api,
    client: useKimiWebClient(),
    getHandlers: () => {
      if (!handlers) throw new Error('connectEvents was not called');
      return handlers;
    },
  };
}

function warningText(warning: AppWarning): string {
  return typeof warning === 'string' ? warning : `${warning.title} ${warning.message ?? ''}`;
}

/** Simulate back/forward: the browser changes the URL itself, then fires
    popstate. jsdom's history traversal is unreliable, so emulate directly. */
function firePopState(path: string): void {
  window.history.replaceState(null, '', path);
  window.dispatchEvent(new PopStateEvent('popstate'));
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.resetModules();
  vi.clearAllMocks();
  localStorage.removeItem('kimi-locale');
  window.history.replaceState(null, '', '/');
});

describe('sessionRoute helpers', () => {
  it('parses /sessions/<id> and nothing else', () => {
    expect(readSessionIdFromLocation({ pathname: '/sessions/abc' })).toBe('abc');
    expect(readSessionIdFromLocation({ pathname: '/sessions/a%2Fb' })).toBe('a/b');
    expect(readSessionIdFromLocation({ pathname: '/' })).toBeUndefined();
    expect(readSessionIdFromLocation({ pathname: '/sessions/' })).toBeUndefined();
    expect(readSessionIdFromLocation({ pathname: '/sessions/a/b' })).toBeUndefined();
    expect(readSessionIdFromLocation({ pathname: '/settings' })).toBeUndefined();
    expect(readSessionIdFromLocation({ pathname: '/sessions/%E0%A4%A' })).toBeUndefined(); // bad escape
  });

  it('builds canonical URLs', () => {
    expect(sessionUrl('abc')).toBe('/sessions/abc');
    expect(sessionUrl(undefined)).toBe('/');
  });
});

describe('session ↔ URL binding', () => {
  it('selectSession pushes /sessions/<id>; re-selecting the same session does not stack entries', async () => {
    const { client } = await setup({ sessions: [session('sess_1'), session('sess_2')] });
    await client.load();
    expect(window.location.pathname).toBe('/sessions/sess_1'); // auto-select → replace

    const lenAfterLoad = window.history.length;
    await client.selectSession('sess_2');
    expect(window.location.pathname).toBe('/sessions/sess_2');
    expect(window.history.length).toBe(lenAfterLoad + 1);

    await client.selectSession('sess_2');
    expect(window.history.length).toBe(lenAfterLoad + 1);
  });

  it('load() honours a deep link to a listed session without adding a history entry', async () => {
    const { client } = await setup({
      sessions: [session('sess_1'), session('sess_2')],
      initialPath: '/sessions/sess_2',
    });
    const lenBefore = window.history.length;
    await client.load();

    expect(client.activeSessionId.value).toBe('sess_2');
    expect(window.location.pathname).toBe('/sessions/sess_2');
    expect(window.history.length).toBe(lenBefore);
  });

  it('load() fetches a deep-linked session beyond the first page via getSession', async () => {
    const old = session('sess_old');
    const { api, client } = await setup({
      sessions: [session('sess_1')],
      extraSessions: [old],
      initialPath: '/sessions/sess_old',
    });
    await client.load();

    expect(api.getSession).toHaveBeenCalledWith('sess_old');
    expect(client.activeSessionId.value).toBe('sess_old');
    // Appended (not prepended) so the recency ordering stays intact.
    expect(client.sessions.value.map((s) => s.id)).toEqual(['sess_1', 'sess_old']);
  });

  it('load() falls back to the most recent session and repairs a dead deep link', async () => {
    const { client } = await setup({
      sessions: [session('sess_1')],
      initialPath: '/sessions/sess_gone',
    });
    await client.load();

    expect(client.activeSessionId.value).toBe('sess_1');
    expect(window.location.pathname).toBe('/sessions/sess_1');
  });

  it('load() repairs a deep link when the listed session vanishes before its snapshot loads', async () => {
    const { api, client } = await setup({
      sessions: [session('sess_gone'), session('sess_1')],
      messageMissingSessions: ['sess_gone'],
      initialPath: '/sessions/sess_gone',
    });
    await client.load();

    expect(api.getSessionSnapshot).toHaveBeenCalledWith('sess_gone');
    expect(client.activeSessionId.value).toBe('sess_1');
    expect(client.sessions.value.map((s) => s.id)).toEqual(['sess_1']);
    expect(window.location.pathname).toBe('/sessions/sess_1');
    expect(client.warnings.value.some((w) => warningText(w).includes('Failed to load session snapshot'))).toBe(false);
  });

  it('load() surfaces snapshot network failures as actionable diagnostics', async () => {
    localStorage.setItem('kimi-locale', 'en');
    const networkError = Object.assign(new Error('Network error calling GET /sessions/sess_1/snapshot'), {
      name: 'DaemonNetworkError',
      method: 'GET',
      path: '/sessions/sess_1/snapshot',
      url: 'http://127.0.0.1:58627/api/v1/sessions/sess_1/snapshot',
      requestId: '01HZ0000000000000000000000',
      phase: 'fetch',
      timeoutMs: 30000,
      cause: new TypeError('Failed to fetch'),
    });
    const { client } = await setup({
      sessions: [session('sess_1')],
      snapshotErrors: { sess_1: networkError },
    });

    await client.load();

    expect(client.warnings.value).toHaveLength(1);
    const [warning] = client.warnings.value;
    expect(typeof warning).toBe('object');
    if (typeof warning === 'string') throw new Error('expected structured warning');
    expect(warning).toMatchObject({
      severity: 'error',
      title: 'Cannot load current conversation',
      message: expect.stringContaining('could not load the current conversation'),
    });
    expect(warning.details).toEqual(
      expect.arrayContaining([
        { label: 'Operation', value: 'getSessionSnapshot' },
        { label: 'Session ID', value: 'sess_1' },
        { label: 'Request', value: 'GET /sessions/sess_1/snapshot' },
        { label: 'Endpoint', value: 'http://127.0.0.1:58627/api/v1/sessions/sess_1/snapshot' },
        { label: 'Request ID', value: '01HZ0000000000000000000000' },
        { label: 'Cause', value: 'TypeError: Failed to fetch' },
      ]),
    );
  });

  it('popstate selects the session from the URL without writing the URL again', async () => {
    const { client } = await setup({ sessions: [session('sess_1'), session('sess_2')] });
    await client.load();
    await client.selectSession('sess_2');

    const lenBefore = window.history.length;
    firePopState('/sessions/sess_1');
    await vi.waitFor(() => {
      expect(client.activeSessionId.value).toBe('sess_1');
    });
    expect(window.location.pathname).toBe('/sessions/sess_1');
    expect(window.history.length).toBe(lenBefore);
  });

  it('popstate to "/" clears the active session', async () => {
    const { client } = await setup({ sessions: [session('sess_1')] });
    await client.load();
    expect(client.activeSessionId.value).toBe('sess_1');

    firePopState('/');
    expect(client.activeSessionId.value).toBe(''); // composable maps undefined → ''
  });

  it('archiving the active session replaces the URL with the next session', async () => {
    const { client } = await setup({ sessions: [session('sess_1'), session('sess_2')] });
    await client.load();
    expect(client.activeSessionId.value).toBe('sess_1');

    const lenBefore = window.history.length;
    await client.archiveSession('sess_1');

    expect(client.activeSessionId.value).toBe('sess_2');
    expect(window.location.pathname).toBe('/sessions/sess_2');
    expect(window.history.length).toBe(lenBefore);
  });
});

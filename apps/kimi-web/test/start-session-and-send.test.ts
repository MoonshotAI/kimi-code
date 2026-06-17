// apps/kimi-web/test/start-session-and-send.test.ts
//
// startSessionAndSendPrompt: when there is no active session (e.g. after clicking
// "+"), sending a message should create the session first, then submit the prompt.
// The session list must never contain duplicates regardless of whether the REST
// create response or the WebSocket sessionCreated broadcast arrives first.

import { afterEach, describe, expect, it, vi } from 'vitest';
import type {
  AppSession,
  AppSessionSnapshot,
  KimiEventHandlers,
  KimiWebApi,
} from '../src/api/types';

const now = '2026-06-11T00:00:00.000Z';

function makeSession(id: string, overrides?: Partial<AppSession>): AppSession {
  return {
    id,
    title: id,
    createdAt: now,
    updatedAt: now,
    status: 'idle',
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
    ...overrides,
  };
}

async function setup() {
  vi.resetModules();
  vi.stubGlobal('WebSocket', class WebSocket {});

  let handlers: KimiEventHandlers | undefined;
  const eventConn = {
    subscribe: vi.fn(),
    unsubscribe: vi.fn(),
    bindNextPromptId: vi.fn(),
    seedSnapshot: vi.fn(),
    abort: vi.fn(),
    close: vi.fn(),
  };

  const created = makeSession('sess_new');
  const api = {
    createSession: vi.fn(async () => created),
    submitPrompt: vi.fn(async () => ({ promptId: 'pr_1', userMessageId: 'msg_real' })),
    addWorkspace: vi.fn(async () => ({ id: 'ws_repo', root: '/repo', name: 'repo', isGitRepo: false, sessionCount: 0 })),
    deleteWorkspace: vi.fn(async () => ({ deleted: true })),
    listWorkspaces: vi.fn(async () => []),
    browseFs: vi.fn(async (path?: string) => ({ path: path ?? '/home/user', parent: null, entries: [] })),
    getFsHome: vi.fn(async () => ({ home: '/home/user', recentRoots: [] })),
    listSessions: vi.fn(async () => ({ items: [], hasMore: false })),
    getHealth: vi.fn(async () => ({ ok: true })),
    getMeta: vi.fn(async () => ({ daemonVersion: '0.0.1' })),
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
    getSessionSnapshot: vi.fn(async () => ({
      asOfSeq: 0,
      epoch: 'ep_test',
      session: created,
      messages: [],
      hasMoreMessages: false,
      inFlightTurn: null,
      pendingApprovals: [],
      pendingQuestions: [],
    })),
    listTasks: vi.fn(async () => []),
    getGitStatus: vi.fn(async () => ({ branch: 'main', ahead: 0, behind: 0, entries: {}, additions: 0, deletions: 0 })),
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
    eventConn,
    getHandlers: () => {
      if (!handlers) throw new Error('connectEvents was not called');
      return handlers;
    },
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.resetModules();
  vi.clearAllMocks();
});

describe('startSessionAndSendPrompt', () => {
  it('creates a session then submits the prompt in one flow', async () => {
    const { api, client } = await setup();
    await client.addWorkspaceByPath('/repo');

    await client.startSessionAndSendPrompt('ws_repo', 'hello world');

    expect(api.createSession).toHaveBeenCalledTimes(1);
    expect(api.createSession).toHaveBeenCalledWith(
      expect.objectContaining({ workspaceId: 'ws_repo', cwd: '/repo' }),
    );
    expect(api.submitPrompt).toHaveBeenCalledTimes(1);
    expect(api.submitPrompt).toHaveBeenCalledWith(
      'sess_new',
      expect.objectContaining({ content: [{ type: 'text', text: 'hello world' }] }),
    );
    expect(client.activeSessionId.value).toBe('sess_new');
    expect(client.sessions.value).toHaveLength(1);
    expect(client.sessions.value[0]!.id).toBe('sess_new');
  });

  it('keeps sessionLoading true while the snapshot is in flight (no empty-composer flash)', async () => {
    const { api, client } = await setup();
    await client.addWorkspaceByPath('/repo');

    // Hold the snapshot open so we can observe the state between selecting the
    // freshly created session and the user's message landing.
    let resolveSnap!: (value: AppSessionSnapshot) => void;
    vi.mocked(api.getSessionSnapshot).mockImplementation(
      () => new Promise<AppSessionSnapshot>((resolve) => { resolveSnap = resolve; }),
    );

    const flow = client.startSessionAndSendPrompt('ws_repo', 'hello world');

    // Wait until selectSession reaches the snapshot fetch.
    await vi.waitFor(() => expect(api.getSessionSnapshot).toHaveBeenCalledTimes(1));

    // The new session is active but its snapshot has not returned yet. The
    // empty-conversation composer renders only when `turns.length === 0 &&
    // !sessionLoading`; sessionLoading MUST stay true here so it does not flash
    // before the optimistic user message arrives.
    expect(client.activeSessionId.value).toBe('sess_new');
    expect(client.sessionLoading.value).toBe(true);

    resolveSnap({
      asOfSeq: 0,
      epoch: 'ep_test',
      session: makeSession('sess_new'),
      messages: [],
      hasMoreMessages: false,
      inFlightTurn: null,
      pendingApprovals: [],
      pendingQuestions: [],
    });
    await flow;

    // Loading cleared and the user's message was submitted + shown optimistically.
    expect(client.sessionLoading.value).toBe(false);
    expect(api.submitPrompt).toHaveBeenCalledTimes(1);
    expect(client.turns.value.some((t) => t.role === 'user')).toBe(true);
  });

  it('applies a model picked in the draft state (no session yet) to the created session', async () => {
    const { api, client } = await setup();
    await client.addWorkspaceByPath('/repo');

    // Onboarding composer: no active session — the pick must still register.
    expect(client.activeSessionId.value).toBeFalsy();
    await client.setModel('provider/kimi-next');

    // The dropdown reflects the draft pick immediately (not the daemon default).
    expect(client.status.value.modelId).toBe('provider/kimi-next');

    await client.startSessionAndSendPrompt('ws_repo', 'hello');

    expect(api.createSession).toHaveBeenCalledWith(
      expect.objectContaining({ model: 'provider/kimi-next' }),
    );
  });

  it('does not duplicate the session when WebSocket broadcast arrives after REST', async () => {
    const { api, client, getHandlers } = await setup();
    await client.addWorkspaceByPath('/repo');

    await client.startSessionAndSendPrompt('ws_repo', 'hello');

    // Simulate the late WebSocket sessionCreated broadcast
    getHandlers().onEvent(
      { type: 'sessionCreated', session: makeSession('sess_new') },
      { sessionId: 'sess_new', seq: 1 },
    );

    expect(client.sessions.value).toHaveLength(1);
    expect(client.sessions.value[0]!.id).toBe('sess_new');
  });

  it('does not duplicate the session when WebSocket broadcast arrives before REST', async () => {
    const { client, getHandlers } = await setup();
    await client.addWorkspaceByPath('/repo');

    // Establish the event connection first
    await client.startSessionAndSendPrompt('ws_repo', 'first');

    // Broadcast the same session (simulating WS arriving before REST)
    getHandlers().onEvent(
      { type: 'sessionCreated', session: makeSession('sess_new') },
      { sessionId: 'sess_new', seq: 1 },
    );

    // Now REST returns — calling startSessionAndSendPrompt again with the same id.
    // The upsert filter in the method removes the duplicate.
    await client.startSessionAndSendPrompt('ws_repo', 'hello');

    expect(client.sessions.value.filter((s) => s.id === 'sess_new')).toHaveLength(1);
  });
});

describe('plan mode sync from the agent', () => {
  it('activates the composer plan toggle when the agent reports plan mode', async () => {
    const { client, getHandlers } = await setup();
    await client.addWorkspaceByPath('/repo');
    await client.startSessionAndSendPrompt('ws_repo', 'enter plan mode and write hello.ts');

    expect(client.planMode.value).toBe(false);

    // The agent auto-entered plan mode and reports it via agent.status.updated,
    // which the projector forwards on sessionUsageUpdated.
    getHandlers().onEvent(
      {
        type: 'sessionUsageUpdated',
        sessionId: 'sess_new',
        usage: makeSession('sess_new').usage,
        planMode: true,
      },
      { sessionId: 'sess_new', seq: 2 },
    );

    expect(client.planMode.value).toBe(true);
  });

  it('ignores plan/swarm mode updates from a background session', async () => {
    const { client, getHandlers } = await setup();
    await client.addWorkspaceByPath('/repo');
    await client.startSessionAndSendPrompt('ws_repo', 'active session prompt');

    expect(client.planMode.value).toBe(false);
    expect(client.swarmMode.value).toBe(false);

    getHandlers().onEvent(
      {
        type: 'sessionUsageUpdated',
        sessionId: 'sess_background',
        usage: makeSession('sess_background').usage,
        planMode: true,
        swarmMode: true,
      },
      { sessionId: 'sess_background', seq: 3 },
    );

    expect(client.planMode.value).toBe(false);
    expect(client.swarmMode.value).toBe(false);
  });
});

describe('openWorkspaceDraft', () => {
  it('clears activeSessionId without removing sessions', async () => {
    const { client } = await setup();
    await client.addWorkspaceByPath('/repo');
    await client.createSession('/repo');

    expect(client.activeSessionId.value).toBe('sess_new');
    expect(client.sessions.value).toHaveLength(1);

    client.openWorkspaceDraft('ws_repo');

    expect(client.activeSessionId.value).toBe('');
    expect(client.sessions.value).toHaveLength(1);
    expect(client.activeWorkspaceId.value).toBe('ws_repo');
  });

  it('clears the active session when the active workspace is removed', async () => {
    const { api, client } = await setup();
    await client.addWorkspaceByPath('/repo');
    await client.startSessionAndSendPrompt('ws_repo', 'hello');

    expect(client.activeSessionId.value).toBe('sess_new');
    expect(client.activeWorkspaceId.value).toBe('ws_repo');

    await client.deleteWorkspace('ws_repo');

    expect(api.deleteWorkspace).toHaveBeenCalledWith('ws_repo');
    expect(client.activeSessionId.value).toBe('');
    expect(client.activeWorkspaceId.value).toBeNull();
    expect(client.sessions.value).toHaveLength(1);
  });
});

describe('folder browser fallback', () => {
  it('returns an empty path when browseFs fails so the dialog can fall back', async () => {
    const { api, client } = await setup();
    (api.browseFs as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error('fs browse unavailable'));

    await expect(client.browseFs('/repo')).resolves.toEqual({
      path: '',
      parent: null,
      entries: [],
    });
  });
});

describe('createSession dedup', () => {
  it('createSession does not duplicate when broadcast arrived first', async () => {
    const { api, client, getHandlers } = await setup();

    // Establish the event connection first
    await client.createSession('/repo');

    // Now hijack createSession for the race test
    let resolveCreate!: (s: AppSession) => void;
    const createPromise = new Promise<AppSession>((r) => {
      resolveCreate = r;
    });
    (api.createSession as ReturnType<typeof vi.fn>).mockReturnValue(createPromise);

    const promise = client.createSession('/repo');

    // Broadcast arrives first
    getHandlers().onEvent(
      { type: 'sessionCreated', session: makeSession('sess_new') },
      { sessionId: 'sess_new', seq: 1 },
    );

    resolveCreate(makeSession('sess_new'));
    await promise;

    // Should still be just the original session (no duplicate)
    expect(client.sessions.value.filter((s) => s.id === 'sess_new')).toHaveLength(1);
  });
});

describe('createSessionInWorkspace dedup', () => {
  it('createSessionInWorkspace does not duplicate when broadcast arrived first', async () => {
    const { api, client, getHandlers } = await setup();
    await client.addWorkspaceByPath('/repo');

    // Establish the event connection first
    await client.createSessionInWorkspace('ws_repo');

    // Broadcast the same session (simulating WS arriving before REST)
    getHandlers().onEvent(
      { type: 'sessionCreated', session: makeSession('sess_new', { workspaceId: 'ws_repo' }) },
      { sessionId: 'sess_new', seq: 1 },
    );

    // Now REST returns — calling createSessionInWorkspace again with the same id.
    // The upsert filter in the method removes the duplicate.
    await client.createSessionInWorkspace('ws_repo');

    // Should still be just the original session (no duplicate)
    expect(client.sessions.value.filter((s) => s.id === 'sess_new')).toHaveLength(1);
  });
});

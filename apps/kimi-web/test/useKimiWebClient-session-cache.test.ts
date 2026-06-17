import { afterEach, describe, expect, it, vi } from 'vitest';
import type {
  AppConfig,
  AppMessage,
  AppSession,
  KimiEventHandlers,
  KimiWebApi,
} from '../src/api/types';

const now = '2026-06-11T00:00:00.000Z';

class NotificationMock {
  static permission = 'granted';
  static requestPermission = vi.fn(async () => 'granted');
  static instances: NotificationMock[] = [];
  title: string;
  onclick: (() => void) | null = null;
  constructor(title: string) {
    this.title = title;
    NotificationMock.instances.push(this);
  }
  close(): void {}
}

function session(id: string): AppSession {
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
  };
}

function userMessage(sessionId: string, id: string): AppMessage {
  return {
    id,
    sessionId,
    role: 'user',
    content: [{ type: 'text', text: id }],
    createdAt: now,
  };
}

async function setup(messages: AppMessage[] = []) {
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
  const created = session('sess_1');
  const initialConfig: AppConfig = { providers: {}, defaultModel: 'kimi/default' };
  const api = {
    createSession: vi.fn(async () => created),
    listMessages: vi.fn(async () => ({ items: messages, hasMore: false })),
    getSessionSnapshot: vi.fn(async () => ({
      asOfSeq: 0,
      epoch: 'ep_test',
      session: created,
      messages,
      hasMoreMessages: false,
      inFlightTurn: null,
      pendingApprovals: [],
      pendingQuestions: [],
    })),
    submitPrompt: vi.fn(async () => ({ promptId: 'pr_1', userMessageId: 'msg_real' })),
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
    getConfig: vi.fn(async () => initialConfig),
    setConfig: vi.fn(async (patch: Partial<AppConfig>) => ({
      ...initialConfig,
      ...patch,
      providers: patch.providers ?? initialConfig.providers,
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

describe('useKimiWebClient session memory cache', () => {
  it('treats an already loaded empty message array as an L1 hit', async () => {
    const { api, client, eventConn } = await setup([]);

    await client.createSession('/repo');
    expect(api.getSessionSnapshot).toHaveBeenCalledTimes(1);
    expect(client.sessionLoading.value).toBe(false);

    const secondSelect = client.selectSession('sess_1');

    expect(client.sessionLoading.value).toBe(false);
    await secondSelect;
    // L1 hit: no second snapshot fetch — re-subscribe at the tracked cursor.
    expect(api.getSessionSnapshot).toHaveBeenCalledTimes(1);
    expect(eventConn.subscribe).toHaveBeenLastCalledWith('sess_1', {
      seq: 0,
      epoch: 'ep_test',
    });
  });

  it('does not raise the loading state for a locally created session', async () => {
    const { client } = await setup([]);

    // Locally created sessions are trusted to start empty, so the empty-composer
    // renders immediately without flashing the chat-pane loading state.
    const pending = client.createSession('/repo');
    expect(client.sessionLoading.value).toBe(false);
    await pending;
    expect(client.sessionLoading.value).toBe(false);
  });

  it('raises the loading state when selecting an existing session reported as empty', async () => {
    const { client, getHandlers } = await setup([]);
    await client.createSession('/repo');

    // A second, never-opened session whose daemon-reported messageCount is 0.
    // We no longer trust messageCount for existing sessions (it can be stale),
    // so we load the snapshot before deciding what to render.
    const empty = session('sess_empty'); // messageCount: 0
    getHandlers().onEvent(
      { type: 'sessionCreated', session: empty },
      { sessionId: 'sess_empty', seq: 1 },
    );

    const pending = client.selectSession('sess_empty');
    expect(client.sessionLoading.value).toBe(true);
    await pending.catch(() => {});
    expect(client.sessionLoading.value).toBe(false);
  });

  it('raises the loading state when selecting a non-empty unloaded session', async () => {
    const { client, getHandlers } = await setup([]);
    await client.createSession('/repo');

    const filled = { ...session('sess_filled'), messageCount: 3 };
    getHandlers().onEvent(
      { type: 'sessionCreated', session: filled },
      { sessionId: 'sess_filled', seq: 1 },
    );

    const pending = client.selectSession('sess_filled');
    // A session with history shows the loading state until the snapshot arrives.
    expect(client.sessionLoading.value).toBe(true);
    await pending.catch(() => {});
  });

  it('re-subscribes an L1 hit with the reducer-maintained latest seq', async () => {
    const initial = userMessage('sess_1', 'msg_1');
    const { api, client, eventConn, getHandlers } = await setup([initial]);

    await client.createSession('/repo');
    expect(api.getSessionSnapshot).toHaveBeenCalledTimes(1);
    expect(eventConn.subscribe).toHaveBeenLastCalledWith('sess_1', {
      seq: 0,
      epoch: 'ep_test',
    });

    getHandlers().onEvent(
      { type: 'messageCreated', message: userMessage('sess_1', 'msg_2') },
      { sessionId: 'sess_1', seq: 7 },
    );

    await client.selectSession('sess_1');

    expect(api.getSessionSnapshot).toHaveBeenCalledTimes(1);
    expect(eventConn.subscribe).toHaveBeenLastCalledWith('sess_1', {
      seq: 7,
      epoch: 'ep_test',
    });
  });

  it('marks a background session unread on idle and clears it on open', async () => {
    const { client, getHandlers } = await setup([]);
    await client.createSession('/repo'); // sess_1 is active

    const bg = session('sess_bg');
    getHandlers().onEvent(
      { type: 'sessionCreated', session: bg },
      { sessionId: 'sess_bg', seq: 1 },
    );

    // A background session finishing a turn lights up its unread dot.
    getHandlers().onEvent(
      { type: 'sessionStatusChanged', sessionId: 'sess_bg', status: 'idle', previousStatus: 'running' },
      { sessionId: 'sess_bg', seq: 2 },
    );
    expect(client.unreadBySession.value['sess_bg']).toBe(true);

    // The ACTIVE session finishing does not mark itself unread.
    getHandlers().onEvent(
      { type: 'sessionStatusChanged', sessionId: 'sess_1', status: 'idle', previousStatus: 'running' },
      { sessionId: 'sess_1', seq: 3 },
    );
    expect(client.unreadBySession.value['sess_1']).toBeUndefined();

    // Opening the background session clears its unread flag.
    await client.selectSession('sess_bg').catch(() => {});
    expect(client.unreadBySession.value['sess_bg']).toBeUndefined();
  });

  it('uses the fast moon class only for high-speed active-session output', async () => {
    vi.useFakeTimers();
    try {
      const { client, getHandlers } = await setup([]);
      await client.createSession('/repo');

      getHandlers().onEvent(
        { type: 'assistantDelta', sessionId: 'sess_bg', messageId: 'msg_bg', contentIndex: 0, delta: { text: 'x'.repeat(80) } },
        { sessionId: 'sess_bg', seq: 1 },
      );
      expect(client.fastMoon.value).toBe(false);

      getHandlers().onEvent(
        { type: 'assistantDelta', sessionId: 'sess_1', messageId: 'msg_1', contentIndex: 0, delta: { text: 'x'.repeat(80) } },
        { sessionId: 'sess_1', seq: 2 },
      );
      expect(client.fastMoon.value).toBe(true);

      getHandlers().onEvent(
        { type: 'sessionStatusChanged', sessionId: 'sess_1', status: 'idle', previousStatus: 'running' },
        { sessionId: 'sess_1', seq: 3 },
      );
      expect(client.fastMoon.value).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it('fires a browser notification when a background session completes (opt-in)', async () => {
    NotificationMock.instances = [];
    vi.stubGlobal('Notification', NotificationMock);
    const { client, getHandlers } = await setup([]);
    await client.createSession('/repo'); // sess_1 active

    const bg = session('sess_bg');
    getHandlers().onEvent(
      { type: 'sessionCreated', session: bg },
      { sessionId: 'sess_bg', seq: 1 },
    );

    // Ensure notifications are off before testing opt-in behavior.
    await client.setNotifyOnComplete(false);

    // Off by default → no notification on completion.
    getHandlers().onEvent(
      { type: 'sessionStatusChanged', sessionId: 'sess_bg', status: 'idle', previousStatus: 'running' },
      { sessionId: 'sess_bg', seq: 2 },
    );
    expect(NotificationMock.instances).toHaveLength(0);

    // Opt in (permission already granted) → completion fires a notification.
    await client.setNotifyOnComplete(true);
    expect(client.notifyOnComplete.value).toBe(true);
    getHandlers().onEvent(
      { type: 'sessionStatusChanged', sessionId: 'sess_bg', status: 'idle', previousStatus: 'running' },
      { sessionId: 'sess_bg', seq: 3 },
    );
    expect(NotificationMock.instances).toHaveLength(1);
    expect(NotificationMock.instances[0]!.title).toBe('sess_bg');
  });

  it('keeps the optimistic user turn key stable after submit resolves', async () => {
    const { client, eventConn } = await setup([]);

    await client.createSession('/repo');
    await client.sendPrompt('hello');

    const userTurn = client.turns.value.find((turn) => turn.role === 'user');
    expect(userTurn?.id).toMatch(/^msg_opt_/);
    expect(eventConn.bindNextPromptId).toHaveBeenCalledWith('sess_1', 'pr_1');
  });

  it('merges a user message echo into the optimistic turn instead of appending', async () => {
    const { client, getHandlers } = await setup([]);

    await client.createSession('/repo');
    await client.sendPrompt('hello');
    const optimisticId = client.turns.value.find((turn) => turn.role === 'user')!.id;

    getHandlers().onEvent(
      {
        type: 'messageCreated',
        message: {
          id: 'msg_echo',
          sessionId: 'sess_1',
          role: 'user',
          content: [{ type: 'text', text: 'hello' }],
          createdAt: now,
          promptId: 'pr_1',
        },
      },
      { sessionId: 'sess_1', seq: 8 },
    );

    const userTurns = client.turns.value.filter((turn) => turn.role === 'user');
    expect(userTurns).toHaveLength(1);
    expect(userTurns[0]!.id).toBe(optimisticId);
  });

  it('keeps daemon config writes and configChanged events in client state', async () => {
    const { api, client, getHandlers } = await setup([]);

    await client.updateConfig({ defaultModel: 'kimi/k2' });

    expect(api.setConfig).toHaveBeenCalledWith({ defaultModel: 'kimi/k2' });
    expect(client.config.value?.defaultModel).toBe('kimi/k2');
    expect(client.defaultModel.value).toBe('kimi/k2');

    await client.createSession('/repo');
    getHandlers().onEvent(
      {
        type: 'configChanged',
        changedFields: ['default_model'],
        config: { providers: {}, defaultModel: 'openai/gpt-5' },
      },
      { sessionId: '__global__', seq: 8 },
    );

    expect(client.config.value?.defaultModel).toBe('openai/gpt-5');
    expect(client.defaultModel.value).toBe('openai/gpt-5');
  });
});

describe('session view-model status / busy', () => {
  it('surfaces the real lifecycle status and only spins for running', async () => {
    const { client, getHandlers } = await setup([]);
    await client.createSession('/repo'); // sess_1 active

    const bg = session('sess_bg');
    getHandlers().onEvent(
      { type: 'sessionCreated', session: bg },
      { sessionId: 'sess_bg', seq: 1 },
    );

    const find = () => client.sessions.value.find((s) => s.id === 'sess_bg')!;

    // Awaiting the user is NOT busy — the row must not show a working spinner.
    getHandlers().onEvent(
      { type: 'sessionStatusChanged', sessionId: 'sess_bg', status: 'awaitingApproval', previousStatus: 'running' },
      { sessionId: 'sess_bg', seq: 2 },
    );
    expect(find().status).toBe('awaitingApproval');
    expect(find().busy).toBe(false);

    // Aborted is a distinct, non-busy state (not collapsed to idle).
    getHandlers().onEvent(
      { type: 'sessionStatusChanged', sessionId: 'sess_bg', status: 'aborted', previousStatus: 'awaitingApproval' },
      { sessionId: 'sess_bg', seq: 3 },
    );
    expect(find().status).toBe('aborted');
    expect(find().busy).toBe(false);

    // Running (no tasks loaded yet → trust the status) IS busy.
    getHandlers().onEvent(
      { type: 'sessionStatusChanged', sessionId: 'sess_bg', status: 'running', previousStatus: 'aborted' },
      { sessionId: 'sess_bg', seq: 4 },
    );
    expect(find().status).toBe('running');
    expect(find().busy).toBe(true);
  });

  it('treats an aborted turn as a turn end (flushes like idle)', async () => {
    const { client, getHandlers } = await setup([]);
    await client.createSession('/repo'); // sess_1 active

    const bg = session('sess_bg');
    getHandlers().onEvent(
      { type: 'sessionCreated', session: bg },
      { sessionId: 'sess_bg', seq: 1 },
    );

    // Aborting a background turn must run the same turn-end cleanup as idle —
    // observable here as the unread dot lighting up.
    getHandlers().onEvent(
      { type: 'sessionStatusChanged', sessionId: 'sess_bg', status: 'aborted', previousStatus: 'running' },
      { sessionId: 'sess_bg', seq: 2 },
    );
    expect(client.unreadBySession.value['sess_bg']).toBe(true);
  });
});

describe('unread persistence across reload', () => {
  it('restores unread dots from storage and clears them on open', async () => {
    try { localStorage.removeItem('kimi-web.unread'); } catch { /* ignore */ }
    try {
      // First "page load": a background session finishes a turn → unread.
      const first = await setup([]);
      await first.client.createSession('/repo');
      first.getHandlers().onEvent(
        { type: 'sessionCreated', session: session('sess_bg') },
        { sessionId: 'sess_bg', seq: 1 },
      );
      first.getHandlers().onEvent(
        { type: 'sessionStatusChanged', sessionId: 'sess_bg', status: 'idle', previousStatus: 'running' },
        { sessionId: 'sess_bg', seq: 2 },
      );
      expect(first.client.unreadBySession.value['sess_bg']).toBe(true);

      // Refresh: a brand-new client (vi.resetModules) seeds unread from storage
      // instead of starting empty — the dot survives the reload.
      const second = await setup([]);
      expect(second.client.unreadBySession.value['sess_bg']).toBe(true);

      // Opening the session clears the flag and the persisted entry.
      await second.client.selectSession('sess_bg').catch(() => {});
      expect(second.client.unreadBySession.value['sess_bg']).toBeUndefined();

      const third = await setup([]);
      expect(third.client.unreadBySession.value['sess_bg']).toBeUndefined();
    } finally {
      try { localStorage.removeItem('kimi-web.unread'); } catch { /* ignore */ }
    }
  });
});

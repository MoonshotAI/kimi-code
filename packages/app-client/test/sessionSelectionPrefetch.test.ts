import { ref } from 'vue';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { AppSession } from '@moonshot-ai/app-core/api';
import { resetKimiClientDeps, setKimiClientDeps } from '../src/client/deps';
import { createSessionSelection } from '../src/client/sessionSelection';
import { createConversationPool } from '../src/composables/useConversations';
import { noopProductTracker, setProductTracker } from '../src/contracts';
import { sessionsStore } from '../src/stores/sessions';
import { setWorkspacesHooks, workspacesStore } from '../src/stores/workspaces';

function session(id: string): AppSession {
  return {
    id,
    title: id,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    busy: false,
    archived: false,
    cwd: '/workspace',
    model: 'kimi',
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
    messageCount: 1,
    workspaceId: 'workspace',
  };
}

describe('session selection transcript prefetch', () => {
  beforeEach(() => {
    sessionsStore().setSessions([session('a'), session('b')]);
    sessionsStore().setActiveSessionId('a');
    setKimiClientDeps({
      api: () => ({
        getGitStatus: vi.fn().mockRejectedValue(new Error('not needed')),
        getSessionGoal: vi.fn(async () => null),
        getSessionWarnings: vi.fn(async () => []),
      }),
      t: (key) => key,
    });
    setProductTracker({ track: vi.fn() });
  });

  afterEach(() => {
    setWorkspacesHooks(null);
    resetKimiClientDeps();
    setProductTracker(noopProductTracker);
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('subscribes the conversation before the active session flips', async () => {
    const order: string[] = [];
    const selection = createSessionSelection({
      modelProvider: { skillsBySession: ref({}), loadSkillsForSession: vi.fn() } as never,
      appendSession: sessionsStore().appendSession,
      setActiveSessionId: (id) => {
        order.push(`activate:${id}`);
        sessionsStore().setActiveSessionId(id);
      },
      noteSessionWatermark: vi.fn(),
      hasLoadedMessages: () => false,
      whenMainConversationLoaded: () => new Promise<void>(() => {}),
      prefetchMainConversation: (id) => {
        order.push(`prefetch:${id}`);
      },
      markSessionStatusSettled: vi.fn(),
      writeSessionUrl: vi.fn(),
      setMainView: vi.fn(),
      setSessionLoading: (loading) => {
        order.push(`loading:${loading}`);
      },
    });

    await selection.selectSession('b', { urlMode: 'none' });

    expect(order[0]).toBe('prefetch:b');
    expect(order).toEqual(['prefetch:b', 'loading:true', 'activate:b']);
  });
  it.each(['resolve', 'reject'] as const)('clears loading when opening a draft before the old transcript %ss', async (outcome) => {
    let loading = false;
    const oldBaseline = Promise.withResolvers<void>();
    const nextBaseline = Promise.withResolvers<void>();
    const setLoading = (value: boolean) => { loading = value; };
    const setActiveSessionId = (id: string | undefined) => sessionsStore().setActiveSessionId(id);
    const selection = createSessionSelection({
      modelProvider: { skillsBySession: ref({}), loadSkillsForSession: vi.fn() } as never,
      appendSession: sessionsStore().appendSession,
      setActiveSessionId,
      noteSessionWatermark: vi.fn(),
      hasLoadedMessages: () => false,
      whenMainConversationLoaded: (id) => id === 'a' ? oldBaseline.promise : nextBaseline.promise,
      markSessionStatusSettled: vi.fn(),
      writeSessionUrl: vi.fn(),
      setMainView: vi.fn(),
      setSessionLoading: setLoading,
    });
    setWorkspacesHooks({
      selectSession: selection.selectSession,
      setActiveSessionId,
      setSessionLoading: setLoading,
      setMainView: vi.fn(),
      writeSessionUrl: vi.fn(),
    });

    await selection.selectSession('a', { urlMode: 'none' });
    expect(loading).toBe(true);
    workspacesStore().openWorkspaceDraft('workspace', { entry: 'newChat' });
    expect(sessionsStore().activeSessionId).toBeUndefined();
    expect(loading).toBe(false);

    await selection.selectSession('b', { urlMode: 'none' });
    expect(loading).toBe(true);
    if (outcome === 'resolve') oldBaseline.resolve();
    else oldBaseline.reject(new Error('old transcript failed'));
    await Promise.resolve();
    expect(sessionsStore().activeSessionId).toBe('b');
    expect(loading).toBe(true);

    nextBaseline.resolve();
    await Promise.resolve();
    expect(loading).toBe(false);
  });

  it('ends loading without retrying when the conversation fails', async () => {
    const pool = createConversationPool({
      api: () => { throw new Error('not used'); },
      connection: () => null,
      maxParked: 3,
    });
    const whenMainConversationLoaded = vi.fn((sessionId: string) => {
      const entry = pool.getEntry(sessionId, 'main');
      return entry === undefined ? Promise.resolve() : pool.whenLoaded(entry);
    });
    const setSessionLoading = vi.fn();
    const trackMock = vi.fn();
    setProductTracker({ track: trackMock });
    vi.spyOn(performance, 'now').mockReturnValue(0);
    vi.stubGlobal('requestAnimationFrame', (callback: () => void) => callback());
    const selection = createSessionSelection({
      modelProvider: { skillsBySession: ref({}), loadSkillsForSession: vi.fn() } as never,
      appendSession: sessionsStore().appendSession,
      setActiveSessionId: sessionsStore().setActiveSessionId,
      noteSessionWatermark: vi.fn(),
      hasLoadedMessages: (sessionId) => pool.getEntry(sessionId, 'main')?.loaded === true,
      whenMainConversationLoaded,
      prefetchMainConversation: (sessionId) => { pool.prefetch(sessionId, 'main'); },
      markSessionStatusSettled: vi.fn(),
      writeSessionUrl: vi.fn(),
      setMainView: vi.fn(),
      setSessionLoading,
    });
    const openEvents = () => trackMock.mock.calls.filter(([event]) => event === 'session_open_timing');

    await selection.selectSession('b', { urlMode: 'none' });
    pool.failSession('b', { code: 40932, msg: 'session stale' });
    await new Promise<void>((resolve) => setTimeout(resolve, 0));

    expect(whenMainConversationLoaded).toHaveBeenCalledTimes(1);
    expect(setSessionLoading).toHaveBeenLastCalledWith(false);
    expect(openEvents()).toEqual([]);
  });

});

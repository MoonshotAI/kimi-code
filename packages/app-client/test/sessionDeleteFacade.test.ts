import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppSession, KimiWebApi } from '@moonshot-ai/app-core/api';
import { resetKimiClientDeps, setKimiClientDeps } from '../src/client/deps';

const clientApiMock: Record<string, unknown> = {};

beforeEach(() => {
  setKimiClientDeps({ api: () => clientApiMock as unknown as KimiWebApi, t: (key) => key });
  for (const key of Object.keys(clientApiMock)) delete clientApiMock[key];
});

afterEach(() => {
  resetKimiClientDeps();
});

function stubEventConnection(): void {
  clientApiMock.connectEvents = vi.fn(() => ({
    subscribeConversation: vi.fn(),
    unsubscribeConversation: vi.fn(),
    health: () => ({ connected: true, open: true, stale: false }),
    reconnect: vi.fn(),
    close: vi.fn(),
  }));
}

async function freshFacade() {
  vi.stubGlobal('WebSocket', class {});
  vi.resetModules();
  const { useKimiWebClient } = await import('../src/client/useKimiWebClient');
  const { sessionsStore } = await import('../src/stores/sessions');
  const { useConfirmDialog } = await import('../src/composables/useConfirmDialog');
  return {
    client: useKimiWebClient(),
    sessions: sessionsStore(),
    confirmDialog: useConfirmDialog(),
  };
}

function session(id: string): AppSession {
  return {
    id,
    title: `title-${id}`,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    busy: false,
    archived: false,
    cwd: '/workspace',
    model: '',
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
    messageCount: 0,
  } as AppSession;
}

describe('session deletion hook', () => {
  it('reports a deletion only for sessions that are really deleted, not archived ones', async () => {
    const destroyed = vi.fn();
    const deleted = vi.fn();
    setKimiClientDeps({ api: () => clientApiMock as unknown as KimiWebApi, t: (key) => key, onSessionDestroyed: destroyed, onSessionDeleted: deleted });
    stubEventConnection();
    clientApiMock.deleteSession = vi.fn().mockResolvedValue({ deleted: true });
    clientApiMock.archiveSession = vi.fn().mockResolvedValue(undefined);
    const { client, sessions, confirmDialog } = await freshFacade();
    sessions.setSessions([session('s1'), session('s2'), session('s3')]);

    await client.archiveSessionWithToast('s2');
    expect(clientApiMock.archiveSession).toHaveBeenCalledWith('s2');
    expect(destroyed).toHaveBeenCalledWith('s2');
    expect(deleted).not.toHaveBeenCalled();

    const pending = client.deleteSessionWithToast('s1');
    await confirmDialog.runAction();
    await pending;
    expect(deleted.mock.calls).toEqual([['s1']]);
  });
});

describe('deleteSessionWithToast', () => {
  it('aborts without calling the API when the confirm dialog is cancelled', async () => {
    stubEventConnection();
    clientApiMock.deleteSession = vi.fn().mockResolvedValue({ deleted: true });
    const { client, sessions, confirmDialog } = await freshFacade();
    sessions.setSessions([session('s1'), session('s2')]);

    const pending = client.deleteSessionWithToast('s1');
    expect(confirmDialog.current.value?.variant).toBe('danger');
    const { onToast } = await import('../src/client/toast');
    const shownTitles: string[] = [];
    const off = onToast((event) => {
      if (event.type === 'show') shownTitles.push(event.options?.title ?? '');
    });
    confirmDialog.settle(false);
    await pending;
    off();

    expect(clientApiMock.deleteSession).not.toHaveBeenCalled();
    expect(sessions.sessions.map((s) => s.id)).toEqual(['s1', 's2']);
    expect(shownTitles).toEqual([]);
  });

  it('deletes and shows the toast when the confirm dialog is accepted', async () => {
    stubEventConnection();
    clientApiMock.deleteSession = vi.fn().mockResolvedValue({ deleted: true });
    const { client, sessions, confirmDialog } = await freshFacade();
    sessions.setSessions([session('s1'), session('s2')]);

    const pending = client.deleteSessionWithToast('s1');
    const { onToast } = await import('../src/client/toast');
    const shownTitles: string[] = [];
    const off = onToast((event) => {
      if (event.type === 'show') shownTitles.push(event.options?.title ?? '');
    });
    await confirmDialog.runAction();
    await pending;
    off();

    expect(clientApiMock.deleteSession).toHaveBeenCalledTimes(1);
    expect(clientApiMock.deleteSession).toHaveBeenCalledWith('s1');
    expect(sessions.sessions.map((s) => s.id)).toEqual(['s2']);
    expect(shownTitles).toContain('sidebar.deleteToast');
  });

  it('keeps the session and omits the success toast after a failed request', async () => {
    stubEventConnection();
    clientApiMock.deleteSession = vi.fn().mockRejectedValue(new Error('delete failed'));
    const { client, sessions, confirmDialog } = await freshFacade();
    sessions.setSessions([session('s1')]);
    sessions.setActiveSessionId('s1');

    const pending = client.deleteSessionWithToast('s1');
    const { onToast } = await import('../src/client/toast');
    const shownTitles: string[] = [];
    const off = onToast((event) => {
      if (event.type === 'show') shownTitles.push(event.options?.title ?? '');
    });
    await confirmDialog.runAction();
    await pending;
    off();

    expect(sessions.sessions.map((s) => s.id)).toEqual(['s1']);
    expect(sessions.activeSessionId).toBe('s1');
    expect(shownTitles).not.toContain('sidebar.deleteToast');
  });

  it('keeps confirmation busy and sends only once while deletion is pending', async () => {
    stubEventConnection();
    let finish!: (value: { deleted: true }) => void;
    clientApiMock.deleteSession = vi.fn(() => new Promise(resolve => { finish = resolve; }));
    const { client, sessions, confirmDialog } = await freshFacade();
    sessions.setSessions([session('s1')]);

    const pending = client.deleteSessionWithToast('s1');
    const action = confirmDialog.runAction();
    expect(confirmDialog.busy.value).toBe(true);
    await confirmDialog.runAction();
    confirmDialog.settle(false);
    expect(confirmDialog.current.value).not.toBeNull();
    expect(clientApiMock.deleteSession).toHaveBeenCalledTimes(1);
    finish({ deleted: true });
    await action;
    await pending;
    expect(confirmDialog.busy.value).toBe(false);
    expect(sessions.sessions).toEqual([]);
  });

  it('clears the deleted draft before navigation and rejects delayed text and attachment saves', async () => {
    const stored = new Map<string, string>();
    vi.stubGlobal('localStorage', {
      getItem: (key: string) => stored.get(key) ?? null,
      setItem: (key: string, value: string) => stored.set(key, value),
      removeItem: (key: string) => stored.delete(key),
    });
    stubEventConnection();
    clientApiMock.deleteSession = vi.fn().mockResolvedValue({ deleted: true });
    const { client, sessions, confirmDialog } = await freshFacade();
    const { useComposerDraft } = await import('../src/composables/useComposerDraft');
    const { persistComposerDraftSnapshot } = await import('../src/lib/composerDraftLifecycle');
    const { nextTick, effectScope } = await import('vue');
    const scope = effectScope();
    try {
      sessions.setSessions([session('s1'), session('s2')]);
      sessions.setActiveSessionId('s1');
      stored.set('kimi-web.draft.s1', 'private draft');
      stored.set('kimi-web.draft-atts.s1', '[]');
      stored.set('kimi-web.draft.s2', 'other draft');
      const draft = scope.run(() => useComposerDraft({ sessionId: () => sessions.activeSessionId }))!;
      const pending = client.deleteSessionWithToast('s1');
      await confirmDialog.runAction();
      await pending;
      await nextTick();
      expect(draft.text.value).toBe('other draft');
      expect(stored.has('kimi-web.draft.s1')).toBe(false);
      expect(stored.has('kimi-web.draft-atts.s1')).toBe(false);
      const entries = [{ attId: 'a1', key: 'file:///secret.txt', kind: 'file' as const, name: 'secret.txt', refCount: 1, uploading: false }];
      draft.saveDraft('s1', 'late draft');
      draft.saveDraftAttachments('s1', entries);
      persistComposerDraftSnapshot('s1', 'late failed send', entries);
      expect(stored.has('kimi-web.draft.s1')).toBe(false);
      expect(stored.has('kimi-web.draft-atts.s1')).toBe(false);
      expect(stored.get('kimi-web.draft.s2')).toBe('other draft');
    } finally {
      scope.stop();
      vi.unstubAllGlobals();
    }
  });

  it('moves to the next session when the deleted session was active', async () => {
    stubEventConnection();
    clientApiMock.deleteSession = vi.fn().mockResolvedValue({ deleted: true });
    const { client, sessions, confirmDialog } = await freshFacade();
    sessions.setSessions([session('s1'), session('s2')]);
    sessions.setActiveSessionId('s1');

    const pending = client.deleteSessionWithToast('s1');
    await confirmDialog.runAction();
    await pending;

    expect(sessions.activeSessionId).toBe('s2');
  });

  it('clears to the draft state when the deleted active session was the last one', async () => {
    stubEventConnection();
    clientApiMock.deleteSession = vi.fn().mockResolvedValue({ deleted: true });
    const { client, sessions, confirmDialog } = await freshFacade();
    sessions.setSessions([session('s1')]);
    sessions.setActiveSessionId('s1');

    const pending = client.deleteSessionWithToast('s1');
    await confirmDialog.runAction();
    await pending;

    expect(sessions.sessions).toEqual([]);
    expect(sessions.activeSessionId).toBeUndefined();
  });

  it('tombstones an archived session deleted from the archived settings page', async () => {
    stubEventConnection();
    clientApiMock.deleteSession = vi.fn().mockResolvedValue({ deleted: true });
    const { client, confirmDialog } = await freshFacade();
    const { sessionListStore } = await import('../src/stores/sessionList');
    sessionListStore().doneSessions = [{ ...session('s9'), archived: true }] as never;

    const pending = client.deleteSessionWithToast('s9');
    await confirmDialog.runAction();
    await pending;

    expect(clientApiMock.deleteSession).toHaveBeenCalledWith('s9');
    expect(client.isSessionDeleted('s9')).toBe(true);
    expect(sessionListStore().doneSessions).toEqual([]);
  });

  it('prefers the caller-provided title over the raw id in the confirm message', async () => {
    stubEventConnection();
    clientApiMock.deleteSession = vi.fn().mockResolvedValue({ deleted: true });
    setKimiClientDeps({
      api: () => clientApiMock as unknown as KimiWebApi,
      t: (key, params) => `${key}:${typeof params?.title === 'string' ? params.title : ''}`,
    });
    const { client, sessions, confirmDialog } = await freshFacade();
    sessions.setSessions([session('s1')]);

    const pending = client.deleteSessionWithToast('sess/opaque-id', { title: 'Refactor auth flow' });
    expect(confirmDialog.current.value?.message).toBe('sidebar.deleteConfirmMessage:Refactor auth flow');
    await confirmDialog.runAction();
    await pending;

    const fallback = client.deleteSessionWithToast('sess/another-id');
    expect(confirmDialog.current.value?.message).toBe('sidebar.deleteConfirmMessage:sess/another-id');
    confirmDialog.settle(false);
    await fallback;
  });
});

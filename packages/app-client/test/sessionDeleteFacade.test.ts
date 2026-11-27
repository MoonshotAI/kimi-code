import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppSession, AppSessionWorktree, KimiWebApi } from '@moonshot-ai/app-core/api';
import type { ToastOptions } from '@moonshot-ai/app-ui';
import { resetKimiClientDeps, setKimiClientDeps } from '../src/client/deps';
import { appSession, sessionWorktree } from '../src/testing/worktreeFixtures';

const clientApiMock: Record<string, unknown> = {};

beforeEach(() => {
  setKimiClientDeps({ api: () => clientApiMock as unknown as KimiWebApi, t: (key) => key });
  for (const key of Object.keys(clientApiMock)) delete clientApiMock[key];
  clientApiMock.connectEvents = vi.fn(() => ({
    subscribeConversation: vi.fn(),
    unsubscribeConversation: vi.fn(),
    health: () => ({ connected: true, open: true, stale: false }),
    reconnect: vi.fn(),
    close: vi.fn(),
  }));
  clientApiMock.inspectWorktrees = vi.fn(async (paths: string[]) => ({
    items: paths.map((path) => ({ path, branch: 'kimi/a', uncommittedFiles: 2, unpushedCommits: 0, sessions: [] })),
    errors: {},
  }));
  clientApiMock.listWorktrees = vi.fn(async () => ({ items: [] }));
  clientApiMock.deleteSession = vi.fn().mockResolvedValue({ deleted: true });
});

afterEach(() => {
  resetKimiClientDeps();
  vi.unstubAllGlobals();
});

async function freshFacade() {
  vi.stubGlobal('WebSocket', class { close(): void {} });
  vi.resetModules();
  const { useKimiWebClient } = await import('../src/client/useKimiWebClient');
  const { sessionsStore } = await import('../src/stores/sessions');
  const { worktreesStore } = await import('../src/stores/worktrees');
  const { useConfirmDialog } = await import('../src/composables/useConfirmDialog');
  const { useWorktreeManageDialogs, registerWorktreeSettingsOpener } = await import(
    '../src/composables/useWorktreeManageDialogs'
  );
  const { onToast } = await import('../src/client/toast');
  const toasts: ToastOptions[] = [];
  onToast((event) => {
    if (event.type === 'show' && event.options !== undefined) toasts.push(event.options);
  });
  return {
    client: useKimiWebClient(),
    sessions: sessionsStore(),
    worktrees: worktreesStore(),
    confirmDialog: useConfirmDialog(),
    dialogs: useWorktreeManageDialogs(),
    registerWorktreeSettingsOpener,
    toasts,
  };
}

function session(id: string, extra: Partial<AppSession> = {}): AppSession {
  return appSession({ id, title: `title-${id}`, ...extra });
}

function worktree(status: AppSessionWorktree['setup']['status'], extra: Partial<AppSessionWorktree> = {}) {
  return sessionWorktree(status, { path: '/wt/a', branch: 'kimi/a', ...extra });
}

function waitFor(check: () => void): Promise<void> {
  return vi.waitFor(check, { interval: 1 });
}

async function openDeleteDialog(
  facade: Awaited<ReturnType<typeof freshFacade>>,
  sessions: AppSession[] = [session('s1', { worktree: worktree('ready') })],
) {
  facade.sessions.setSessions(sessions);
  const pending = facade.client.deleteSessionWithToast('s1');
  await waitFor(() => expect(facade.dialogs.deleteDialog.value).not.toBeNull());
  return { ...facade, pending };
}

describe('deleting a worktree session', () => {
  beforeEach(() => {
    clientApiMock.deleteSession = vi.fn().mockResolvedValue({ deleted: true, worktree: { outcome: 'removed' } });
  });

  it('asks in the worktree dialog and removes the worktree and the chosen branch with the session', async () => {
    const { sessions, dialogs, confirmDialog, toasts, pending } = await openDeleteDialog(await freshFacade(), [
      session('s1', { worktree: worktree('ready') }),
      session('s2'),
    ]);

    expect(clientApiMock.inspectWorktrees).toHaveBeenCalledWith(['/wt/a']);
    expect(confirmDialog.current.value).toBeNull();
    expect(dialogs.deleteDialog.value).toMatchObject({
      kind: 'session',
      sessionId: 's1',
      title: 'title-s1',
      branch: 'kimi/a',
      otherSessions: 0,
      risk: { uncommittedFiles: 2, unpushedCommits: 0 },
    });

    dialogs.setDeleteBranch(true);
    dialogs.confirmDeletion();
    await pending;

    expect(clientApiMock.deleteSession).toHaveBeenCalledWith('s1', { removeWorktree: true, deleteBranch: true });
    expect(sessions.sessions.map((entry) => entry.id)).toEqual(['s2']);
    expect(toasts.map((entry) => entry.title)).toEqual(['sidebar.deleteToast']);
  });

  it.each(['kept_in_use', 'missing'] as const)('shows the usual toast when the directory outcome is %s', async (outcome) => {
    clientApiMock.deleteSession = vi.fn().mockResolvedValue({ deleted: true, worktree: { outcome } });
    const { dialogs, worktrees, toasts, pending } = await openDeleteDialog(await freshFacade());
    dialogs.confirmDeletion();
    await pending;

    expect(toasts.map((entry) => entry.title)).toEqual(['sidebar.deleteToast']);
    expect(worktrees.removals).toEqual([]);
  });

  it('reports a directory that could not be deleted and keeps it for the management page', async () => {
    clientApiMock.deleteSession = vi
      .fn()
      .mockResolvedValue({ deleted: true, worktree: { outcome: 'failed', output: 'Directory not empty' } });
    const opened = vi.fn();
    const facade = await freshFacade();
    facade.registerWorktreeSettingsOpener(opened);
    const { sessions, dialogs, worktrees, toasts, pending } = await openDeleteDialog(facade);
    dialogs.confirmDeletion();
    await pending;

    expect(sessions.sessions).toEqual([]);
    expect(toasts).toHaveLength(1);
    expect(toasts[0]).toMatchObject({
      layout: 'bar',
      title: 'worktreeManage.toastSessionDirectoryKept',
      duration: 8000,
    });
    expect(toasts[0]?.actions?.map((action) => action.label)).toEqual(['worktreeManage.manage']);
    void toasts[0]?.actions?.[0]?.onClick({ dismiss: () => undefined });
    expect(opened).toHaveBeenCalledOnce();
    expect(worktrees.removalFor('/wt/a')).toMatchObject({
      state: 'failed',
      branch: 'kimi/a',
      output: 'Directory not empty',
    });
    expect(worktrees.deletedSessionTitles).toEqual({ '/wt/a': 'title-s1' });
  });

  it('deletes nothing when the dialog is cancelled', async () => {
    const { sessions, dialogs, toasts, pending } = await openDeleteDialog(await freshFacade());
    dialogs.closeDeleteDialog();
    await pending;

    expect(clientApiMock.deleteSession).not.toHaveBeenCalled();
    expect(sessions.sessions.map((entry) => entry.id)).toEqual(['s1']);
    expect(toasts).toEqual([]);
  });

  it('uses the worktree passed by the archived sessions page', async () => {
    const { client, dialogs } = await freshFacade();

    const pending = client.deleteSessionWithToast('s9', { title: 'Archived one', worktree: worktree('ready') });
    await waitFor(() => expect(dialogs.deleteDialog.value).not.toBeNull());
    expect(dialogs.deleteDialog.value).toMatchObject({ kind: 'session', title: 'Archived one' });
    dialogs.confirmDeletion();
    await pending;

    expect(clientApiMock.deleteSession).toHaveBeenCalledWith('s9', { removeWorktree: true, deleteBranch: false });
  });
});

describe('sessions that keep the plain dialog', () => {
  it.each([
    ['a local session', undefined],
    ['a session whose worktree directory is flagged missing', worktree('ready', { missing: true })],
  ])('asks the plain question for %s and leaves the directory alone', async (_name, attached) => {
    const { client, sessions, dialogs, confirmDialog } = await freshFacade();
    sessions.setSessions([session('s1', attached === undefined ? {} : { worktree: attached })]);

    const pending = client.deleteSessionWithToast('s1');
    await waitFor(() => expect(confirmDialog.current.value).not.toBeNull());

    expect(dialogs.deleteDialog.value).toBeNull();
    expect(clientApiMock.inspectWorktrees).not.toHaveBeenCalled();
    expect(confirmDialog.current.value?.message).toBe('sidebar.deleteConfirmMessage');
    await confirmDialog.runAction();
    await pending;

    expect(clientApiMock.deleteSession).toHaveBeenCalledWith('s1');
  });

  it('falls back to the plain question when the worktree directory turns out to be gone', async () => {
    clientApiMock.inspectWorktrees = vi.fn(async () => ({
      items: [],
      errors: { '/wt/a': { code: 40423, msg: 'not found' } },
    }));
    const { client, sessions, dialogs, confirmDialog } = await freshFacade();
    sessions.setSessions([session('s1', { worktree: worktree('ready') })]);

    const pending = client.deleteSessionWithToast('s1');
    await waitFor(() => expect(confirmDialog.current.value).not.toBeNull());

    expect(dialogs.deleteDialog.value).toBeNull();
    await confirmDialog.runAction();
    await pending;

    expect(clientApiMock.deleteSession).toHaveBeenCalledWith('s1');
  });
});

describe('session deletion hook', () => {
  it('reports a deletion only for sessions that are really deleted, not archived ones', async () => {
    const destroyed = vi.fn();
    const deleted = vi.fn();
    setKimiClientDeps({ api: () => clientApiMock as unknown as KimiWebApi, t: (key) => key, onSessionDestroyed: destroyed, onSessionDeleted: deleted });
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
    const { client, sessions, confirmDialog, toasts } = await freshFacade();
    sessions.setSessions([session('s1'), session('s2')]);

    const pending = client.deleteSessionWithToast('s1');
    expect(confirmDialog.current.value?.variant).toBe('danger');
    confirmDialog.settle(false);
    await pending;

    expect(clientApiMock.deleteSession).not.toHaveBeenCalled();
    expect(sessions.sessions.map((s) => s.id)).toEqual(['s1', 's2']);
    expect(toasts).toEqual([]);
  });

  it('deletes and shows the toast when the confirm dialog is accepted', async () => {
    const { client, sessions, confirmDialog, toasts } = await freshFacade();
    sessions.setSessions([session('s1'), session('s2')]);

    const pending = client.deleteSessionWithToast('s1');
    await confirmDialog.runAction();
    await pending;

    expect(clientApiMock.deleteSession).toHaveBeenCalledExactlyOnceWith('s1');
    expect(sessions.sessions.map((s) => s.id)).toEqual(['s2']);
    expect(toasts.map((entry) => entry.title)).toContain('sidebar.deleteToast');
  });

  it('keeps the session and omits the success toast after a failed request', async () => {
    clientApiMock.deleteSession = vi.fn().mockRejectedValue(new Error('delete failed'));
    const { client, sessions, confirmDialog, toasts } = await freshFacade();
    sessions.setSessions([session('s1')]);
    sessions.setActiveSessionId('s1');

    const pending = client.deleteSessionWithToast('s1');
    await confirmDialog.runAction();
    await pending;

    expect(sessions.sessions.map((s) => s.id)).toEqual(['s1']);
    expect(sessions.activeSessionId).toBe('s1');
    expect(toasts.map((entry) => entry.title)).not.toContain('sidebar.deleteToast');
  });

  it('keeps confirmation busy and sends only once while deletion is pending', async () => {
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
    const { client, sessions, confirmDialog } = await freshFacade();
    sessions.setSessions([session('s1'), session('s2')]);
    sessions.setActiveSessionId('s1');

    const pending = client.deleteSessionWithToast('s1');
    await confirmDialog.runAction();
    await pending;

    expect(sessions.activeSessionId).toBe('s2');
  });

  it('clears to the draft state when the deleted active session was the last one', async () => {
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

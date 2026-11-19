import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppSession, AppSessionWorktree, KimiWebApi } from '@moonshot-ai/app-core/api';
import type { ToastOptions } from '@moonshot-ai/app-ui';
import { resetKimiClientDeps, setKimiClientDeps } from '../src/client/deps';

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
  clientApiMock.deleteSession = vi.fn().mockResolvedValue({ deleted: true, worktree: { outcome: 'removed' } });
});

afterEach(() => {
  resetKimiClientDeps();
  vi.unstubAllGlobals();
});

async function freshFacade() {
  vi.stubGlobal('WebSocket', class {});
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

function worktree(status: AppSessionWorktree['setup']['status'], extra: Partial<AppSessionWorktree> = {}) {
  return {
    path: '/wt/a',
    branch: 'kimi/a',
    setup: { status, purpose: 'create', request: {}, steps: [], commandsRan: 0, startedAt: '', script: 'none' },
    ...extra,
  } as AppSessionWorktree;
}

function session(id: string, extra: Partial<AppSession> = {}): AppSession {
  return {
    id,
    title: `title-${id}`,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    busy: false,
    archived: false,
    cwd: '/workspace',
    model: '',
    messageCount: 0,
    ...extra,
  } as AppSession;
}

describe('deleting a worktree session', () => {
  it('asks in the worktree dialog and removes the worktree with the session', async () => {
    const { client, sessions, dialogs, confirmDialog, toasts } = await freshFacade();
    sessions.setSessions([session('s1', { worktree: worktree('ready') }), session('s2')]);

    const pending = client.deleteSessionWithToast('s1');
    await vi.waitFor(() => expect(dialogs.deleteDialog.value).not.toBeNull());

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

    dialogs.confirmDeletion();
    await pending;

    expect(clientApiMock.deleteSession).toHaveBeenCalledWith('s1', { removeWorktree: true, deleteBranch: false });
    expect(sessions.sessions.map((entry) => entry.id)).toEqual(['s2']);
    expect(toasts.map((entry) => entry.title)).toEqual(['sidebar.deleteToast']);
  });

  it('passes the branch choice through', async () => {
    const { client, sessions, dialogs } = await freshFacade();
    sessions.setSessions([session('s1', { worktree: worktree('ready') })]);

    const pending = client.deleteSessionWithToast('s1');
    await vi.waitFor(() => expect(dialogs.deleteDialog.value).not.toBeNull());
    dialogs.setDeleteBranch(true);
    dialogs.confirmDeletion();
    await pending;

    expect(clientApiMock.deleteSession).toHaveBeenCalledWith('s1', { removeWorktree: true, deleteBranch: true });
  });

  it.each(['kept_in_use', 'missing'] as const)('shows the usual toast when the directory outcome is %s', async (outcome) => {
    clientApiMock.deleteSession = vi.fn().mockResolvedValue({ deleted: true, worktree: { outcome } });
    const { client, sessions, dialogs, worktrees, toasts } = await freshFacade();
    sessions.setSessions([session('s1', { worktree: worktree('ready') })]);

    const pending = client.deleteSessionWithToast('s1');
    await vi.waitFor(() => expect(dialogs.deleteDialog.value).not.toBeNull());
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
    const { client, sessions, dialogs, worktrees, toasts, registerWorktreeSettingsOpener } = await freshFacade();
    registerWorktreeSettingsOpener(opened);
    sessions.setSessions([session('s1', { worktree: worktree('ready') })]);

    const pending = client.deleteSessionWithToast('s1');
    await vi.waitFor(() => expect(dialogs.deleteDialog.value).not.toBeNull());
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
    const { client, sessions, dialogs, toasts } = await freshFacade();
    sessions.setSessions([session('s1', { worktree: worktree('ready') })]);

    const pending = client.deleteSessionWithToast('s1');
    await vi.waitFor(() => expect(dialogs.deleteDialog.value).not.toBeNull());
    dialogs.closeDeleteDialog();
    await pending;

    expect(clientApiMock.deleteSession).not.toHaveBeenCalled();
    expect(sessions.sessions.map((entry) => entry.id)).toEqual(['s1']);
    expect(toasts).toEqual([]);
  });

  it('uses the worktree passed by the archived sessions page', async () => {
    const { client, dialogs } = await freshFacade();

    const pending = client.deleteSessionWithToast('s9', { title: 'Archived one', worktree: worktree('ready') });
    await vi.waitFor(() => expect(dialogs.deleteDialog.value).not.toBeNull());
    expect(dialogs.deleteDialog.value).toMatchObject({ kind: 'session', title: 'Archived one' });
    dialogs.confirmDeletion();
    await pending;

    expect(clientApiMock.deleteSession).toHaveBeenCalledWith('s9', { removeWorktree: true, deleteBranch: false });
  });
});

describe('sessions that keep the plain dialog', () => {
  it.each([
    ['a local session', undefined],
    ['a session still setting up its worktree', worktree('running', { path: undefined })],
    ['a session that chose local mode', worktree('local', { path: undefined })],
    ['a session whose worktree directory is flagged missing', worktree('ready', { missing: true })],
  ])('asks the plain question for %s and leaves the directory alone', async (_name, sessionWorktree) => {
    const { client, sessions, dialogs, confirmDialog } = await freshFacade();
    sessions.setSessions([session('s1', sessionWorktree === undefined ? {} : { worktree: sessionWorktree })]);

    const pending = client.deleteSessionWithToast('s1');
    await vi.waitFor(() => expect(confirmDialog.current.value).not.toBeNull());

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
    await vi.waitFor(() => expect(confirmDialog.current.value).not.toBeNull());

    expect(dialogs.deleteDialog.value).toBeNull();
    await confirmDialog.runAction();
    await pending;

    expect(clientApiMock.deleteSession).toHaveBeenCalledWith('s1');
  });
});

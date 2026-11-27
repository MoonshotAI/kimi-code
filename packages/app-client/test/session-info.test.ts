import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { AppSession, AppWorkspace, GitStatusEntry, GitStatusBatchResult, PullRequestBatchResult } from '@moonshot-ai/app-core/api';
import type { WorkspaceFolder } from '@moonshot-ai/app-core/client';
import { resetKimiClientDeps, setKimiClientDeps } from '../src/client/deps';
import { sessionInfoStore } from '../src/stores/sessionInfo';
import { sessionsStore } from '../src/stores/sessions';
import { workspacesStore } from '../src/stores/workspaces';
import { sessionWorktree } from '../src/testing/worktreeFixtures';

const getKimiWebApiMock = vi.fn();

function gitStatus(branch: string): GitStatusEntry {
  return { branch, ahead: 0, behind: 0, entries: {}, additions: 1, deletions: 0, pullRequest: null };
}

function readyWorktree() {
  return sessionWorktree('ready', { path: '/wt/a', branch: 'kimi/a' });
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej });
  return { promise, resolve, reject };
}

function folders(...paths: string[]): WorkspaceFolder[] {
  return paths.map((path, index) => ({ path, primary: index === 0 }));
}

function seedWorkspace(id: string, root: string, additionalDirs: string[]): AppWorkspace {
  return { id, root, additionalDirs, name: id, kind: 'managed', sessionCount: 1 };
}

function statusBatch(results: Record<string, GitStatusEntry>, errors: GitStatusBatchResult['errors'] = {}): GitStatusBatchResult {
  return { results, errors };
}

function prBatch(
  results: PullRequestBatchResult['results'],
  errors: PullRequestBatchResult['errors'] = {},
  statuses: PullRequestBatchResult['statuses'] = {},
): PullRequestBatchResult {
  return { results, statuses, errors };
}

function mockBatches(getGitStatusBatch: unknown, getPullRequestBatch = vi.fn().mockResolvedValue(prBatch({}))) {
  getKimiWebApiMock.mockReturnValue({ getGitStatusBatch, getPullRequestBatch });
}

beforeEach(() => {
  getKimiWebApiMock.mockReset();
  setKimiClientDeps({ api: () => getKimiWebApiMock(), t: (key) => key });
  sessionsStore().setSessions([]);
  workspacesStore().workspaces = [];
  for (const id of ['s1', 's2', 's3']) sessionInfoStore().discard(id);
});

afterEach(() => {
  for (const id of ['s1', 's2', 's3']) sessionInfoStore().discard(id);
  resetKimiClientDeps();
});

describe('sessionInfoStore', () => {
  it('resolves folders by session workspaceId instead of the selected workspace', () => {
    sessionsStore().setSessions([{ id: 's1', workspaceId: 'ws1', cwd: '/shared' } as AppSession]);
    workspacesStore().workspaces = [seedWorkspace('ws1', '/shared', ['/one']), seedWorkspace('ws2', '/shared', ['/two'])];
    workspacesStore().selectWorkspace('ws2');

    expect(sessionInfoStore().foldersForSession('s1')).toEqual(folders('/shared', '/one'));
    expect(sessionInfoStore().foldersForSession('missing')).toEqual([]);
  });

  it('resolves a historical session workspace by cwd when workspaceId is missing', () => {
    sessionsStore().setSessions([{ id: 's1', cwd: '/shared' } as AppSession]);
    workspacesStore().workspaces = [seedWorkspace('ws1', '/shared', ['/one'])];

    expect(sessionInfoStore().foldersForSession('s1')).toEqual(folders('/shared', '/one'));
  });

  it('lists the working directory of a worktree session first instead of the project root', () => {
    sessionsStore().setSessions([
      { id: 's1', workspaceId: 'wd_repo', cwd: '/repo-wt' } as AppSession,
      { id: 's2', workspaceId: 'wd_repo', cwd: '/repo' } as AppSession,
    ]);
    workspacesStore().workspaces = [seedWorkspace('wd_repo', '/repo', ['/shared'])];

    expect(sessionInfoStore().foldersForSession('s1')).toEqual(folders('/repo-wt', '/shared'));
    expect(sessionInfoStore().foldersForSession('s2')).toEqual(folders('/repo', '/shared'));
  });

  it('loads independent git state for every folder in two batch requests', async () => {
    const getGitStatusBatch = vi.fn().mockResolvedValue(statusBatch({ '/a': gitStatus('branch-a'), '/b': gitStatus('branch-b') }));
    const getPullRequestBatch = vi.fn().mockResolvedValue(prBatch({ '/a': null, '/b': null }));
    mockBatches(getGitStatusBatch, getPullRequestBatch);

    await sessionInfoStore().observe('s1', folders('/a', '/b'));

    expect(getGitStatusBatch).toHaveBeenCalledExactlyOnceWith('s1', { roots: ['/a', '/b'], includePullRequest: false, includeUntracked: true }, undefined);
    expect(getPullRequestBatch).toHaveBeenCalledExactlyOnceWith('s1', { roots: ['/a', '/b'] }, undefined);
    expect(sessionInfoStore().rows('s1').map(row => [row.path, row.state])).toEqual([
      ['/a', { status: 'ready', value: gitStatus('branch-a') }],
      ['/b', { status: 'ready', value: gitStatus('branch-b') }],
    ]);
  });

  it('flags the status as loading only while the status request is in flight', async () => {
    const status = deferred<GitStatusBatchResult>();
    const pullRequests = deferred<PullRequestBatchResult>();
    const getGitStatusBatch = vi.fn().mockReturnValue(status.promise);
    const getPullRequestBatch = vi.fn().mockReturnValue(pullRequests.promise);
    mockBatches(getGitStatusBatch, getPullRequestBatch);

    const observed = sessionInfoStore().observe('s1', folders('/a'));
    await Promise.resolve();
    expect(sessionInfoStore().rows('s1')[0]?.statusLoading).toBe(true);

    status.resolve(statusBatch({ '/a': gitStatus('branch-a') }));
    await vi.waitFor(() => expect(getPullRequestBatch).toHaveBeenCalledOnce());
    expect(sessionInfoStore().rows('s1')[0]?.statusLoading).toBe(false);
    expect(sessionInfoStore().refreshing('s1')).toBe(true);

    pullRequests.resolve(prBatch({ '/a': null }));
    await observed;
    expect(sessionInfoStore().rows('s1')[0]?.statusLoading).toBe(false);
  });

  it('isolates non-git and failed folders in the batch response', async () => {
    mockBatches(vi.fn().mockResolvedValue(statusBatch(
      { '/c': gitStatus('main') },
      {
        '/a': { code: 40908, msg: 'not a repo' },
        '/b': { code: 50001, msg: 'offline' },
      },
    )));

    await sessionInfoStore().observe('s1', folders('/a', '/b', '/c'));

    expect(sessionInfoStore().rows('s1').map(row => row.state.status)).toEqual(['non-git', 'error', 'ready']);
  });

  it('drops stale batch responses after switching sessions and folder sets', async () => {
    const first = deferred<GitStatusBatchResult>();
    const second = deferred<GitStatusBatchResult>();
    const third = deferred<GitStatusBatchResult>();
    const fourth = deferred<GitStatusBatchResult>();
    mockBatches(vi.fn()
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(second.promise)
      .mockReturnValueOnce(third.promise)
      .mockReturnValueOnce(fourth.promise));

    const oldSession = sessionInfoStore().observe('s1', folders('/old'));
    const newSession = sessionInfoStore().observe('s2', folders('/new'));
    first.resolve(statusBatch({ '/old': gitStatus('old') }));
    await oldSession;
    expect(sessionInfoStore().rows('s1').map(row => [row.path, row.state.status])).toEqual([['/old', 'loading']]);
    second.resolve(statusBatch({ '/new': gitStatus('new') }));
    await newSession;
    expect(sessionInfoStore().rows('s2')[0]?.state).toEqual({ status: 'ready', value: gitStatus('new') });

    const oldFolders = sessionInfoStore().observe('s2', folders('/old-set'));
    const newFolders = sessionInfoStore().observe('s2', folders('/new-set'));
    third.resolve(statusBatch({ '/old-set': gitStatus('old-set') }));
    await oldFolders;
    expect(sessionInfoStore().rows('s2').map(row => [row.path, row.state.status])).toEqual([['/new-set', 'loading']]);
    fourth.resolve(statusBatch({ '/new-set': gitStatus('new-set') }));
    await newFolders;
    expect(sessionInfoStore().rows('s2')[0]?.state).toEqual({ status: 'ready', value: gitStatus('new-set') });
  });

  it('deduplicates identical observes into one batch per data type', async () => {
    const pending = deferred<GitStatusBatchResult>();
    const getGitStatusBatch = vi.fn().mockReturnValue(pending.promise);
    const getPullRequestBatch = vi.fn().mockResolvedValue(prBatch({}));
    mockBatches(getGitStatusBatch, getPullRequestBatch);
    const list = folders('/a', '/b', '/c', '/d');

    const first = sessionInfoStore().observe('s1', list);
    const second = sessionInfoStore().observe('s1', list);
    await Promise.resolve();
    expect(getGitStatusBatch).toHaveBeenCalledTimes(1);

    pending.resolve(statusBatch(Object.fromEntries(list.map(folder => [folder.path, gitStatus('main')]))));
    await Promise.all([first, second]);
    expect(getGitStatusBatch).toHaveBeenCalledTimes(1);
    expect(getPullRequestBatch).toHaveBeenCalledTimes(1);
  });

  it('does not refresh after unobserving', async () => {
    const getGitStatusBatch = vi.fn().mockResolvedValue(statusBatch({ '/a': gitStatus('main') }));
    mockBatches(getGitStatusBatch);
    await sessionInfoStore().observe('s1', folders('/a'));
    getGitStatusBatch.mockClear();

    sessionInfoStore().unobserve('s1');
    await sessionInfoStore().refresh('s1');

    expect(getGitStatusBatch).not.toHaveBeenCalled();
    expect(sessionInfoStore().rows('s1')[0]?.state).toEqual({ status: 'ready', value: gitStatus('main') });
  });

  it('keeps ready data on reobserve while refreshing in the background', async () => {
    const getGitStatusBatch = vi.fn().mockResolvedValue(statusBatch({ '/a': gitStatus('main') }));
    mockBatches(getGitStatusBatch);
    await sessionInfoStore().observe('s1', folders('/a'));
    sessionInfoStore().unobserve('s1');
    const next = deferred<GitStatusBatchResult>();
    getGitStatusBatch.mockReturnValue(next.promise);

    const refreshed = sessionInfoStore().observe('s1', folders('/a'));
    expect(sessionInfoStore().rows('s1')[0]?.state).toEqual({ status: 'ready', value: gitStatus('main') });
    next.resolve(statusBatch({ '/a': gitStatus('feature') }));
    await refreshed;
    expect(sessionInfoStore().rows('s1')[0]?.state).toEqual({ status: 'ready', value: gitStatus('feature') });
  });

  it('publishes branch and diff before the independent PR batch settles', async () => {
    const pr = deferred<PullRequestBatchResult>();
    const getGitStatusBatch = vi.fn().mockResolvedValue(statusBatch({ '/a': gitStatus('main') }));
    const getPullRequestBatch = vi.fn().mockReturnValue(pr.promise);
    mockBatches(getGitStatusBatch, getPullRequestBatch);

    const pending = sessionInfoStore().observe('s1', folders('/a'));
    await vi.waitFor(() => expect(sessionInfoStore().rows('s1')[0]?.state.status).toBe('ready'));
    expect(getGitStatusBatch).toHaveBeenCalledExactlyOnceWith('s1', { roots: ['/a'], includePullRequest: false, includeUntracked: true }, undefined);
    expect(getPullRequestBatch).toHaveBeenCalledExactlyOnceWith('s1', { roots: ['/a'] }, undefined);
    expect(sessionInfoStore().rows('s1')[0]?.state).toEqual({ status: 'ready', value: gitStatus('main') });

    const pullRequest = { number: 7, state: 'open', url: 'https://example.com/pull/7' };
    pr.resolve(prBatch({ '/a': pullRequest }));
    await pending;
    expect(sessionInfoStore().rows('s1')[0]?.state).toEqual({
      status: 'ready',
      value: { ...gitStatus('main'), pullRequest },
    });
  });

  it('keeps the last pull request when a folder fails in a later batch', async () => {
    const pullRequest = { number: 7, state: 'open', url: 'https://example.com/pull/7' };
    const getGitStatusBatch = vi.fn().mockResolvedValue(statusBatch({ '/a': gitStatus('main') }));
    const getPullRequestBatch = vi.fn()
      .mockResolvedValueOnce(prBatch({ '/a': pullRequest }))
      .mockResolvedValueOnce(prBatch({}, { '/a': { code: 50001, msg: 'offline' } }))
      .mockRejectedValueOnce(new Error('offline'));
    mockBatches(getGitStatusBatch, getPullRequestBatch);

    await sessionInfoStore().observe('s1', folders('/a'));
    await sessionInfoStore().refresh('s1');
    expect(sessionInfoStore().rows('s1')[0]?.state).toEqual({
      status: 'ready',
      value: { ...gitStatus('main'), pullRequest, pullRequestStatus: 'failed', pullRequestError: 'offline' },
    });
    await sessionInfoStore().refresh('s1');

    expect(sessionInfoStore().rows('s1')[0]?.state).toEqual({
      status: 'ready',
      value: { ...gitStatus('main'), pullRequest, pullRequestStatus: 'failed', pullRequestError: 'offline' },
    });
  });

  it('keeps ready folder state through transient refresh failures', async () => {
    const getGitStatusBatch = vi.fn()
      .mockResolvedValueOnce(statusBatch({ '/a': gitStatus('main') }))
      .mockResolvedValueOnce(statusBatch({}, { '/a': { code: 50001, msg: 'offline' } }))
      .mockRejectedValueOnce(new Error('offline'))
      .mockResolvedValueOnce(statusBatch({}, { '/a': { code: 40908, msg: 'not a repo' } }));
    const getPullRequestBatch = vi.fn().mockResolvedValue(prBatch({ '/a': null }));
    mockBatches(getGitStatusBatch, getPullRequestBatch);

    await sessionInfoStore().observe('s1', folders('/a'));
    await sessionInfoStore().refresh('s1');
    await sessionInfoStore().refresh('s1');

    expect(sessionInfoStore().rows('s1')[0]?.state).toEqual({ status: 'ready', value: gitStatus('main') });
    await sessionInfoStore().refresh('s1');
    expect(sessionInfoStore().rows('s1')[0]?.state.status).toBe('non-git');
  });

  it('runs a requested refresh after the in-flight load finishes', async () => {
    const firstPr = deferred<PullRequestBatchResult>();
    const getGitStatusBatch = vi.fn()
      .mockResolvedValueOnce(statusBatch({ '/a': gitStatus('main') }))
      .mockResolvedValueOnce(statusBatch({ '/a': gitStatus('feature') }));
    const getPullRequestBatch = vi.fn()
      .mockReturnValueOnce(firstPr.promise)
      .mockResolvedValueOnce(prBatch({ '/a': null }));
    mockBatches(getGitStatusBatch, getPullRequestBatch);

    const initial = sessionInfoStore().observe('s1', folders('/a'));
    await vi.waitFor(() => expect(getPullRequestBatch).toHaveBeenCalledTimes(1));
    const refreshed = sessionInfoStore().refresh('s1');
    firstPr.resolve(prBatch({ '/a': null }));
    await Promise.all([initial, refreshed]);

    expect(getGitStatusBatch).toHaveBeenCalledTimes(2);
    expect(getPullRequestBatch).toHaveBeenCalledTimes(2);
    expect(sessionInfoStore().rows('s1')[0]?.state).toEqual({
      status: 'ready',
      value: gitStatus('feature'),
    });
  });

  it('keeps data and raises the refreshing flag while a refresh runs', async () => {
    const next = deferred<GitStatusBatchResult>();
    const getGitStatusBatch = vi.fn()
      .mockResolvedValueOnce(statusBatch({ '/a': gitStatus('main') }))
      .mockReturnValueOnce(next.promise);
    mockBatches(getGitStatusBatch, vi.fn().mockResolvedValue(prBatch({ '/a': null })));
    await sessionInfoStore().observe('s1', folders('/a'));
    expect(sessionInfoStore().refreshing('s1')).toBe(false);

    const refreshed = sessionInfoStore().refresh('s1');
    expect(sessionInfoStore().refreshing('s1')).toBe(true);
    expect(sessionInfoStore().rows('s1')[0]?.state).toEqual({ status: 'ready', value: gitStatus('main') });
    next.resolve(statusBatch({ '/a': gitStatus('feature') }));
    await refreshed;

    expect(sessionInfoStore().refreshing('s1')).toBe(false);
    expect(sessionInfoStore().rows('s1')[0]?.state).toEqual({ status: 'ready', value: gitStatus('feature') });
  });

  it('reports a failed refresh with its raw output and clears it after a successful retry', async () => {
    const getGitStatusBatch = vi.fn()
      .mockResolvedValueOnce(statusBatch({ '/a': gitStatus('main') }))
      .mockRejectedValueOnce(new Error('request timed out'))
      .mockResolvedValueOnce(statusBatch({ '/a': gitStatus('main') }));
    mockBatches(getGitStatusBatch, vi.fn().mockResolvedValue(prBatch({ '/a': null })));
    await sessionInfoStore().observe('s1', folders('/a'));
    expect(sessionInfoStore().refreshError('s1')).toBeNull();

    await sessionInfoStore().refresh('s1');
    expect(sessionInfoStore().refreshError('s1')).toEqual({ output: 'request timed out' });
    expect(sessionInfoStore().rows('s1')[0]?.state).toEqual({ status: 'ready', value: gitStatus('main') });

    await sessionInfoStore().refresh('s1');
    expect(sessionInfoStore().refreshError('s1')).toBeNull();
  });

  it('shows a load failure with its output when there is no earlier data', async () => {
    mockBatches(vi.fn().mockRejectedValue(new Error('offline')));
    await sessionInfoStore().observe('s1', folders('/a'));

    expect(sessionInfoStore().rows('s1')[0]?.state).toEqual({ status: 'error', output: 'offline' });
    expect(sessionInfoStore().refreshError('s1')).toBeNull();
  });

  it('marks a missing directory apart from a non-git one and flags the worktree session invalid', async () => {
    sessionsStore().setSessions([{ id: 's1', workspaceId: 'ws1', cwd: '/wt/a', worktree: readyWorktree() } as AppSession]);
    workspacesStore().workspaces = [seedWorkspace('ws1', '/repo', ['/plain'])];
    const getGitStatusBatch = vi.fn()
      .mockResolvedValueOnce(statusBatch({}, {
        '/wt/a': { code: 40422, msg: 'directory not found' },
        '/plain': { code: 40908, msg: 'not a repo' },
      }))
      .mockResolvedValueOnce(statusBatch({ '/wt/a': gitStatus('kimi/a') }, { '/plain': { code: 40908, msg: 'not a repo' } }));
    mockBatches(getGitStatusBatch, vi.fn().mockResolvedValue(prBatch({ '/wt/a': null })));

    await sessionInfoStore().observe('s1', sessionInfoStore().foldersForSession('s1'));
    expect(sessionInfoStore().rows('s1').map(row => [row.path, row.state.status])).toEqual([
      ['/wt/a', 'missing'],
      ['/plain', 'non-git'],
    ]);
    expect(sessionsStore().sessions[0]?.worktree?.missing).toBe(true);

    await sessionInfoStore().refresh('s1');
    expect(sessionInfoStore().rows('s1')[0]?.state.status).toBe('ready');
    expect(sessionsStore().sessions[0]?.worktree?.missing).toBe(false);
  });

  it('tracks the pull request as loading until its batch settles, then keeps its status', async () => {
    const pr = deferred<PullRequestBatchResult>();
    mockBatches(
      vi.fn().mockResolvedValue(statusBatch({ '/a': gitStatus('main'), '/b': gitStatus('main') })),
      vi.fn().mockReturnValue(pr.promise),
    );
    const pending = sessionInfoStore().observe('s1', folders('/a', '/b'));
    await vi.waitFor(() => expect(sessionInfoStore().rows('s1')[0]?.state.status).toBe('ready'));
    expect(sessionInfoStore().rows('s1').map(row => row.pullRequestLoading)).toEqual([true, true]);

    pr.resolve(prBatch(
      { '/a': null, '/b': null },
      {},
      { '/a': { status: 'unavailable' }, '/b': { status: 'failed', error: 'gh: timeout' } },
    ));
    await pending;

    expect(sessionInfoStore().rows('s1').map(row => row.pullRequestLoading)).toEqual([false, false]);
    expect(sessionInfoStore().rows('s1').map(row => row.state)).toEqual([
      { status: 'ready', value: { ...gitStatus('main'), pullRequestStatus: 'unavailable' } },
      { status: 'ready', value: { ...gitStatus('main'), pullRequestStatus: 'failed', pullRequestError: 'gh: timeout' } },
    ]);
  });

  it('observes, refreshes in background, and preserves ready context summary across reobserves', async () => {
    const summary1 = {
      session_id: 's1',
      agent_id: 'main',
      captured_at: 1,
      tokens: { used: 1200, max: 10000 },
      groups: [{ role: 'user', count: 1, tokens: 1200 }],
    };
    const summary2 = { ...summary1, tokens: { used: 2400, max: 10000 } };
    const nextSummary = deferred<typeof summary1>();
    const getSessionContextSummary = vi.fn()
      .mockResolvedValueOnce(summary1)
      .mockReturnValueOnce(nextSummary.promise);
    getKimiWebApiMock.mockReturnValue({ getSessionContextSummary });

    await sessionInfoStore().observeContext('s1');
    expect(getSessionContextSummary).toHaveBeenCalledExactlyOnceWith('s1', undefined, { background: true });
    expect(sessionInfoStore().contextState('s1')).toEqual({ status: 'ready', value: summary1 });

    const refreshing = sessionInfoStore().refresh('s1');
    expect(sessionInfoStore().contextState('s1')).toEqual({ status: 'loading', value: summary1 });
    nextSummary.resolve(summary2);
    await refreshing;
    expect(sessionInfoStore().contextState('s1')).toEqual({ status: 'ready', value: summary2 });

    sessionInfoStore().unobserveContext('s1');
    await sessionInfoStore().refresh('s1');
    expect(getSessionContextSummary).toHaveBeenCalledTimes(2);
  });

  it('keeps the last summary but reports the error when a context refresh fails', async () => {
    const summary = {
      session_id: 's1',
      agent_id: 'main',
      captured_at: 1,
      tokens: { used: 1200, max: 10000 },
      groups: [{ role: 'user', count: 1, tokens: 1200 }],
    };
    const getSessionContextSummary = vi.fn()
      .mockResolvedValueOnce(summary)
      .mockRejectedValueOnce(new Error('offline'))
      .mockResolvedValueOnce(summary);
    getKimiWebApiMock.mockReturnValue({ getSessionContextSummary });

    await sessionInfoStore().observeContext('s1');
    await sessionInfoStore().refreshContext('s1');
    expect(sessionInfoStore().contextState('s1')).toEqual({ status: 'error', message: 'offline', value: summary });

    await sessionInfoStore().refreshContext('s1');
    expect(sessionInfoStore().contextState('s1')).toEqual({ status: 'ready', value: summary });
  });
});

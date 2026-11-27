import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { DaemonKimiWebApi } from '../src/api/daemon/client';
import {
  toAppSession,
  toDeleteSessionResult,
  toGitStatusBatchResult,
  toGitStatusEntry,
  toPullRequestBatchResult,
  toPullRequestResult,
  toWorkspaceGitBranches,
  toWorktreeInspection,
  toWorktreeList,
  toWorktreeLookup,
} from '../src/api/daemon/mappers';
import {
  DaemonApiError,
  WORKTREE_REMOVE_FAILED_CODE,
  worktreeRemoveFailure,
} from '../src/api/errors';
import type { WireSession } from '../src/api/daemon/wire';

function envelope(data: unknown, details?: unknown): Response {
  return new Response(JSON.stringify({ code: 0, msg: '', data, details }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

beforeEach(() => {
  vi.stubGlobal('fetch', vi.fn());
});

afterEach(() => {
  vi.unstubAllGlobals();
});

function createApi(): DaemonKimiWebApi {
  return new DaemonKimiWebApi({
    origin: 'http://daemon.test',
    identity: { clientId: 'web_test', clientName: 'test', clientVersion: '0.0.0', clientUiMode: 'test' },
  });
}

const WIRE_SESSION: WireSession = {
  id: 'sess-1',
  cwd: '/repo',
  title: 'Task',
  created_at: '2026-11-18T00:00:00.000Z',
  updated_at: '2026-11-18T00:00:00.000Z',
  activity: 'idle',
  archived: false,
  worktree: {
    branch: 'kimi/1118-a3f2',
    included_local_changes: true,
    setup: {
      status: 'failed',
      purpose: 'create',
      request: { source_branch: 'main' },
      steps: [{ kind: 'fetch', state: 'failed', timed_out: true }],
      commands_ran: 1,
      failure: { kind: 'conflict', conflict_files: ['a.ts'] },
    },
  },
};

const ROUTES: Array<{
  name: string;
  call: (api: DaemonKimiWebApi) => Promise<unknown>;
  data: unknown;
  path: string;
  body: unknown;
  result?: unknown;
}> = [
  {
    name: 'create with a worktree',
    call: (api) => api.createSession({ cwd: '/repo', workspaceId: 'ws-1', worktree: { sourceBranch: 'main', includeLocalChanges: true, useRemote: false } }),
    data: WIRE_SESSION,
    path: '/sessions',
    body: { metadata: { cwd: '/repo' }, workspace_id: 'ws-1', worktree: { source_branch: 'main', include_local_changes: true, use_remote: false } },
  },
  { name: 'retry', call: (api) => api.sessionWorktreeAction('sess/1', 'retry'), data: WIRE_SESSION, path: '/sessions/sess%2F1/worktree:retry', body: {} },
  { name: 'cancel', call: (api) => api.sessionWorktreeAction('sess/1', 'cancel'), data: WIRE_SESSION, path: '/sessions/sess%2F1/worktree:cancel', body: {} },
  { name: 'useLocal', call: (api) => api.sessionWorktreeAction('sess/1', 'useLocal'), data: WIRE_SESSION, path: '/sessions/sess%2F1/worktree:use_local', body: {} },
  { name: 'recreate without retry overrides', call: (api) => api.sessionWorktreeAction('sess/1', 'recreate', { useRemote: true }), data: WIRE_SESSION, path: '/sessions/sess%2F1/worktree:recreate', body: {} },
  {
    name: 'retry overrides',
    call: (api) => api.sessionWorktreeAction('sess/1', 'retry', { includeLocalChanges: false, useRemote: false }),
    data: WIRE_SESSION,
    path: '/sessions/sess%2F1/worktree:retry',
    body: { include_local_changes: false, use_remote: false },
  },
  { name: 'delete', call: (api) => api.deleteSession('sess/1'), data: { deleted: true }, path: '/sessions/sess%2F1:delete', body: {} },
  {
    name: 'delete with worktree options',
    call: (api) => api.deleteSession('sess/1', { removeWorktree: true, deleteBranch: true }),
    data: { deleted: true },
    path: '/sessions/sess%2F1:delete',
    body: { remove_worktree: true, delete_branch: true },
  },
  { name: 'inspect', call: (api) => api.inspectWorktrees(['/wt/a']), data: { items: [], errors: {} }, path: '/worktrees:inspect', body: { paths: ['/wt/a'] } },
  {
    name: 'remove',
    call: (api) => api.removeWorktree({ path: '/wt/a', deleteBranch: true }),
    data: { removed: true, branch_deleted: true },
    path: '/worktrees:remove',
    body: { path: '/wt/a', delete_branch: true },
    result: { removed: true, branchDeleted: true },
  },
  { name: 'lookup', call: (api) => api.lookupWorktree('/wt/a'), data: { worktree: null, enclosing_repo_root: null }, path: '/worktrees:lookup', body: { path: '/wt/a' }, result: null },
  {
    name: 'enclosing repo root',
    call: (api) => api.enclosingRepoRoot('/repo/app'),
    data: { worktree: null, enclosing_repo_root: '/repo' },
    path: '/worktrees:lookup',
    body: { path: '/repo/app' },
    result: '/repo',
  },
];

describe('worktree routes', () => {
  it.each(ROUTES)('posts $name', async ({ call, data, path, body, result = expect.anything() }) => {
    vi.mocked(fetch).mockResolvedValueOnce(envelope(data));
    expect(await call(createApi())).toEqual(result);
    expect(vi.mocked(fetch).mock.calls[0]?.[0]).toBe(`http://daemon.test/api/v1${path}`);
    expect(vi.mocked(fetch).mock.calls[0]?.[1]).toMatchObject({ method: 'POST', body: JSON.stringify(body) });
  });

  it('reads the pull request status from the envelope details', async () => {
    vi.mocked(fetch).mockResolvedValueOnce(envelope({ number: 7, state: 'open', url: 'https://example.test/7' }, { pull_request_status: 'found' }));
    expect(await createApi().getPullRequest('sess-1')).toEqual({
      pullRequest: { number: 7, state: 'open', url: 'https://example.test/7' },
      status: 'found',
    });
  });
});

describe('worktree mappers', () => {
  it('maps the session worktree setup', () => {
    expect(toAppSession(WIRE_SESSION).worktree).toMatchObject({
      includedLocalChanges: true,
      setup: { request: { sourceBranch: 'main' }, steps: [{ timedOut: true }], failure: { conflictFiles: ['a.ts'] } },
    });
  });

  it('maps branches, worktree lists and lookups', () => {
    const branches = toWorkspaceGitBranches({
      is_repo: true,
      dirty: false,
      remotes: ['fork'],
      branches: [{ name: 'feat', committed_at: '2026-11-17T00:00:00.000Z', remote_ref: 'fork/feat', remote: 'fork', remote_source: 'same_name' }],
    });
    expect(branches.branches[0]?.remoteRef).toBe('fork/feat');
    const list = toWorktreeList({ items: [{ path: '/wt/a', name: 'a', repo_root: '/repo', origin: 'product', sessions: [] }], total_size_bytes: 42 });
    expect(list.items[0]?.repoRoot).toBe('/repo');
    const lookup = toWorktreeLookup({
      worktree: { repo_root: '/repo', workspace: { id: 'ws-1', root: '/repo', name: 'repo', kind: 'managed', additional_dirs: [], session_count: 2 }, session_count: 2 },
      enclosing_repo_root: null,
    });
    expect(lookup).toMatchObject({ repoRoot: '/repo', sessionCount: 2, workspace: { id: 'ws-1', root: '/repo' } });
  });

  it('passes inspection errors through', () => {
    const errors = { '/wt/b': { code: 40423, msg: 'gone' } };
    expect(toWorktreeInspection({ items: [], errors }).errors).toEqual(errors);
  });

  it('maps the worktree outcome of a session delete', () => {
    expect(toDeleteSessionResult({ deleted: true })).toEqual({ deleted: true });
    expect(toDeleteSessionResult({ deleted: true, worktree: { outcome: 'kept_in_use', branch_deleted: false, other_sessions: 2, output: 'busy' } })).toEqual({
      deleted: true,
      worktree: { outcome: 'kept_in_use', branchDeleted: false, otherSessions: 2, output: 'busy' },
    });
  });
});

describe('git status mapping', () => {
  const base = { branch: 'main', ahead: 0, behind: 0, entries: {}, additions: 0, deletions: 0, pullRequest: null, detached: false };

  it('maps the single-status error fields', () => {
    expect(toGitStatusEntry({ ...base, stats_error: 'fatal: bad object', pull_request_status: 'failed', pull_request_error: 'gh: timeout' })).toMatchObject({
      statsError: 'fatal: bad object',
      pullRequestStatus: 'failed',
      pullRequestError: 'gh: timeout',
    });
  });

  it('leaves the pull request fields out of a status read without them', () => {
    const status = toGitStatusEntry(base);
    expect(status).toEqual(base);
    expect(Object.hasOwn(status, 'pullRequestStatus')).toBe(false);
    expect(Object.hasOwn(status, 'head')).toBe(false);
  });

  it('passes batch errors through', () => {
    const errors = { '/gone': { code: 40422, msg: 'missing' } };
    expect(toGitStatusBatchResult({ results: {}, errors }).errors).toEqual(errors);
  });

  it('reads pull request statuses from the details or the sibling map', () => {
    expect(toPullRequestResult(null, { pull_request_status: 'none' })).toEqual({ pullRequest: null, status: 'none' });
    expect(toPullRequestResult(null, { pull_request_status: 'failed', pull_request_error: 'gh: timeout' })).toEqual({ pullRequest: null, status: 'failed', error: 'gh: timeout' });
    expect(toPullRequestBatchResult({
      results: { '/a': { number: 7, state: 'open', url: 'https://example.test/7' }, '/b': null },
      errors: { '/d': { code: 40422, msg: 'missing' } },
      statuses: { '/a': { pull_request_status: 'found' }, '/b': { pull_request_status: 'failed', pull_request_error: 'gh: timeout' } },
    })).toEqual({
      results: { '/a': { number: 7, state: 'open', url: 'https://example.test/7' }, '/b': null },
      statuses: { '/a': { status: 'found' }, '/b': { status: 'failed', error: 'gh: timeout' } },
      errors: { '/d': { code: 40422, msg: 'missing' } },
    });
  });
});

describe('worktreeRemoveFailure', () => {
  it('falls back to an unknown reason and the message', () => {
    const error = new DaemonApiError({ code: WORKTREE_REMOVE_FAILED_CODE, msg: 'remove failed', requestId: 'r1' });
    expect(worktreeRemoveFailure(error)).toEqual({ reason: 'unknown', output: 'remove failed' });
  });

  it('ignores other errors', () => {
    expect(worktreeRemoveFailure(new DaemonApiError({ code: 40901, msg: 'busy', requestId: 'r1' }))).toBeNull();
    expect(worktreeRemoveFailure(new Error('nope'))).toBeNull();
  });
});

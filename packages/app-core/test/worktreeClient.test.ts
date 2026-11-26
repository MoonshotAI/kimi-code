import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { DaemonKimiWebApi } from '../src/api/daemon/client';
import { toAppSession } from '../src/api/daemon/mappers';
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

function respond(data: unknown, details?: unknown): void {
  vi.mocked(fetch).mockResolvedValueOnce(envelope(data, details));
}

beforeEach(() => {
  vi.stubGlobal('fetch', vi.fn());
});

afterEach(() => {
  vi.unstubAllGlobals();
});

const API = 'http://daemon.test/api/v1';

function createApi(): DaemonKimiWebApi {
  return new DaemonKimiWebApi({
    origin: 'http://daemon.test',
    identity: { clientId: 'web_test', clientName: 'test', clientVersion: '0.0.0', clientUiMode: 'test' },
  });
}

function lastRequest(): { url: string; method: string; body: unknown } {
  const [input, init] = vi.mocked(fetch).mock.calls.at(-1)!;
  const raw = (init as RequestInit | undefined)?.body;
  return {
    url: typeof input === 'string' ? input : input instanceof URL ? input.href : input.url,
    method: (init as RequestInit | undefined)?.method ?? 'GET',
    body: typeof raw === 'string' ? JSON.parse(raw) : undefined,
  };
}

const WIRE_SESSION: WireSession = {
  id: 'sess-1',
  cwd: '/repo',
  title: 'Task',
  created_at: '2026-11-18T00:00:00.000Z',
  updated_at: '2026-11-18T00:00:00.000Z',
  activity: 'idle',
  archived: false,
  workspace_id: 'ws-1',
  worktree: {
    path: '/home/.kimi-code/worktrees/repo/1118-a3f2',
    branch: 'kimi/1118-a3f2',
    base: { ref: 'origin/main', remote: true, commit: 'abc1234' },
    included_local_changes: true,
    missing: false,
    branch_missing: false,
    setup: {
      status: 'failed',
      purpose: 'create',
      request: { source_branch: 'main', include_local_changes: true, use_remote: true },
      steps: [
        { kind: 'fetch', state: 'failed', ref: 'origin/main', command: 'git fetch origin main', output: 'boom', timed_out: true },
        { kind: 'prune', state: 'done' },
        { kind: 'create', state: 'pending' },
      ],
      commands_ran: 1,
      started_at: '2026-11-18T00:00:01.000Z',
      ended_at: '2026-11-18T00:00:31.000Z',
      stopped_step: 'fetch',
      failure: {
        kind: 'conflict',
        remote_ref: 'origin/main',
        conflict_files: ['a.ts'],
        timeout_seconds: 30,
      },
    },
  },
};

describe('session worktree mapping', () => {
  it('maps every worktree field onto the app session', () => {
    expect(toAppSession(WIRE_SESSION).worktree).toEqual({
      path: '/home/.kimi-code/worktrees/repo/1118-a3f2',
      branch: 'kimi/1118-a3f2',
      base: { ref: 'origin/main', remote: true, commit: 'abc1234' },
      includedLocalChanges: true,
      missing: false,
      branchMissing: false,
      setup: {
        status: 'failed',
        purpose: 'create',
        request: { sourceBranch: 'main', includeLocalChanges: true, useRemote: true },
        steps: [
          { kind: 'fetch', state: 'failed', ref: 'origin/main', command: 'git fetch origin main', output: 'boom', timedOut: true },
          { kind: 'prune', state: 'done' },
          { kind: 'create', state: 'pending' },
        ],
        commandsRan: 1,
        startedAt: '2026-11-18T00:00:01.000Z',
        endedAt: '2026-11-18T00:00:31.000Z',
        stoppedStep: 'fetch',
        failure: {
          kind: 'conflict',
          remoteRef: 'origin/main',
          conflictFiles: ['a.ts'],
          timeoutSeconds: 30,
        },
      },
    });
  });
});

describe('worktree routes', () => {
  it('creates a session with the worktree request', async () => {
    respond(WIRE_SESSION);
    await createApi().createSession({
      cwd: '/repo',
      workspaceId: 'ws-1',
      worktree: { sourceBranch: 'main', includeLocalChanges: true, useRemote: false },
    });
    expect(lastRequest().body).toEqual({
      metadata: { cwd: '/repo' },
      workspace_id: 'ws-1',
      worktree: { source_branch: 'main', include_local_changes: true, use_remote: false },
    });
  });

  it.each([
    ['retry', 'retry'],
    ['cancel', 'cancel'],
    ['useLocal', 'use_local'],
    ['recreate', 'recreate'],
  ] as const)('posts the %s action to worktree:%s', async (action, segment) => {
    respond(WIRE_SESSION);
    const session = await createApi().sessionWorktreeAction('sess/1', action);
    const request = lastRequest();
    expect(request.url).toBe(`${API}/sessions/sess%2F1/worktree:${segment}`);
    expect(request.method).toBe('POST');
    expect(request.body).toEqual({});
    expect(session.worktree?.branch).toBe('kimi/1118-a3f2');
  });

  it('sends retry overrides only for retry', async () => {
    vi.mocked(fetch).mockImplementation(async () => envelope(WIRE_SESSION));
    const api = createApi();
    await api.sessionWorktreeAction('sess-1', 'retry', { includeLocalChanges: false, useRemote: false });
    expect(lastRequest().body).toEqual({ include_local_changes: false, use_remote: false });
    await api.sessionWorktreeAction('sess-1', 'recreate', { useRemote: true });
    expect(lastRequest().body).toEqual({});
  });

  it('deletes a session with an empty body by default, or with worktree options and their outcome', async () => {
    const api = createApi();
    respond({ deleted: true });
    expect(await api.deleteSession('sess-1')).toEqual({ deleted: true });
    expect(lastRequest().body).toEqual({});

    respond({ deleted: true, worktree: { outcome: 'kept_in_use', branch_deleted: false, other_sessions: 2, output: 'busy' } });
    const result = await api.deleteSession('sess-1', { removeWorktree: true, deleteBranch: true });
    expect(lastRequest().body).toEqual({ remove_worktree: true, delete_branch: true });
    expect(result).toEqual({
      deleted: true,
      worktree: { outcome: 'kept_in_use', branchDeleted: false, otherSessions: 2, output: 'busy' },
    });
  });

  it('lists branches for a workspace', async () => {
    respond({
      is_repo: true,
      head_branch: 'main',
      dirty: true,
      remotes: ['fork', 'origin'],
      branches: [
        {
          name: 'main',
          committed_at: '2026-11-18T00:00:00.000Z',
          remote_ref: 'origin/main',
          remote: 'origin',
          remote_source: 'upstream',
        },
        {
          name: 'feat',
          committed_at: '2026-11-17T12:00:00.000Z',
          remote_ref: 'fork/feat',
          remote: 'fork',
          remote_source: 'same_name',
        },
        { name: 'topic', committed_at: '2026-11-17T00:00:00.000Z' },
      ],
    });
    const result = await createApi().getWorkspaceGitBranches('ws/1');
    expect(lastRequest().url).toBe(`${API}/workspaces/ws%2F1/git/branches`);
    expect(result).toEqual({
      isRepo: true,
      headBranch: 'main',
      dirty: true,
      remotes: ['fork', 'origin'],
      branches: [
        {
          name: 'main',
          committedAt: '2026-11-18T00:00:00.000Z',
          remoteRef: 'origin/main',
          remote: 'origin',
          remoteSource: 'upstream',
        },
        {
          name: 'feat',
          committedAt: '2026-11-17T12:00:00.000Z',
          remoteRef: 'fork/feat',
          remote: 'fork',
          remoteSource: 'same_name',
        },
        { name: 'topic', committedAt: '2026-11-17T00:00:00.000Z' },
      ],
    });
  });

  it('lists worktrees and asks for fresh sizes only on demand', async () => {
    const wire = {
      items: [
        {
          path: '/wt/a',
          name: 'a',
          repo_root: '/repo',
          workspace_id: 'ws-1',
          workspace_name: 'repo',
          branch: 'kimi/a',
          origin: 'product',
          size_bytes: 42,
          sessions: [{ id: 's1', title: 'One', archived: false, busy: true }],
        },
      ],
      total_size_bytes: 42,
    };
    vi.mocked(fetch).mockImplementation(async () => envelope(wire));
    const api = createApi();
    const list = await api.listWorktrees();
    expect(lastRequest().url).toBe(`${API}/worktrees`);
    expect(list).toEqual({
      items: [
        {
          path: '/wt/a',
          name: 'a',
          repoRoot: '/repo',
          workspaceId: 'ws-1',
          workspaceName: 'repo',
          branch: 'kimi/a',
          origin: 'product',
          sizeBytes: 42,
          sessions: [{ id: 's1', title: 'One', archived: false, busy: true }],
        },
      ],
      totalSizeBytes: 42,
    });
    await api.listWorktrees({ refreshSizes: true });
    expect(lastRequest().url).toBe(`${API}/worktrees?refresh=sizes`);
  });

  it('inspects, removes and looks up worktrees', async () => {
    const api = createApi();
    respond({
      items: [{ path: '/wt/a', branch: 'kimi/a', uncommitted_files: 3, unpushed_commits: 1, sessions: [] }],
      errors: { '/wt/b': { code: 40423, msg: 'gone' } },
    });
    expect(await api.inspectWorktrees(['/wt/a', '/wt/b'])).toEqual({
      items: [{ path: '/wt/a', branch: 'kimi/a', uncommittedFiles: 3, unpushedCommits: 1, sessions: [] }],
      errors: { '/wt/b': { code: 40423, msg: 'gone' } },
    });
    expect(lastRequest()).toMatchObject({ url: `${API}/worktrees:inspect`, body: { paths: ['/wt/a', '/wt/b'] } });

    respond({ removed: true, branch_deleted: true });
    expect(await api.removeWorktree({ path: '/wt/a', deleteBranch: true })).toEqual({ removed: true, branchDeleted: true });
    expect(lastRequest()).toMatchObject({ url: `${API}/worktrees:remove`, body: { path: '/wt/a', delete_branch: true } });

    respond({
      worktree: {
        repo_root: '/repo',
        branch: 'kimi/a',
        workspace: { id: 'ws-1', root: '/repo', name: 'repo', kind: 'managed', additional_dirs: [], session_count: 2 },
        session_count: 2,
      },
    });
    const found = await api.lookupWorktree('/wt/a');
    expect(found).toMatchObject({ repoRoot: '/repo', branch: 'kimi/a', sessionCount: 2, workspace: { id: 'ws-1', root: '/repo' } });
    expect(lastRequest()).toMatchObject({ url: `${API}/worktrees:lookup`, body: { path: '/wt/a' } });

    respond({ worktree: null, enclosing_repo_root: null });
    expect(await api.lookupWorktree('/elsewhere')).toBeNull();

    respond({ worktree: null, enclosing_repo_root: '/repo' });
    expect(await api.enclosingRepoRoot('/repo/app')).toBe('/repo');
    expect(lastRequest()).toMatchObject({ url: `${API}/worktrees:lookup`, body: { path: '/repo/app' } });
  });
});

describe('git status mapping', () => {
  const wireStatus = {
    branch: 'main',
    ahead: 1,
    behind: 2,
    entries: { 'a.ts': 'modified' },
    additions: 3,
    deletions: 4,
    pullRequest: null,
    upstream: 'origin/main',
    head: 'abc1234',
    detached: false,
    stats_error: 'fatal: bad object',
    pull_request_status: 'failed',
    pull_request_error: 'gh: timeout',
  };

  const appStatus = {
    branch: 'main',
    ahead: 1,
    behind: 2,
    entries: { 'a.ts': 'modified' },
    additions: 3,
    deletions: 4,
    pullRequest: null,
    upstream: 'origin/main',
    head: 'abc1234',
    detached: false,
    statsError: 'fatal: bad object',
    pullRequestStatus: 'failed',
    pullRequestError: 'gh: timeout',
  };

  it('maps the new single-status fields', async () => {
    respond(wireStatus);
    expect(await createApi().getGitStatus('sess-1')).toEqual(appStatus);
  });

  it('maps every batch entry', async () => {
    respond({ results: { '/repo': wireStatus }, errors: { '/gone': { code: 40422, msg: 'missing' } } });
    expect(await createApi().getGitStatusBatch('sess-1', { roots: ['/repo', '/gone'] })).toEqual({
      results: { '/repo': appStatus },
      errors: { '/gone': { code: 40422, msg: 'missing' } },
    });
  });

  it('reads the pull request from the data and its status from the envelope details', async () => {
    const api = createApi();
    respond(null, { pull_request_status: 'none' });
    expect(await api.getPullRequest('sess-1')).toEqual({ pullRequest: null, status: 'none' });

    respond({ number: 7, state: 'open', url: 'https://example.test/7' }, { pull_request_status: 'found' });
    expect(await api.getPullRequest('sess-1')).toEqual({
      pullRequest: { number: 7, state: 'open', url: 'https://example.test/7' },
      status: 'found',
    });

    respond(null, { pull_request_status: 'failed', pull_request_error: 'gh: timeout' });
    expect(await api.getPullRequest('sess-1')).toEqual({ pullRequest: null, status: 'failed', error: 'gh: timeout' });
  });

  it('reads batch statuses from the sibling map and leaves failed roots without one', async () => {
    respond({
      results: { '/a': { number: 7, state: 'open', url: 'https://example.test/7' }, '/b': null, '/c': null },
      errors: { '/d': { code: 40422, msg: 'missing' } },
      statuses: {
        '/a': { pull_request_status: 'found' },
        '/b': { pull_request_status: 'unavailable' },
        '/c': { pull_request_status: 'failed', pull_request_error: 'gh: timeout' },
      },
    });
    expect(await createApi().getPullRequestBatch('sess-1', { roots: ['/a', '/b', '/c', '/d'] })).toEqual({
      results: { '/a': { number: 7, state: 'open', url: 'https://example.test/7' }, '/b': null, '/c': null },
      statuses: {
        '/a': { status: 'found' },
        '/b': { status: 'unavailable' },
        '/c': { status: 'failed', error: 'gh: timeout' },
      },
      errors: { '/d': { code: 40422, msg: 'missing' } },
    });
  });

  it('leaves the pull request fields out of a status read without them', async () => {
    respond({ branch: 'main', ahead: 0, behind: 0, entries: {}, additions: 0, deletions: 0, pullRequest: null, detached: false });
    const status = await createApi().getGitStatus('sess-1');
    expect(status).toEqual({ branch: 'main', ahead: 0, behind: 0, entries: {}, additions: 0, deletions: 0, pullRequest: null, detached: false });
    expect(Object.hasOwn(status, 'pullRequestStatus')).toBe(false);
    expect(Object.hasOwn(status, 'head')).toBe(false);
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

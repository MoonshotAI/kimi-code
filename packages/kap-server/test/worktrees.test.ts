import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  IAgentEnvironmentBindingService,
  IAgentEnvironmentService,
  IAgentLifecycleService,
  IAgentLoopService,
  IWorkspaceTrust,
  MAIN_AGENT_ID,
  getLiveSessionById,
  patchSessionMetadata,
} from '@moonshot-ai/agent-core-v2';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { WebSocket, type RawData } from 'ws';

import { ErrorCode } from '../src/protocol/error-codes';
import type { Session } from '../src/protocol/session';
import { repointSession } from '../src/services/worktrees/sessionRepoint';
import { SessionWorktreeService } from '../src/services/worktrees/sessionWorktreeService';
import { storedSessionWorktree } from '../src/services/worktrees/sessionWorktreeState';
import { type RunningServer, startServer } from '../src/start';
import { authHeaders, bearerToken } from './helpers/auth';
import { TEST_HOST_IDENTITY } from './helpers/hostIdentity';

interface Envelope<T> {
  code: number;
  msg: string;
  data: T;
  request_id: string;
  details?: unknown;
}

type SessionWire = Session;

interface SessionEvent {
  type: 'session';
  change: string;
  session: SessionWire;
}

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] }).toString().trimEnd();
}

describe('server-v2 session worktrees', () => {
  let server: RunningServer;
  let home: string;
  let scratch: string;
  let base: string;
  const sockets: WebSocket[] = [];

  async function boot(): Promise<void> {
    server = await startServer({
      hostIdentity: TEST_HOST_IDENTITY,
      host: '127.0.0.1',
      port: 0,
      homeDir: home,
      logLevel: 'silent',
    });
    base = `http://127.0.0.1:${server.port}`;
  }

  beforeAll(async () => {
    home = await realpath(await mkdtemp(join(tmpdir(), 'kimi-server-v2-worktrees-home-')));
    scratch = await realpath(await mkdtemp(join(tmpdir(), 'kimi-server-v2-worktrees-')));
    await writeFile(
      join(home, 'config.toml'),
      [
        'default_model = "stub"',
        '',
        '[providers.stub]',
        'type = "openai"',
        'base_url = "http://127.0.0.1:9999"',
        'api_key = "stub"',
        '',
        '[models.stub]',
        'provider = "stub"',
        'model = "stub"',
        'max_context_size = 1000',
        '',
      ].join('\n'),
      'utf-8',
    );
    await boot();
  });

  afterEach(() => {
    for (const socket of sockets.splice(0)) socket.close();
  });

  afterAll(async () => {
    await server.close();
    await rm(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    await rm(scratch, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  });

  async function post<T>(path: string, body?: unknown): Promise<Envelope<T>> {
    const res = await fetch(`${base}/api/v1${path}`, {
      method: 'POST',
      headers: authHeaders(server, { 'content-type': 'application/json' }),
      body: JSON.stringify(body ?? {}),
    } as never);
    return (await res.json()) as Envelope<T>;
  }

  async function get<T>(path: string): Promise<Envelope<T>> {
    const res = await fetch(`${base}/api/v1${path}`, { headers: authHeaders(server) } as never);
    return (await res.json()) as Envelope<T>;
  }

  async function createRepo(name: string): Promise<string> {
    const root = join(scratch, name);
    await mkdir(root, { recursive: true });
    git(root, 'init', '-q', '-b', 'main');
    git(root, 'config', 'user.email', 'dev@example.com');
    git(root, 'config', 'user.name', 'Dev');
    await writeFile(join(root, 'README.md'), 'hello\n');
    await writeFile(join(root, 'notes.txt'), 'one\ntwo\nthree\n');
    git(root, 'add', '.');
    git(root, 'commit', '-q', '-m', 'init');
    return root;
  }

  async function addRemote(root: string): Promise<string> {
    const bare = `${root}-remote.git`;
    git(scratch, 'init', '-q', '--bare', '-b', 'main', bare);
    git(root, 'remote', 'add', 'origin', bare);
    git(root, 'push', '-q', '-u', 'origin', 'main');
    return bare;
  }

  async function commitOnRemote(bare: string, file: string, content: string): Promise<string> {
    const clone = `${bare}-clone-${Math.random().toString(16).slice(2)}`;
    git(scratch, 'clone', '-q', bare, clone);
    git(clone, 'config', 'user.email', 'dev@example.com');
    git(clone, 'config', 'user.name', 'Dev');
    await writeFile(join(clone, file), content);
    git(clone, 'add', '.');
    git(clone, 'commit', '-q', '-m', `remote ${file}`);
    git(clone, 'push', '-q', 'origin', 'main');
    return git(clone, 'rev-parse', 'HEAD');
  }

  async function createWorkspace(root: string): Promise<string> {
    const workspace = await post<{ id: string }>('/workspaces', { root });
    expect(workspace.code).toBe(0);
    return workspace.data.id;
  }

  async function createWorktreeSession(
    workspaceId: string,
    worktree: Record<string, unknown>,
  ): Promise<SessionWire> {
    const created = await post<SessionWire>('/sessions', { workspace_id: workspaceId, worktree });
    expect(created.code).toBe(0);
    return created.data;
  }

  async function settled(id: string): Promise<SessionWire> {
    for (let attempt = 0; attempt < 400; attempt++) {
      const session = await get<SessionWire>(`/sessions/${id}`);
      if (session.data.worktree?.setup.status !== 'running') return session.data;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    throw new Error(`worktree setup of ${id} is still running`);
  }

  async function untilStep(id: string, kind: string, state: string): Promise<void> {
    for (let attempt = 0; attempt < 400; attempt++) {
      const session = await get<SessionWire>(`/sessions/${id}`);
      const step = session.data.worktree?.setup.steps.find((candidate) => candidate.kind === kind);
      if (step?.state === state) return;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    throw new Error(`step ${kind} of ${id} never became ${state}`);
  }

  async function sessionEvents(): Promise<SessionEvent[]> {
    const events: SessionEvent[] = [];
    const socket = new WebSocket(`ws://127.0.0.1:${server.port}/api/v1/ws`, [
      `kimi-code.bearer.${bearerToken(server)}`,
    ]);
    sockets.push(socket);
    socket.on('message', (raw: RawData) => {
      const frame = JSON.parse(Buffer.from(raw as Buffer).toString('utf-8')) as { type?: string };
      if (frame.type === 'session') events.push(frame as SessionEvent);
    });
    await new Promise<void>((resolve, reject) => {
      socket.once('open', () => {
        resolve();
      });
      socket.once('error', reject);
    });
    return events;
  }

  function mainAgent(sessionId: string) {
    const session = getLiveSessionById(server.core.accessor, sessionId)!;
    return session.accessor.get(IAgentLifecycleService).handleOf(MAIN_AGENT_ID)!;
  }

  function worktreeDirectories(): Promise<string[]> {
    return readdir(join(home, 'worktrees'), { recursive: true }).then(
      (entries) => entries.filter((entry) => /^[^/]+\/\d{4}-[0-9a-f]{4}(-\d+)?$/.test(entry)),
      () => [],
    );
  }

  async function expectNothingLeft(root: string, before: readonly string[]): Promise<void> {
    expect(git(root, 'worktree', 'list', '--porcelain').match(/^worktree /gm)).toHaveLength(1);
    expect(git(root, 'branch', '--list', 'kimi/*')).toBe('');
    expect(await worktreeDirectories()).toEqual(before);
  }

  it('re-points a fresh session at another directory and back to the workspace root', async () => {
    const root = await createRepo('repoint');
    const worktree = join(scratch, 'repoint-wt');
    git(root, 'worktree', 'add', '-q', '-b', 'side', worktree);
    await writeFile(join(worktree, 'only-here.txt'), 'x\n');
    const workspaceId = await createWorkspace(root);
    const created = await post<SessionWire>('/sessions', { workspace_id: workspaceId });
    const id = created.data.id;
    expect(created.data.cwd).toBe(root);
    expect(mainAgent(id).accessor.get(IAgentLoopService).getSystemPrompt()).not.toContain(worktree);

    await repointSession(server.core, id, worktree);

    const moved = await get<SessionWire>(`/sessions/${id}`);
    expect(moved.data.cwd).toBe(worktree);
    expect(moved.data.workspace_id).toBe(workspaceId);
    const status = await post<{ branch: string; entries: Record<string, string> }>(
      `/sessions/${id}/fs:git_status`,
      { include_pull_request: false },
    );
    expect(status.data.branch).toBe('side');
    expect(status.data.entries).toEqual({ 'only-here.txt': 'untracked' });
    const main = mainAgent(id);
    expect(main.accessor.get(IAgentEnvironmentBindingService).current.cwd).toBe(worktree);
    expect(main.accessor.get(IAgentEnvironmentService).workspaceRoots().workDir).toBe(worktree);
    expect(main.accessor.get(IAgentLoopService).getSystemPrompt()).toContain(worktree);

    await repointSession(server.core, id, undefined);

    const back = await get<SessionWire>(`/sessions/${id}`);
    expect(back.data.cwd).toBe(root);
    const rootStatus = await post<{ branch: string }>(`/sessions/${id}/fs:git_status`, {
      include_pull_request: false,
    });
    expect(rootStatus.data.branch).toBe('main');
    const restored = mainAgent(id);
    expect(restored.accessor.get(IAgentEnvironmentService).workspaceRoots().workDir).toBe(root);
    expect(restored.accessor.get(IAgentLoopService).getSystemPrompt()).not.toContain(worktree);
  });

  it('creates a worktree from a local branch and moves the session into it', async () => {
    const root = await createRepo('local-create');
    const workspaceId = await createWorkspace(root);
    await post(`/workspaces/${workspaceId}/trust`);
    const events = await sessionEvents();

    const created = await createWorktreeSession(workspaceId, { source_branch: 'main' });

    expect(created.cwd).toBe(root);
    expect(created.metadata).toBeUndefined();
    expect(created.worktree).toMatchObject({
      setup: {
        status: 'running',
        purpose: 'create',
        request: { source_branch: 'main' },
        commands_ran: 0,
        script: 'none',
      },
    });
    expect(created.worktree?.path).toBeUndefined();
    expect(created.worktree?.setup.steps.map((step) => step.kind)).toEqual(['create']);

    const ready = await settled(created.id);
    const worktree = ready.worktree!;
    expect(worktree.setup.status).toBe('ready');
    expect(worktree.setup.commands_ran).toBe(1);
    expect(worktree.setup.ended_at).toBeDefined();
    expect(worktree.branch).toMatch(/^kimi\/\d{4}-[0-9a-f]{4}$/);
    expect(worktree.path).toBe(
      join(home, 'worktrees', 'local-create', worktree.branch!.slice('kimi/'.length)),
    );
    expect(worktree.base).toEqual({ ref: 'main', remote: false, commit: git(root, 'rev-parse', 'main') });
    expect(worktree.included_local_changes).toBe(false);
    expect(worktree.missing).toBeUndefined();
    expect(worktree.setup.steps).toEqual([
      {
        kind: 'create',
        state: 'done',
        ref: 'main',
        command: `git worktree add --no-track -b ${worktree.branch} ${worktree.path} main`,
      },
    ]);
    expect(ready.cwd).toBe(worktree.path);
    expect(ready.workspace_id).toBe(workspaceId);
    expect(git(worktree.path!, 'rev-parse', '--abbrev-ref', 'HEAD')).toBe(worktree.branch);

    const status = await post<{ branch: string }>(`/sessions/${created.id}/fs:git_status`, {
      include_pull_request: false,
    });
    expect(status.data.branch).toBe(worktree.branch);
    const main = mainAgent(created.id);
    expect(main.accessor.get(IAgentEnvironmentService).workspaceRoots().workDir).toBe(worktree.path);
    expect(main.accessor.get(IAgentLoopService).getSystemPrompt()).toContain(worktree.path);
    const live = getLiveSessionById(server.core.accessor, created.id)!;
    expect(live.accessor.get(IWorkspaceTrust).isTrusted()).toBe(true);

    await expect.poll(() => events.at(-1)?.session.worktree?.setup.status).toBe('ready');
    const mine = events.filter((event) => event.session.id === created.id);
    expect(mine[0]).toMatchObject({ change: 'created', session: { worktree: { setup: { status: 'running' } } } });
    expect(mine.slice(1).every((event) => event.change === 'updated')).toBe(true);
    expect(
      mine.some((event) => event.session.worktree?.setup.steps[0]?.state === 'running'),
    ).toBe(true);
    expect(mine.at(-1)?.session.cwd).toBe(worktree.path);

    const listed = await get<{ items: SessionWire[] }>(`/sessions?workspace_id=${workspaceId}`);
    expect(listed.data.items.find((item) => item.id === created.id)?.worktree?.path).toBe(worktree.path);
    const registry = JSON.parse(await readFile(join(home, 'worktrees', 'registry.json'), 'utf-8')) as {
      worktrees: { path: string; branch: string; workspace_id: string; repo_root: string }[];
    };
    expect(registry.worktrees.find((entry) => entry.path === worktree.path)).toMatchObject({
      branch: worktree.branch,
      workspace_id: workspaceId,
      repo_root: root,
    });
  });

  it('starts from the freshly fetched remote branch without moving the local branch', async () => {
    const root = await createRepo('remote-create');
    const bare = await addRemote(root);
    const localTip = git(root, 'rev-parse', 'main');
    const remoteTip = await commitOnRemote(bare, 'remote.txt', 'from remote\n');
    const workspaceId = await createWorkspace(root);

    const created = await createWorktreeSession(workspaceId, { source_branch: 'main', use_remote: true });
    expect(created.worktree?.setup.steps).toMatchObject([
      {
        kind: 'fetch',
        state: 'pending',
        ref: 'origin/main',
        command: 'git fetch --no-tags origin +refs/heads/main:refs/remotes/origin/main',
      },
      { kind: 'create', state: 'pending', ref: 'origin/main' },
    ]);

    const ready = await settled(created.id);
    expect(ready.worktree?.setup).toMatchObject({ status: 'ready', commands_ran: 2 });
    expect(ready.worktree?.base).toEqual({ ref: 'origin/main', remote: true, commit: remoteTip });
    expect(git(ready.worktree!.path!, 'rev-parse', 'HEAD')).toBe(remoteTip);
    expect(existsSync(join(ready.worktree!.path!, 'remote.txt'))).toBe(true);
    expect(git(root, 'rev-parse', 'main')).toBe(localTip);
    expect(
      git(root, 'for-each-ref', '--format=%(upstream)', `refs/heads/${ready.worktree!.branch}`),
    ).toBe('');
  });

  it('creates nothing when the fetch fails, then retries from the local branch', async () => {
    const root = await createRepo('fetch-failure');
    const bare = await addRemote(root);
    await rm(bare, { recursive: true, force: true });
    const before = await worktreeDirectories();
    const workspaceId = await createWorkspace(root);

    const created = await createWorktreeSession(workspaceId, { source_branch: 'main', use_remote: true });
    const failed = await settled(created.id);

    expect(failed.worktree?.setup).toMatchObject({
      status: 'failed',
      stopped_step: 'fetch',
      failure: { kind: 'fetch_failed', remote_ref: 'origin/main' },
    });
    expect(failed.worktree?.setup.steps[0]).toMatchObject({ kind: 'fetch', state: 'failed' });
    expect(failed.worktree?.setup.steps[0]?.output).toMatch(/fatal|not appear to be a git repository/);
    expect(failed.worktree?.setup.steps[1]).toMatchObject({ kind: 'create', state: 'pending' });
    expect(failed.worktree?.path).toBeUndefined();
    expect(failed.cwd).toBe(root);
    await expectNothingLeft(root, before);

    const retried = await post<SessionWire>(`/sessions/${created.id}/worktree:retry`, { use_remote: false });
    expect(retried.code).toBe(0);
    expect(retried.data.worktree?.setup).toMatchObject({
      status: 'running',
      request: { source_branch: 'main', use_remote: false },
    });
    expect(retried.data.worktree?.setup.failure).toBeUndefined();
    expect(retried.data.worktree?.setup.steps.map((step) => step.kind)).toEqual(['create']);
    const ready = await settled(created.id);
    expect(ready.worktree?.setup.status).toBe('ready');
    expect(ready.worktree?.base).toMatchObject({ ref: 'main', remote: false });
    expect(ready.cwd).toBe(ready.worktree?.path);
  });

  it('treats a branch that vanished from the remote as having no remote', async () => {
    const root = await createRepo('stale-remote');
    const bare = await addRemote(root);
    git(root, 'checkout', '-q', '-b', 'feature');
    git(root, 'push', '-q', '-u', 'origin', 'feature');
    git(root, 'checkout', '-q', 'main');
    git(bare, 'branch', '-D', 'feature');
    const workspaceId = await createWorkspace(root);

    const created = await createWorktreeSession(workspaceId, { source_branch: 'feature', use_remote: true });
    expect(created.worktree?.setup.steps[0]).toMatchObject({ kind: 'fetch', ref: 'origin/feature' });
    const ready = await settled(created.id);

    expect(ready.worktree?.setup.status).toBe('ready');
    expect(ready.worktree?.setup.steps).toMatchObject([
      { kind: 'fetch', state: 'skipped' },
      { kind: 'create', state: 'done', ref: 'feature' },
    ]);
    expect(ready.worktree?.setup.steps[1]?.command).toMatch(/ feature$/);
    expect(ready.worktree?.base).toMatchObject({ ref: 'feature', remote: false });
  });

  it('carries uncommitted work into the worktree unstaged and leaves the main directory untouched', async () => {
    const root = await createRepo('local-changes');
    await writeFile(join(root, 'README.md'), 'hello\nedited\n');
    await writeFile(join(root, 'staged.txt'), 'staged\n');
    git(root, 'add', 'staged.txt');
    await rm(join(root, 'notes.txt'));
    await writeFile(join(root, 'untracked.txt'), 'new\n');
    await writeFile(join(root, '.gitignore'), 'ignored.log\n');
    await writeFile(join(root, 'ignored.log'), 'noise\n');
    const statusBefore = git(root, 'status', '--porcelain');
    const indexBefore = await readFile(join(root, '.git', 'index'));
    const workspaceId = await createWorkspace(root);

    const created = await createWorktreeSession(workspaceId, {
      source_branch: 'main',
      include_local_changes: true,
    });
    expect(created.worktree?.setup.steps.map((step) => step.kind)).toEqual(['create', 'changes']);
    const ready = await settled(created.id);

    expect(ready.worktree?.setup).toMatchObject({ status: 'ready', commands_ran: 2 });
    expect(ready.worktree?.included_local_changes).toBe(true);
    expect(ready.worktree?.setup.steps[1]).toMatchObject({ kind: 'changes', state: 'done' });
    expect(ready.worktree?.setup.steps[1]?.command).toMatch(/^git cherry-pick --no-commit [0-9a-f]{10}$/);
    const path = ready.worktree!.path!;
    expect(git(path, 'status', '--porcelain').split('\n').toSorted()).toEqual([
      ' D notes.txt',
      ' M README.md',
      '?? .gitignore',
      '?? staged.txt',
      '?? untracked.txt',
    ]);
    expect(await readFile(join(path, 'README.md'), 'utf-8')).toBe('hello\nedited\n');
    expect(existsSync(join(path, 'ignored.log'))).toBe(false);
    expect(git(path, 'diff', '--cached', '--name-only')).toBe('');
    expect(git(root, 'status', '--porcelain')).toBe(statusBefore);
    expect((await readFile(join(root, '.git', 'index'))).equals(indexBefore)).toBe(true);
  });

  it('skips the changes step when the main directory is clean', async () => {
    const root = await createRepo('clean-changes');
    const workspaceId = await createWorkspace(root);

    const created = await createWorktreeSession(workspaceId, {
      source_branch: 'main',
      include_local_changes: true,
    });

    expect(created.worktree?.setup.steps.map((step) => step.kind)).toEqual(['create']);
    expect((await settled(created.id)).worktree?.included_local_changes).toBe(false);
  });

  it('reports conflicting files and leaves nothing behind when local changes do not apply', async () => {
    const root = await createRepo('conflict');
    const bare = await addRemote(root);
    await commitOnRemote(bare, 'notes.txt', 'remote rewrite\n');
    await writeFile(join(root, 'notes.txt'), 'local rewrite\n');
    const before = await worktreeDirectories();
    const workspaceId = await createWorkspace(root);

    const created = await createWorktreeSession(workspaceId, {
      source_branch: 'main',
      use_remote: true,
      include_local_changes: true,
    });
    const failed = await settled(created.id);

    expect(failed.worktree?.setup).toMatchObject({
      status: 'failed',
      stopped_step: 'changes',
      failure: { kind: 'conflict', conflict_files: ['notes.txt'], remote_ref: 'origin/main' },
    });
    expect(failed.worktree?.setup.steps.map((step) => step.state)).toEqual(['done', 'done', 'failed']);
    expect(failed.worktree?.path).toBeUndefined();
    expect(failed.cwd).toBe(root);
    expect(await readFile(join(root, 'notes.txt'), 'utf-8')).toBe('local rewrite\n');
    await expectNothingLeft(root, before);

    const local = await post<SessionWire>(`/sessions/${created.id}/worktree:use_local`);
    expect(local.data.worktree).toMatchObject({ setup: { status: 'local' } });
    expect(local.data.worktree?.path).toBeUndefined();
    expect(local.data.cwd).toBe(root);
    const again = await post<SessionWire>(`/sessions/${created.id}/worktree:retry`);
    expect(again.code).toBe(ErrorCode.WORKTREE_STATE_INVALID);
  });

  it('cancels a running setup, leaving nothing behind', async () => {
    const root = await createRepo('cancel');
    git(root, 'config', 'protocol.ext.allow', 'always');
    git(root, 'remote', 'add', 'origin', 'ext::sleep 30');
    git(root, 'update-ref', 'refs/remotes/origin/main', 'HEAD');
    const before = await worktreeDirectories();
    const workspaceId = await createWorkspace(root);

    const created = await createWorktreeSession(workspaceId, { source_branch: 'main', use_remote: true });
    await untilStep(created.id, 'fetch', 'running');
    const cancelled = await post<SessionWire>(`/sessions/${created.id}/worktree:cancel`);

    expect(cancelled.code).toBe(0);
    expect(cancelled.data.worktree?.setup).toMatchObject({ status: 'stopped', stopped_step: 'fetch' });
    expect(cancelled.data.worktree?.setup.steps).toMatchObject([
      { kind: 'fetch', state: 'stopped' },
      { kind: 'create', state: 'pending' },
    ]);
    expect(cancelled.data.cwd).toBe(root);
    await expectNothingLeft(root, before);
    const twice = await post<SessionWire>(`/sessions/${created.id}/worktree:cancel`);
    expect(twice.code).toBe(ErrorCode.WORKTREE_STATE_INVALID);
  });

  it('rejects worktree requests it cannot serve', async () => {
    const plain = join(scratch, 'not-a-repo');
    await mkdir(plain, { recursive: true });
    const plainWorkspace = await createWorkspace(plain);
    const unsupported = await post<SessionWire>('/sessions', {
      workspace_id: plainWorkspace,
      worktree: { source_branch: 'main' },
    });
    expect(unsupported.code).toBe(ErrorCode.WORKTREE_UNSUPPORTED);

    const root = await createRepo('rejections');
    const workspaceId = await createWorkspace(root);
    const unknownBranch = await post<SessionWire>('/sessions', {
      workspace_id: workspaceId,
      worktree: { source_branch: 'nope' },
    });
    expect(unknownBranch.code).toBe(ErrorCode.VALIDATION_FAILED);

    const local = await post<SessionWire>('/sessions', { workspace_id: workspaceId });
    expect(local.data.worktree).toBeUndefined();
    const noSetup = await post<SessionWire>(`/sessions/${local.data.id}/worktree:cancel`);
    expect(noSetup.code).toBe(ErrorCode.WORKTREE_STATE_INVALID);
    const missing = await post<SessionWire>('/sessions/nope/worktree:cancel');
    expect(missing.code).toBe(ErrorCode.SESSION_NOT_FOUND);

    const created = await createWorktreeSession(workspaceId, { source_branch: 'main' });
    const ready = await settled(created.id);
    for (const action of ['retry', 'cancel', 'use_local', 'recreate']) {
      const refused = await post<SessionWire>(`/sessions/${created.id}/worktree:${action}`);
      expect(refused.code, action).toBe(ErrorCode.WORKTREE_STATE_INVALID);
    }
    const profile = await post<{ session: SessionWire }>(`/sessions/${created.id}/profile`, {
      metadata: { worktree: { setup: { status: 'local' } }, note: 'kept' },
    });
    expect(profile.data.session.metadata).toEqual({ note: 'kept' });
    expect(profile.data.session.worktree).toEqual(ready.worktree);
  });

  it('settles a setup that a previous server process left running', async () => {
    const root = await createRepo('interrupted');
    const workspaceId = await createWorkspace(root);
    const created = await createWorktreeSession(workspaceId, { source_branch: 'main' });
    const ready = await settled(created.id);
    const leftoverPath = join(home, 'worktrees', 'interrupted', 'left-over');
    git(root, 'worktree', 'add', '-q', '-b', 'kimi/left-over', leftoverPath);
    const plain = await post<SessionWire>('/sessions', { workspace_id: workspaceId });
    await patchSessionMetadata(server.core.accessor, plain.data.id, (meta) => ({
      custom: {
        ...meta.custom,
        worktree: {
          repo_root: root,
          pending: { path: leftoverPath, branch: 'kimi/left-over' },
          setup: {
            ...ready.worktree!.setup,
            status: 'running',
            ended_at: undefined,
            steps: [{ kind: 'create', state: 'running' }],
          },
        },
      },
    }));

    await new SessionWorktreeService(server.core).recoverInterrupted();

    const recovered = await get<SessionWire>(`/sessions/${plain.data.id}`);
    expect(recovered.data.worktree?.setup).toMatchObject({
      status: 'stopped',
      stopped_step: 'create',
      steps: [{ kind: 'create', state: 'stopped' }],
    });
    expect(existsSync(leftoverPath)).toBe(false);
    expect(git(root, 'branch', '--list', 'kimi/left-over')).toBe('');
    expect((await get<SessionWire>(`/sessions/${created.id}`)).data.worktree?.setup.status).toBe('ready');
    const stored = storedSessionWorktree(
      (await patchSessionMetadata(server.core.accessor, plain.data.id, () => undefined))?.custom,
    );
    expect(stored?.pending).toBeUndefined();
  });
});

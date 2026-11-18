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
  closeSessionById,
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

    await patchSessionMetadata(server.core.accessor, created.id, (meta) => ({
      custom: {
        ...meta.custom,
        worktree: {
          ...(meta.custom?.['worktree'] as object),
          setup: {
            ...ready.worktree!.setup,
            status: 'running',
            ended_at: undefined,
            script: 'pending',
            steps: [...ready.worktree!.setup.steps, { kind: 'script', state: 'running' }],
          },
        },
      },
    }));
    await new SessionWorktreeService(server.core).recoverInterrupted();
    const paused = await get<SessionWire>(`/sessions/${created.id}`);
    expect(paused.data.worktree?.setup).toMatchObject({ status: 'stopped', stopped_step: 'script' });
    expect(paused.data.worktree?.path).toBe(ready.worktree!.path);
    expect(existsSync(ready.worktree!.path!)).toBe(true);
    const resumed = await post<SessionWire>(`/sessions/${created.id}/worktree:skip_script`);
    expect(resumed.data.worktree?.setup).toMatchObject({ status: 'ready', script: 'skipped' });
  });

  it('lists local branches by latest commit with their remote branch and the dirty flag', async () => {
    interface Branches {
      is_repo: boolean;
      head_branch?: string;
      dirty: boolean;
      branches: { name: string; committed_at: string; remote_ref?: string }[];
    }
    const plain = join(scratch, 'branches-plain');
    await mkdir(plain, { recursive: true });
    const plainBranches = await get<Branches>(`/workspaces/${await createWorkspace(plain)}/git/branches`);
    expect(plainBranches.data).toEqual({ is_repo: false, dirty: false, branches: [] });

    const root = await createRepo('branches');
    await addRemote(root);
    const commitAt = (branch: string, date: string) => {
      git(root, 'checkout', '-q', '-b', branch, 'main');
      execFileSync('git', ['commit', '-q', '--allow-empty', '-m', branch], {
        cwd: root,
        env: { ...process.env, GIT_COMMITTER_DATE: date, GIT_AUTHOR_DATE: date },
      });
    };
    commitAt('older', '2030-01-01T00:00:00Z');
    commitAt('newest', '2031-06-01T12:00:00Z');
    git(root, 'checkout', '-q', 'main');
    await mkdir(join(root, 'nested'));
    const workspaceId = await createWorkspace(root);
    const nestedWorkspaceId = await createWorkspace(join(root, 'nested'));

    const clean = await get<Branches>(`/workspaces/${workspaceId}/git/branches`);
    expect(clean.code).toBe(0);
    expect(clean.data).toMatchObject({ is_repo: true, head_branch: 'main', dirty: false });
    expect(clean.data.branches.map((branch) => branch.name)).toEqual(['newest', 'older', 'main']);
    expect(clean.data.branches[0]).toEqual({ name: 'newest', committed_at: '2031-06-01T12:00:00.000Z' });
    expect(clean.data.branches[2]).toMatchObject({ name: 'main', remote_ref: 'origin/main' });

    await writeFile(join(root, 'untracked.txt'), 'x\n');
    git(root, 'checkout', '-q', '--detach');
    const dirty = await get<Branches>(`/workspaces/${workspaceId}/git/branches`);
    expect(dirty.data.dirty).toBe(true);
    expect(dirty.data).not.toHaveProperty('head_branch');

    const nested = await get<Branches>(`/workspaces/${nestedWorkspaceId}/git/branches`);
    expect(nested.data.is_repo).toBe(false);
    const unknown = await get<Branches>('/workspaces/wd_missing_000000000000/git/branches');
    expect(unknown.code).toBe(ErrorCode.WORKSPACE_NOT_FOUND);
  });

  interface WorktreeWire {
    path: string;
    name: string;
    repo_root: string;
    workspace_id?: string;
    workspace_name?: string;
    branch?: string;
    origin: 'product' | 'external';
    created_at?: string;
    size_bytes?: number;
    sessions: { id: string; title: string; archived: boolean; busy: boolean }[];
  }

  async function listWorktrees(query = ''): Promise<{ items: WorktreeWire[]; total_size_bytes?: number }> {
    const listed = await get<{ items: WorktreeWire[]; total_size_bytes?: number }>(`/worktrees${query}`);
    expect(listed.code).toBe(0);
    return listed.data;
  }

  it('lists product and external worktrees with their sessions and sizes', async () => {
    const root = await createRepo('inventory');
    const workspaceId = await createWorkspace(root);
    const session = await settled(
      (await createWorktreeSession(workspaceId, { source_branch: 'main' })).id,
    );
    const path = session.worktree!.path!;
    const external = join(scratch, 'inventory-external');
    git(root, 'worktree', 'add', '-q', '-b', 'manual', external);
    const fork = await post<SessionWire>(`/sessions/${session.id}:fork`, { title: 'forked' });
    expect(fork.data.cwd).toBe(path);
    expect(fork.data.worktree?.path).toBe(path);
    await post(`/sessions/${fork.data.id}:archive`);

    const listed = await listWorktrees('?refresh=sizes');
    const mine = listed.items.filter((item) => item.repo_root === root);

    expect(mine.map((item) => [item.path, item.origin])).toEqual(
      [
        [external, 'external'],
        [path, 'product'],
      ].toSorted(([a], [b]) => a!.localeCompare(b!)),
    );
    expect(listed.items.some((item) => item.path === root)).toBe(false);
    const product = mine.find((item) => item.path === path)!;
    expect(product).toMatchObject({
      name: session.worktree!.branch!.slice('kimi/'.length),
      repo_root: root,
      workspace_id: workspaceId,
      workspace_name: 'inventory',
      branch: session.worktree!.branch,
    });
    expect(product.created_at).toBeDefined();
    expect(product.size_bytes).toBeGreaterThan(0);
    expect(product.sessions.toSorted((a, b) => a.title.localeCompare(b.title))).toEqual([
      { id: session.id, title: '', archived: false, busy: false },
      { id: fork.data.id, title: 'forked', archived: true, busy: false },
    ]);
    expect(mine.find((item) => item.path === external)).toMatchObject({
      name: 'inventory-external',
      branch: 'manual',
      workspace_id: workspaceId,
      sessions: [],
    });
    expect(listed.total_size_bytes).toBe(
      listed.items.reduce((total, item) => total + (item.size_bytes ?? 0), 0),
    );
    const cached = await listWorktrees();
    expect(cached.items.find((item) => item.path === path)?.size_bytes).toBe(product.size_bytes);

    git(path, 'branch', '-m', 'renamed-by-agent');
    await expect
      .poll(async () => (await get<SessionWire>(`/sessions/${session.id}`)).data.worktree?.branch, {
        timeout: 8_000,
        interval: 250,
      })
      .toBe('renamed-by-agent');
    await expect
      .poll(async () =>
        storedSessionWorktree(
          (await patchSessionMetadata(server.core.accessor, session.id, () => undefined))?.custom,
        )?.branch,
      )
      .toBe('renamed-by-agent');
    expect((await listWorktrees()).items.find((item) => item.path === path)?.branch).toBe(
      'renamed-by-agent',
    );
  });

  it('reports what removing a worktree would lose', async () => {
    const root = await createRepo('inspect');
    await addRemote(root);
    const workspaceId = await createWorkspace(root);
    const session = await settled(
      (await createWorktreeSession(workspaceId, { source_branch: 'main' })).id,
    );
    const path = session.worktree!.path!;
    await writeFile(join(path, 'README.md'), 'changed\n');
    await mkdir(join(path, 'new-dir'));
    await writeFile(join(path, 'new-dir', 'a.txt'), 'a\n');
    await writeFile(join(path, 'new-dir', 'b.txt'), 'b\n');
    git(path, 'config', 'user.email', 'dev@example.com');
    git(path, 'config', 'user.name', 'Dev');
    await writeFile(join(path, 'committed.txt'), 'c\n');
    git(path, 'add', 'committed.txt');
    git(path, 'commit', '-q', '-m', 'local only');

    const inspected = await post<{
      items: { path: string; branch?: string; uncommitted_files: number; unpushed_commits: number; sessions: { id: string }[] }[];
      errors: Record<string, { code: number; msg: string }>;
    }>('/worktrees:inspect', { paths: [path, root, join(scratch, 'nowhere')] });

    expect(inspected.code).toBe(0);
    expect(inspected.data.items).toEqual([
      {
        path,
        branch: session.worktree!.branch,
        uncommitted_files: 3,
        unpushed_commits: 1,
        sessions: [{ id: session.id, title: '', archived: false, busy: false }],
      },
    ]);
    expect(inspected.data.errors[root]?.code).toBe(ErrorCode.WORKTREE_NOT_FOUND);
    expect(inspected.data.errors[join(scratch, 'nowhere')]?.code).toBe(ErrorCode.WORKTREE_NOT_FOUND);
  });

  it('removes a dirty worktree unless a session using it is busy', async () => {
    const root = await createRepo('remove');
    git(root, 'config', 'protocol.ext.allow', 'always');
    const workspaceId = await createWorkspace(root);
    const session = await settled(
      (await createWorktreeSession(workspaceId, { source_branch: 'main' })).id,
    );
    const { path, branch } = session.worktree as { path: string; branch: string };
    await writeFile(join(path, 'dirty.txt'), 'x\n');

    const notWorktree = await post('/worktrees:remove', { path: root });
    expect(notWorktree.code).toBe(ErrorCode.WORKTREE_NOT_FOUND);

    const other = await post<SessionWire>(`/sessions/${session.id}:fork`, {});
    git(root, 'remote', 'add', 'origin', 'ext::sleep 30');
    git(root, 'update-ref', 'refs/remotes/origin/main', 'HEAD');
    await patchSessionMetadata(server.core.accessor, other.data.id, (meta) => ({
      custom: {
        ...meta.custom,
        worktree: {
          ...(meta.custom?.['worktree'] as object),
          setup: { ...session.worktree!.setup, status: 'running', ended_at: undefined },
        },
      },
    }));
    const busy = await post('/worktrees:remove', { path });
    expect(busy.code).toBe(ErrorCode.WORKTREE_REMOVE_FAILED);
    expect(busy.details).toMatchObject({ reason: 'session_busy' });
    expect(existsSync(path)).toBe(true);
    expect((await listWorktrees()).items.find((item) => item.path === path)?.sessions).toEqual(
      expect.arrayContaining([expect.objectContaining({ id: other.data.id, busy: true })]),
    );
    await post(`/sessions/${other.data.id}:delete`);

    const events = await sessionEvents();
    const removed = await post<{ removed: boolean; branch_deleted: boolean }>('/worktrees:remove', {
      path,
      delete_branch: true,
    });

    expect(removed.code).toBe(0);
    expect(removed.data).toEqual({ removed: true, branch_deleted: true });
    expect(existsSync(path)).toBe(false);
    expect(git(root, 'branch', '--list', branch)).toBe('');
    expect(git(root, 'worktree', 'list', '--porcelain').match(/^worktree /gm)).toHaveLength(1);
    expect((await listWorktrees()).items.some((item) => item.path === path)).toBe(false);
    const after = await get<SessionWire>(`/sessions/${session.id}`);
    expect(after.data.worktree).toMatchObject({ path, missing: true, branch_missing: true });
    await expect
      .poll(() => events.find((event) => event.session.id === session.id)?.session.worktree?.missing)
      .toBe(true);
    const status = await post(`/sessions/${session.id}/fs:git_status`, {});
    expect(status.code).toBe(ErrorCode.FS_DIRECTORY_NOT_FOUND);
    const again = await post('/worktrees:remove', { path });
    expect(again.code).toBe(ErrorCode.WORKTREE_NOT_FOUND);
  });

  it('prunes a worktree whose directory is already gone and keeps the branch by default', async () => {
    const root = await createRepo('remove-gone');
    const workspaceId = await createWorkspace(root);
    const session = await settled(
      (await createWorktreeSession(workspaceId, { source_branch: 'main' })).id,
    );
    const { path, branch } = session.worktree as { path: string; branch: string };
    await rm(path, { recursive: true, force: true });
    expect((await listWorktrees()).items.some((item) => item.path === path)).toBe(false);
    const missing = await get<SessionWire>(`/sessions/${session.id}`);
    expect(missing.data.worktree).toMatchObject({ missing: true });
    expect(missing.data.worktree?.branch_missing).toBeUndefined();

    const removed = await post<{ removed: boolean; branch_deleted: boolean }>('/worktrees:remove', { path });

    expect(removed.data).toEqual({ removed: true, branch_deleted: false });
    expect(git(root, 'branch', '--list', branch)).toContain(branch);
    expect(git(root, 'worktree', 'list', '--porcelain').match(/^worktree /gm)).toHaveLength(1);
  });

  it('removes the worktree with its last session and keeps it while others use it', async () => {
    const root = await createRepo('delete-session');
    const workspaceId = await createWorkspace(root);
    const first = await settled(
      (await createWorktreeSession(workspaceId, { source_branch: 'main' })).id,
    );
    const { path, branch } = first.worktree as { path: string; branch: string };
    const second = await post<SessionWire>(`/sessions/${first.id}:fork`, {});
    await post(`/sessions/${second.data.id}:archive`);

    const kept = await post<{ deleted: boolean; worktree?: Record<string, unknown> }>(
      `/sessions/${first.id}:delete`,
      { remove_worktree: true, delete_branch: true },
    );
    expect(kept.data).toEqual({ deleted: true, worktree: { outcome: 'kept_in_use', other_sessions: 1 } });
    expect(existsSync(path)).toBe(true);
    expect(git(root, 'branch', '--list', branch)).toContain(branch);

    const removed = await post<{ deleted: boolean; worktree?: Record<string, unknown> }>(
      `/sessions/${second.data.id}:delete`,
      { remove_worktree: true, delete_branch: true },
    );
    expect(removed.data).toEqual({ deleted: true, worktree: { outcome: 'removed', branch_deleted: true } });
    expect(existsSync(path)).toBe(false);
    expect(git(root, 'branch', '--list', branch)).toBe('');

    const third = await settled(
      (await createWorktreeSession(workspaceId, { source_branch: 'main' })).id,
    );
    await rm(third.worktree!.path!, { recursive: true, force: true });
    const gone = await post<{ deleted: boolean; worktree?: Record<string, unknown> }>(
      `/sessions/${third.id}:delete`,
      { remove_worktree: true },
    );
    expect(gone.data).toEqual({ deleted: true, worktree: { outcome: 'missing', branch_deleted: false } });

    const fourth = await settled(
      (await createWorktreeSession(workspaceId, { source_branch: 'main' })).id,
    );
    const plainDelete = await post<{ deleted: boolean; worktree?: unknown }>(`/sessions/${fourth.id}:delete`);
    expect(plainDelete.data).toEqual({ deleted: true });
    expect(existsSync(fourth.worktree!.path!)).toBe(true);
    const local = await post<SessionWire>('/sessions', { workspace_id: workspaceId });
    const localDelete = await post<{ deleted: boolean; worktree?: unknown }>(
      `/sessions/${local.data.id}:delete`,
      { remove_worktree: true },
    );
    expect(localDelete.data).toEqual({ deleted: true });
    expect(existsSync(root)).toBe(true);
  });

  it('keeps the session deletion when the worktree directory cannot be removed', async () => {
    const root = await createRepo('delete-failure');
    const workspaceId = await createWorkspace(root);
    const session = await settled(
      (await createWorktreeSession(workspaceId, { source_branch: 'main' })).id,
    );
    const path = session.worktree!.path!;
    await mkdir(join(path, 'locked'));
    await writeFile(join(path, 'locked', 'file.txt'), 'x\n');
    const { chmod } = await import('node:fs/promises');
    await chmod(join(path, 'locked'), 0o500);
    try {
      const deleted = await post<{ deleted: boolean; worktree?: { outcome: string; output?: string } }>(
        `/sessions/${session.id}:delete`,
        { remove_worktree: true },
      );

      expect(deleted.code).toBe(0);
      expect(deleted.data.deleted).toBe(true);
      expect(deleted.data.worktree?.outcome).toBe('failed');
      expect(deleted.data.worktree?.output).toMatch(/locked|permission|EACCES/i);
      expect((await get<SessionWire>(`/sessions/${session.id}`)).code).toBe(ErrorCode.SESSION_NOT_FOUND);
      const direct = await post('/worktrees:remove', { path });
      expect(direct.code).toBe(ErrorCode.WORKTREE_REMOVE_FAILED);
      expect(direct.details).toMatchObject({ reason: 'in_use' });
    } finally {
      await chmod(join(path, 'locked'), 0o700).catch(() => undefined);
    }
  });

  it('recognises a linked worktree directory and the workspace it belongs to', async () => {
    interface Lookup {
      worktree: null | {
        repo_root: string;
        branch?: string;
        workspace?: { id: string; root: string };
        session_count: number;
      };
    }
    const root = await createRepo('lookup');
    const workspaceId = await createWorkspace(root);
    const session = await settled(
      (await createWorktreeSession(workspaceId, { source_branch: 'main' })).id,
    );
    const path = session.worktree!.path!;
    const unregistered = await createRepo('lookup-unregistered');
    const manual = join(scratch, 'lookup-manual');
    git(unregistered, 'worktree', 'add', '-q', '--detach', manual);

    const product = await post<Lookup>('/worktrees:lookup', { path });
    expect(product.data.worktree).toMatchObject({
      repo_root: root,
      branch: session.worktree!.branch,
      workspace: { id: workspaceId, root },
      session_count: 1,
    });
    const detached = await post<Lookup>('/worktrees:lookup', { path: manual });
    expect(detached.data.worktree).toEqual({ repo_root: unregistered, session_count: 0 });
    for (const other of [root, join(path, 'README.md'), join(scratch, 'nowhere'), scratch]) {
      const lookup = await post<Lookup>('/worktrees:lookup', { path: other });
      expect(lookup.data.worktree, other).toBeNull();
    }
  });

  it('recreates a missing worktree from its recorded branch', async () => {
    const root = await createRepo('recreate');
    const workspaceId = await createWorkspace(root);
    const session = await settled(
      (await createWorktreeSession(workspaceId, { source_branch: 'main' })).id,
    );
    const { path, branch } = session.worktree as { path: string; branch: string };
    git(path, 'config', 'user.email', 'dev@example.com');
    git(path, 'config', 'user.name', 'Dev');
    await writeFile(join(path, 'kept.txt'), 'committed in the worktree\n');
    git(path, 'add', '.');
    git(path, 'commit', '-q', '-m', 'work');
    await rm(path, { recursive: true, force: true });
    await closeSessionById(server.core.accessor, session.id);

    const missing = await get<SessionWire>(`/sessions/${session.id}`);
    expect(missing.data.worktree).toMatchObject({ path, branch, missing: true });
    expect(missing.data.worktree?.branch_missing).toBeUndefined();
    expect((await get<{ turns: unknown[] }>(`/sessions/${session.id}/agents/main/turns`)).code).toBe(0);
    expect((await post(`/sessions/${session.id}/fs:git_status`, {})).code).toBe(
      ErrorCode.FS_DIRECTORY_NOT_FOUND,
    );

    const started = await post<SessionWire>(`/sessions/${session.id}/worktree:recreate`);
    expect(started.code).toBe(0);
    expect(started.data.worktree?.setup).toMatchObject({ status: 'running', purpose: 'recreate' });
    expect(started.data.worktree?.setup.steps).toMatchObject([
      { kind: 'prune', command: 'git worktree prune' },
      { kind: 'create', ref: branch, command: `git worktree add ${path} ${branch}` },
    ]);
    const ready = await settled(session.id);

    expect(ready.worktree?.setup).toMatchObject({ status: 'ready', purpose: 'recreate', commands_ran: 2 });
    expect(ready.worktree?.setup.steps.map((step) => step.state)).toEqual(['done', 'done']);
    expect(ready.worktree?.missing).toBeUndefined();
    expect(ready.worktree?.path).toBe(path);
    expect(ready.cwd).toBe(path);
    expect(await readFile(join(path, 'kept.txt'), 'utf-8')).toBe('committed in the worktree\n');
    const status = await post<{ branch: string }>(`/sessions/${session.id}/fs:git_status`, {
      include_pull_request: false,
    });
    expect(status.data.branch).toBe(branch);
  });

  it('falls back to the workspace root when a missing worktree cannot be recreated', async () => {
    const root = await createRepo('recreate-failure');
    const workspaceId = await createWorkspace(root);
    const session = await settled(
      (await createWorktreeSession(workspaceId, { source_branch: 'main' })).id,
    );
    const { path, branch } = session.worktree as { path: string; branch: string };
    await rm(path, { recursive: true, force: true });
    git(root, 'worktree', 'prune');
    git(root, 'branch', '-D', branch);

    const missing = await get<SessionWire>(`/sessions/${session.id}`);
    expect(missing.data.worktree).toMatchObject({ missing: true, branch_missing: true });
    await post<SessionWire>(`/sessions/${session.id}/worktree:recreate`);
    const failed = await settled(session.id);

    expect(failed.worktree?.setup).toMatchObject({
      status: 'failed',
      purpose: 'recreate',
      stopped_step: 'create',
      failure: { kind: 'create_failed' },
    });
    expect(failed.worktree?.setup.steps[1]?.output).toMatch(/invalid reference|not a valid|fatal/);
    expect(failed.worktree?.path).toBe(path);
    expect(existsSync(path)).toBe(false);
    const retried = await post<SessionWire>(`/sessions/${session.id}/worktree:retry`);
    expect(retried.data.worktree?.setup).toMatchObject({ status: 'running', purpose: 'recreate' });
    await settled(session.id);

    const local = await post<SessionWire>(`/sessions/${session.id}/worktree:use_local`);

    expect(local.code).toBe(0);
    expect(local.data.cwd).toBe(root);
    expect(local.data.worktree?.setup.status).toBe('local');
    expect(local.data.worktree?.path).toBeUndefined();
    expect(local.data.worktree?.branch).toBeUndefined();
    expect(local.data.worktree?.missing).toBeUndefined();
    const main = mainAgent(session.id);
    expect(main.accessor.get(IAgentEnvironmentService).workspaceRoots().workDir).toBe(root);
    expect(main.accessor.get(IAgentEnvironmentBindingService).current.cwd).toBeUndefined();
    expect(main.accessor.get(IAgentLoopService).getSystemPrompt()).not.toContain(path);
    const status = await post<{ branch: string }>(`/sessions/${session.id}/fs:git_status`, {
      include_pull_request: false,
    });
    expect(status.data.branch).toBe('main');
  });

  interface ScriptWire {
    path: string;
    exists: boolean;
    content?: string;
    needs_confirmation?: boolean;
  }

  async function saveScript(workspaceId: string, content: string): Promise<Envelope<ScriptWire>> {
    const res = await fetch(`${base}/api/v1/workspaces/${workspaceId}/worktree-setup-script`, {
      method: 'PUT',
      headers: authHeaders(server, { 'content-type': 'application/json' }),
      body: JSON.stringify({ content }),
    } as never);
    return (await res.json()) as Envelope<ScriptWire>;
  }

  it('runs a setup script saved on this machine as the last step', async () => {
    const root = await createRepo('script-saved');
    const workspaceId = await createWorkspace(root);
    const none = await get<ScriptWire>(`/workspaces/${workspaceId}/worktree-setup-script`);
    expect(none.data).toEqual({ path: join(root, '.kimi', 'setup.sh'), exists: false });
    const content = '#!/bin/sh\necho "$KIMI_PROJECT_DIR" > project-dir.txt\npwd -P > cwd.txt\n';

    const saved = await saveScript(workspaceId, content);

    expect(saved.data).toEqual({
      path: join(root, '.kimi', 'setup.sh'),
      exists: true,
      content,
      needs_confirmation: false,
    });
    expect(await readFile(join(root, '.kimi', 'setup.sh'), 'utf-8')).toBe(content);
    expect((await get<ScriptWire>(`/workspaces/${workspaceId}/worktree-setup-script`)).data).toEqual(saved.data);

    const created = await createWorktreeSession(workspaceId, { source_branch: 'main' });
    expect(created.worktree?.setup.script).toBe('pending');
    expect(created.worktree?.setup.steps).toMatchObject([
      { kind: 'create', state: 'pending' },
      { kind: 'script', state: 'pending', command: `/bin/sh ${join(root, '.kimi', 'setup.sh')}` },
    ]);
    const ready = await settled(created.id);

    expect(ready.worktree?.setup).toMatchObject({ status: 'ready', script: 'ran', commands_ran: 2 });
    expect(ready.worktree?.setup.steps.map((step) => step.state)).toEqual(['done', 'done']);
    const path = ready.worktree!.path!;
    expect((await readFile(join(path, 'project-dir.txt'), 'utf-8')).trim()).toBe(root);
    expect((await readFile(join(path, 'cwd.txt'), 'utf-8')).trim()).toBe(path);

    const skipped = await settled(
      (await createWorktreeSession(workspaceId, { source_branch: 'main', run_setup_script: false })).id,
    );
    expect(skipped.worktree?.setup).toMatchObject({ status: 'ready', script: 'skipped', commands_ran: 1 });
    expect(skipped.worktree?.setup.steps.map((step) => step.kind)).toEqual(['create']);
    expect(existsSync(join(skipped.worktree!.path!, 'cwd.txt'))).toBe(false);

    const cleared = await saveScript(workspaceId, '');
    expect(cleared.data).toEqual({ path: join(root, '.kimi', 'setup.sh'), exists: false });
    expect(existsSync(join(root, '.kimi', 'setup.sh'))).toBe(false);
    const without = await settled(
      (await createWorktreeSession(workspaceId, { source_branch: 'main' })).id,
    );
    expect(without.worktree?.setup).toMatchObject({ status: 'ready', script: 'none' });
  });

  it('asks before running a setup script that came from the repository', async () => {
    const root = await createRepo('script-repository');
    await mkdir(join(root, '.kimi'));
    const content = 'echo ran >> script.log\n';
    await writeFile(join(root, '.kimi', 'setup.sh'), content);
    git(root, 'add', '.');
    git(root, 'commit', '-q', '-m', 'add setup script');
    const workspaceId = await createWorkspace(root);
    expect((await get<ScriptWire>(`/workspaces/${workspaceId}/worktree-setup-script`)).data).toMatchObject({
      exists: true,
      needs_confirmation: true,
    });

    const waiting = await settled(
      (await createWorktreeSession(workspaceId, { source_branch: 'main' })).id,
    );

    expect(waiting.worktree?.setup).toMatchObject({
      status: 'awaiting_script_confirmation',
      script: 'pending',
      script_content: content,
      commands_ran: 1,
    });
    expect(waiting.worktree?.setup.steps).toMatchObject([
      { kind: 'create', state: 'done' },
      { kind: 'script', state: 'pending', command: `sh ${join(root, '.kimi', 'setup.sh')}` },
    ]);
    const path = waiting.worktree!.path!;
    expect(waiting.cwd).toBe(path);
    expect(existsSync(join(path, 'script.log'))).toBe(false);
    for (const action of ['retry', 'cancel', 'use_local']) {
      const refused = await post<SessionWire>(`/sessions/${waiting.id}/worktree:${action}`);
      expect(refused.code, action).toBe(ErrorCode.WORKTREE_STATE_INVALID);
    }

    const running = await post<SessionWire>(`/sessions/${waiting.id}/worktree:run_script`);
    expect(running.data.worktree?.setup).toMatchObject({ status: 'running', script: 'pending' });
    expect(running.data.worktree?.setup.script_content).toBeUndefined();
    const ready = await settled(waiting.id);
    expect(ready.worktree?.setup).toMatchObject({ status: 'ready', script: 'ran', commands_ran: 2 });
    expect(await readFile(join(path, 'script.log'), 'utf-8')).toBe('ran\n');

    const trusted = await settled(
      (await createWorktreeSession(workspaceId, { source_branch: 'main' })).id,
    );
    expect(trusted.worktree?.setup).toMatchObject({ status: 'ready', script: 'ran' });

    await writeFile(join(root, '.kimi', 'setup.sh'), 'echo changed >> script.log\n');
    const changed = await settled(
      (await createWorktreeSession(workspaceId, { source_branch: 'main' })).id,
    );
    expect(changed.worktree?.setup).toMatchObject({
      status: 'awaiting_script_confirmation',
      script_content: 'echo changed >> script.log\n',
    });
    await writeFile(join(root, '.kimi', 'setup.sh'), 'echo changed again >> script.log\n');
    const stale = await post<SessionWire>(`/sessions/${changed.id}/worktree:run_script`);
    expect(stale.code).toBe(0);
    expect((await settled(changed.id)).worktree?.setup).toMatchObject({
      status: 'awaiting_script_confirmation',
      script_content: 'echo changed again >> script.log\n',
    });
    const skipped = await post<SessionWire>(`/sessions/${changed.id}/worktree:skip_script`);
    expect(skipped.data.worktree?.setup).toMatchObject({ status: 'ready', script: 'skipped' });
    expect(skipped.data.worktree?.setup.script_content).toBeUndefined();
    expect(skipped.data.worktree?.setup.steps.at(-1)).toMatchObject({ kind: 'script', state: 'skipped' });
    expect(existsSync(join(changed.worktree!.path!, 'script.log'))).toBe(false);
  });

  it('keeps the worktree when the setup script fails or is stopped', async () => {
    const root = await createRepo('script-failure');
    const workspaceId = await createWorkspace(root);
    await saveScript(workspaceId, 'echo "no lockfile" >&2\nexit 3\n');

    const failed = await settled(
      (await createWorktreeSession(workspaceId, { source_branch: 'main' })).id,
    );

    expect(failed.worktree?.setup).toMatchObject({
      status: 'failed',
      stopped_step: 'script',
      failure: { kind: 'script_failed', exit_code: 3 },
      script: 'pending',
    });
    expect(failed.worktree?.setup.steps.at(-1)).toMatchObject({
      kind: 'script',
      state: 'failed',
      output: 'no lockfile\n',
    });
    const path = failed.worktree!.path!;
    expect(existsSync(path)).toBe(true);
    expect(failed.cwd).toBe(path);
    for (const action of ['retry', 'use_local']) {
      const refused = await post<SessionWire>(`/sessions/${failed.id}/worktree:${action}`);
      expect(refused.code, action).toBe(ErrorCode.WORKTREE_STATE_INVALID);
    }

    await saveScript(workspaceId, 'echo started > started.txt\nsleep 30\n');
    const rerun = await post<SessionWire>(`/sessions/${failed.id}/worktree:run_script`);
    expect(rerun.data.worktree?.setup).toMatchObject({ status: 'running' });
    expect(rerun.data.worktree?.setup.failure).toBeUndefined();
    await expect.poll(() => existsSync(join(path, 'started.txt')), { timeout: 5_000 }).toBe(true);
    const stopped = await post<SessionWire>(`/sessions/${failed.id}/worktree:cancel`);
    expect(stopped.data.worktree?.setup).toMatchObject({ status: 'stopped', stopped_step: 'script' });
    expect(stopped.data.worktree?.setup.steps.at(-1)).toMatchObject({ kind: 'script', state: 'stopped' });
    expect(existsSync(path)).toBe(true);
    expect(stopped.data.cwd).toBe(path);

    await saveScript(workspaceId, 'echo ok > ok.txt\n');
    await post<SessionWire>(`/sessions/${failed.id}/worktree:run_script`);
    const ready = await settled(failed.id);
    expect(ready.worktree?.setup).toMatchObject({ status: 'ready', script: 'ran' });
    expect(ready.worktree?.setup.failure).toBeUndefined();
    expect(ready.worktree?.setup.stopped_step).toBeUndefined();
    expect(existsSync(join(path, 'ok.txt'))).toBe(true);
    const done = await post<SessionWire>(`/sessions/${failed.id}/worktree:skip_script`);
    expect(done.code).toBe(ErrorCode.WORKTREE_STATE_INVALID);
  });
});

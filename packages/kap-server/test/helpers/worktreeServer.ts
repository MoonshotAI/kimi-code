import { mkdtemp, readdir, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  AgentEnvironmentBindingService,
  AgentLoopService,
  IAgentLifecycleService,
  MAIN_AGENT_ID,
  SessionMetadata,
  getLiveSessionById,
  patchSessionMetadata,
} from '@moonshot-ai/agent-core-v2';
import { afterAll, afterEach, beforeAll, expect, onTestFinished, vi } from 'vitest';
import { WebSocket, type RawData } from 'ws';

import type { Session } from '../../src/protocol/session';
import {
  storedSessionWorktree,
  type StoredSessionWorktree,
} from '../../src/services/worktrees/sessionWorktreeState';
import { type RunningServer, startServer } from '../../src/start';
import { authedFetch, bearerToken } from './auth';
import { commitAll, createRepoTemplate, git, type RepoTemplate } from './gitRepo';
import { TEST_HOST_IDENTITY } from './hostIdentity';

export interface Envelope<T> {
  code: number;
  msg: string;
  data: T;
  request_id: string;
  details?: unknown;
}

export interface SessionEvent {
  type: 'session';
  change: string;
  session: Session;
}

export interface Project {
  root: string;
  workspaceId: string;
}

const STUB_CONFIG = [
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
].join('\n');

export interface Resolvers<T> {
  readonly promise: Promise<T>;
  readonly resolve: (value: T) => void;
  readonly reject: (reason: unknown) => void;
}

export function withResolvers<T = void>(): Resolvers<T> {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((onResolve, onReject) => {
    resolve = onResolve;
    reject = onReject;
  });
  return { promise, resolve, reject };
}

export function eventually<T>(check: () => T | Promise<T>): Promise<T> {
  return vi.waitFor(check, { timeout: 10_000, interval: 25 });
}

export function failMetadataWriteOnce(
  predicate: (stored: StoredSessionWorktree | undefined) => boolean,
): { readonly failed: boolean } {
  const state = { failed: false };
  const originalUpdate = SessionMetadata.prototype.update;
  const update = vi.spyOn(SessionMetadata.prototype, 'update').mockImplementation(function (
    this: SessionMetadata,
    ...args: Parameters<SessionMetadata['update']>
  ) {
    if (!state.failed && predicate(storedSessionWorktree(args[0].custom))) {
      state.failed = true;
      return Promise.reject(new Error('metadata write failed'));
    }
    return originalUpdate.apply(this, args);
  });
  onTestFinished(() => {
    update.mockRestore();
  });
  return state;
}

export function useWorktreeServer(name: string, options: { extraConfig?: string } = {}) {
  let server: RunningServer;
  let home: string;
  let scratch: string;
  let base: string;
  let template: RepoTemplate;
  const sockets: WebSocket[] = [];

  beforeAll(async () => {
    home = await realpath(await mkdtemp(join(tmpdir(), `kimi-server-v2-${name}-home-`)));
    scratch = await realpath(await mkdtemp(join(tmpdir(), `kimi-server-v2-${name}-`)));
    await writeFile(join(home, 'config.toml'), STUB_CONFIG + (options.extraConfig ?? ''), 'utf-8');
    template = await createRepoTemplate({ 'README.md': 'hello\n', 'notes.txt': 'one\ntwo\nthree\n' });
    server = await startServer({
      hostIdentity: TEST_HOST_IDENTITY,
      host: '127.0.0.1',
      port: 0,
      homeDir: home,
      logLevel: 'silent',
    });
    base = `http://127.0.0.1:${server.port}`;
  });

  afterEach(() => {
    for (const socket of sockets.splice(0)) socket.close();
  });

  afterAll(async () => {
    await server.close();
    await rm(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    await rm(scratch, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    await template.dispose();
  });

  async function request<T>(method: string, path: string, body?: unknown): Promise<Envelope<T>> {
    const res = await authedFetch(
      server,
      base,
      `/api/v1${path}`,
      method === 'GET'
        ? {}
        : { method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body ?? {}) },
    );
    return (await res.json()) as Envelope<T>;
  }

  function post<T>(path: string, body?: unknown): Promise<Envelope<T>> {
    return request<T>('POST', path, body);
  }

  function get<T>(path: string): Promise<Envelope<T>> {
    return request<T>('GET', path);
  }

  function createRepo(repoName: string): Promise<string> {
    return template.copyTo(join(scratch, repoName));
  }

  function addRemote(root: string): string {
    const bare = `${root}-remote.git`;
    git(scratch, 'init', '-q', '--bare', '-b', 'main', bare);
    git(root, 'remote', 'add', 'origin', bare);
    git(root, 'push', '-q', '-u', 'origin', 'main');
    return bare;
  }

  async function commitOnRemote(bare: string, file: string, content: string): Promise<string> {
    const clone = `${bare}-clone-${Math.random().toString(16).slice(2)}`;
    git(scratch, 'clone', '-q', bare, clone);
    await writeFile(join(clone, file), content);
    commitAll(clone, `remote ${file}`);
    git(clone, 'push', '-q', 'origin', 'main');
    return git(clone, 'rev-parse', 'HEAD');
  }

  async function createWorkspace(root: string): Promise<string> {
    const workspace = await post<{ id: string }>('/workspaces', { root });
    expect(workspace.code).toBe(0);
    return workspace.data.id;
  }

  async function project(repoName: string): Promise<Project> {
    const root = await createRepo(repoName);
    return { root, workspaceId: await createWorkspace(root) };
  }

  async function createWorktreeSession(
    workspaceId: string,
    worktree: Record<string, unknown> = {},
  ): Promise<Session> {
    const created = await post<Session>('/sessions', {
      workspace_id: workspaceId,
      worktree: { source_branch: 'main', ...worktree },
    });
    expect(created.code).toBe(0);
    return created.data;
  }

  async function settled(id: string): Promise<Session> {
    return eventually(async () => {
      const session = (await get<Session>(`/sessions/${id}`)).data;
      expect(session.worktree?.setup.status, `worktree setup of ${id}`).not.toBe('running');
      return session;
    });
  }

  async function settledWorktree(workspaceId: string, worktree?: Record<string, unknown>): Promise<Session> {
    return settled((await createWorktreeSession(workspaceId, worktree)).id);
  }

  async function untilStep(id: string, kind: string, state: string): Promise<void> {
    await eventually(async () => {
      const session = (await get<Session>(`/sessions/${id}`)).data;
      const step = session.worktree?.setup.steps.find((candidate) => candidate.kind === kind);
      expect(step?.state, `step ${kind} of ${id}`).toBe(state);
    });
  }

  async function duringWorktreeSwitch<T>(
    start: () => Promise<string>,
    during: (sessionId: string) => Promise<T>,
  ): Promise<{ sessionId: string; during: Promise<T> }> {
    const worktreesHome = join(home, 'worktrees');
    const created = withResolvers<string>();
    const finished = withResolvers<T>();
    created.promise.catch(() => undefined);
    let switching = false;
    const originalBind = AgentEnvironmentBindingService.prototype.bind;
    const originalBindProfile = AgentLoopService.prototype.bindProfile;
    const bind = vi.spyOn(AgentEnvironmentBindingService.prototype, 'bind').mockImplementation(function (
      this: AgentEnvironmentBindingService,
      ...args: Parameters<AgentEnvironmentBindingService['bind']>
    ) {
      if (args[1]?.startsWith(worktreesHome) === true) switching = true;
      return originalBind.apply(this, args);
    });
    const bindProfile = vi.spyOn(AgentLoopService.prototype, 'bindProfile').mockImplementation(async function (
      this: AgentLoopService,
      ...args: Parameters<AgentLoopService['bindProfile']>
    ) {
      if (switching) {
        switching = false;
        await during(await created.promise).then(finished.resolve, finished.reject);
      }
      return originalBindProfile.apply(this, args);
    });
    onTestFinished(() => {
      bind.mockRestore();
      bindProfile.mockRestore();
    });
    try {
      const sessionId = await start();
      created.resolve(sessionId);
      return { sessionId, during: finished.promise };
    } catch (error) {
      created.reject(error);
      throw error;
    }
  }

  async function branchOf(sessionId: string): Promise<string> {
    const status = await post<{ branch: string }>(`/sessions/${sessionId}/fs:git_status`, {
      include_pull_request: false,
    });
    return status.data.branch;
  }

  async function forceRunning(sessionId: string, setup: object, worktree: object = {}): Promise<void> {
    await patchSessionMetadata(server.core.accessor, sessionId, (meta) => ({
      custom: {
        ...meta.custom,
        worktree: {
          ...(meta.custom?.['worktree'] as object | undefined),
          ...worktree,
          setup: { ...setup, status: 'running', ended_at: undefined },
        },
      },
    }));
  }

  async function stored(sessionId: string): Promise<StoredSessionWorktree | undefined> {
    return storedSessionWorktree(
      (await patchSessionMetadata(server.core.accessor, sessionId, () => undefined))?.custom,
    );
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
      (entries) => entries.filter((entry) => /^[^/\\]+[/\\]\d{4}-[0-9a-f]{4}(-\d+)?$/.test(entry)),
      () => [],
    );
  }

  async function expectNothingLeft(root: string, before: readonly string[]): Promise<void> {
    expect(git(root, 'worktree', 'list', '--porcelain').match(/^worktree /gm)).toHaveLength(1);
    expect(git(root, 'branch', '--list', 'kimi/*')).toBe('');
    expect(await worktreeDirectories()).toEqual(before);
  }

  return {
    get server() {
      return server;
    },
    get home() {
      return home;
    },
    get scratch() {
      return scratch;
    },
    request,
    post,
    get,
    createRepo,
    addRemote,
    commitOnRemote,
    createWorkspace,
    project,
    createWorktreeSession,
    settled,
    settledWorktree,
    untilStep,
    duringWorktreeSwitch,
    branchOf,
    forceRunning,
    stored,
    sessionEvents,
    mainAgent,
    worktreeDirectories,
    expectNothingLeft,
  };
}

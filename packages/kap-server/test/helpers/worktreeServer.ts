import { mkdtemp, readdir, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  IAgentLifecycleService,
  MAIN_AGENT_ID,
  getLiveSessionById,
  patchSessionMetadata,
} from '@moonshot-ai/agent-core-v2';
import { afterAll, afterEach, beforeAll, expect } from 'vitest';
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

export function useWorktreeServer(name: string) {
  let server: RunningServer;
  let home: string;
  let scratch: string;
  let base: string;
  let template: RepoTemplate;
  const sockets: WebSocket[] = [];

  beforeAll(async () => {
    home = await realpath(await mkdtemp(join(tmpdir(), `kimi-server-v2-${name}-home-`)));
    scratch = await realpath(await mkdtemp(join(tmpdir(), `kimi-server-v2-${name}-`)));
    await writeFile(join(home, 'config.toml'), STUB_CONFIG, 'utf-8');
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
    for (let attempt = 0; attempt < 400; attempt++) {
      const session = await get<Session>(`/sessions/${id}`);
      if (session.data.worktree?.setup.status !== 'running') return session.data;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    throw new Error(`worktree setup of ${id} is still running`);
  }

  async function settledWorktree(workspaceId: string, worktree?: Record<string, unknown>): Promise<Session> {
    return settled((await createWorktreeSession(workspaceId, worktree)).id);
  }

  async function untilStep(id: string, kind: string, state: string): Promise<void> {
    for (let attempt = 0; attempt < 400; attempt++) {
      const session = await get<Session>(`/sessions/${id}`);
      const step = session.data.worktree?.setup.steps.find((candidate) => candidate.kind === kind);
      if (step?.state === state) return;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    throw new Error(`step ${kind} of ${id} never became ${state}`);
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
      (entries) => entries.filter((entry) => /^[^/]+\/\d{4}-[0-9a-f]{4}(-\d+)?$/.test(entry)),
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
    branchOf,
    forceRunning,
    stored,
    sessionEvents,
    mainAgent,
    worktreeDirectories,
    expectNothingLeft,
  };
}

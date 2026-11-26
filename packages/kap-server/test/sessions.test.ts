import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdir, mkdtemp, readdir, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { setTimeout as slowDisk } from 'node:timers/promises';
import { inflateRawSync } from 'node:zlib';
import { ISessionMediaStore } from '@moonshot-ai/agent-core-v2/agent/media/sessionMediaStore';
import { mcpResultToExecutableOutput } from '@moonshot-ai/agent-core-v2/agent/mcp/output';
import { renderToolResultForModel } from '@moonshot-ai/agent-core-v2/agent/contextMemory/toolResultRender';
import { IReadTool, ReadInputSchema, type ReadInput } from '@moonshot-ai/agent-core-v2/agent/tools/os/read/read';

import { bashPathOf, createGitWorktree } from '@moonshot-ai/testkit/fixtures';
import type { KapHarness } from '@moonshot-ai/testkit/kap';
import { startKimiServices } from '@moonshot-ai/testkit/services';
import {
  agent,
  bash,
  fakeModelConfig,
  held,
  reply,
  say,
  startFakeModel,
  type FakeModel,
  type Lane,
  type RequestFacts,
} from '@moonshot-ai/testkit/model';
import { kapFixtures, type KapFixtures } from '@moonshot-ai/testkit/vitest';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, onTestFinished, test as base, vi } from 'vitest';

import {
  Error2,
  ErrorCodes,
  interactions,
  IBootstrapService,
  IOAuthService,
  type Event2,
  type IOAuthService as IOAuthServiceType,
  IAgentLoopService,
  IAgentFullCompactionService,
  IAgentGoalService,
  IAgentConversationUndoService,
  IAgentCronService,
  IAgentLifecycleService,
  IAgentEnvironmentBindingService,
  IAgentEnvironmentService,
  IEventBus,
  IEventDispatcher,
  IEventService,
  IEnvironmentService,
  IConfigService,
  IFileSystemStorageService,
  IModelCatalog,
  IModelService,
  ISessionActivityView,
  ISessionIndexMirror,
  ISessionManager,
  ISessionMcpHandle,
  ISessionMetadata,
  ISessionPromptPredictionService,
  ISessionTitleService,
  ISessionWorkdir,
  IWireService,
  IProjectInstanceManager,
  IProjectService,
  MAIN_AGENT_ID,
  closeSessionById,
  getLiveSessionById,
  resumeSessionById,
  sessionDirOf,
  type ContextMessage,
  type ScopeSeed,
} from '@moonshot-ai/agent-core-v2';
import { ISessionLockService } from '@moonshot-ai/agent-core-v2/persistence/interface/sessionLock';
import { IHostProcessService, type IHostProcess } from '@moonshot-ai/agent-core-v2/os/interface/hostProcess';
import { FakeEnvironment } from '@moonshot-ai/agent-core-v2/environment/fakeEnvironment';
import { HostFileSystem } from '@moonshot-ai/agent-core-v2/os/backends/node-local/hostFsService';
import { HostProcessService } from '@moonshot-ai/agent-core-v2/os/backends/node-local/hostProcessService';
import { TurnEnded, TurnPrompt, TurnSteer } from '@moonshot-ai/agent-core-v2/agent/loop/turnOps';
import { ContextAppendMessage } from '@moonshot-ai/agent-core-v2/agent/contextMemory/contextEvents';
import type { PromptOrigin } from '@moonshot-ai/agent-core-v2/agent/contextMemory/types';
import { historyEntryFromContext } from '@moonshot-ai/agent-core-v2/agent/loop/history';
import type { ConversationItem, ConversationTurnsPage } from '../src/protocol/conversation';
import { TurnStarted } from '@moonshot-ai/agent-core-v2/agent/loop/turnEvents';
import { EnvironmentSetBinding } from '@moonshot-ai/agent-core-v2/agent/environmentBinding/environmentBindingOps';
import { sessionWarningsResponseSchema } from '@moonshot-ai/agent-core-v2/app/sessionLegacy/sessionProtocol';
import { encodeWorkDirKey } from '@moonshot-ai/agent-core-v2/_base/utils/workdir-slug';
import { ConversationFeed } from '../src/services/conversation/conversationFeed';

import { type RunningServer, startServer } from '../src/start';
import { TEST_HOST_IDENTITY } from './helpers/hostIdentity';
import { authHeaders } from './helpers/auth';
import { ensureMainAgent } from '../src/transport/mainAgent';
import { readAgentState, readContextState, readGoalState } from '../src/transport/ws/v1/agentState';

function historyEntries(messages: readonly ContextMessage[]) {
  return messages.map(historyEntryFromContext);
}

interface Envelope<T> {
  code: number;
  msg: string;
  data: T;
  request_id: string;
  details?: { path: string; message: string }[];
  stack?: string;
}

interface SessionWire {
  id: string;
  workspace_id: string;
  workspace_root?: string;
  cwd: string;
  environment_id: string;
  environment_cwd?: string;
  title: string;
  created_at: string;
  updated_at: string;
  activity: 'idle' | 'turn' | 'background';
  pending_interaction: 'none' | 'approval' | 'question';
  last_turn_outcome?: 'completed' | 'interrupted' | 'failed';
  archived?: boolean;
  metadata: Record<string, unknown>;
}

interface ProfileWire {
  session: SessionWire;
  agent: { model?: string };
}

interface PageWire {
  items: SessionWire[];
  has_more: boolean;
}

function goalContinuationStarts(events: readonly Event2<any>[]): readonly Event2<any>[] {
  return events.filter((event) => {
    if (event.type !== 'turn.started') return false;
    const { origin } = event as TurnStarted;
    return origin.kind === 'system_trigger' && origin.name === 'goal_continuation';
  });
}

function git(cwd: string, ...args: string[]): void {
  execFileSync('git', args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] });
}

describe('server-v2 /api/v1/sessions', () => {
  let server: RunningServer | undefined;
  let baselineServer: RunningServer | undefined;
  let home: string | undefined;
  let base: string;

  beforeAll(async () => {
    home = await mkdtemp(join(tmpdir(), 'kimi-server-v2-sessions-'));
    server = await startServer({
      hostIdentity: TEST_HOST_IDENTITY,
      host: '127.0.0.1',
      port: 0,
      homeDir: home,
      logLevel: 'silent',
      debugEndpoints: true,
    });
    baselineServer = server;
    base = `http://127.0.0.1:${server.port}`;
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    if (server !== baselineServer) {
      await restartWithFreshHome();
      baselineServer = server;
    }
  });

  afterAll(async () => {
    if (server !== undefined) {
      await server.close();
      server = undefined;
    }
    if (home !== undefined) {
      await new Promise((resolve) => setTimeout(resolve, 25));
      await rm(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 } as never);
      home = undefined;
    }
  });

  async function restartWithFreshHome(): Promise<void> {
    if (server !== undefined) {
      await server.close();
      server = undefined;
    }
    if (home !== undefined) {
      await new Promise((resolve) => setTimeout(resolve, 25));
      await rm(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 } as never);
    }
    home = await mkdtemp(join(tmpdir(), 'kimi-server-v2-sessions-'));
    server = await startServer({
      hostIdentity: TEST_HOST_IDENTITY,
      host: '127.0.0.1',
      port: 0,
      homeDir: home,
      logLevel: 'silent',
      debugEndpoints: true,
    });
    base = `http://127.0.0.1:${server.port}`;
  }

  async function restartWithModels(): Promise<void> {
    await server?.close();
    server = undefined;
    const dir = home as string;
    await writeFile(
      join(dir, 'config.toml'),
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
        'support_efforts = ["low", "high"]',
        'default_effort = "low"',
        '',
        '[models.other]',
        'provider = "stub"',
        'model = "other"',
        'max_context_size = 1000',
        'support_efforts = ["low", "high"]',
        'default_effort = "low"',
        '',
      ].join('\n'),
      'utf-8',
    );
    await mkdir(join(dir, 'agents'), { recursive: true });
    await writeFile(
      join(dir, 'agents', 'route-reviewer.md'),
      [
        '---',
        'name: route-reviewer',
        'description: reviewer defined by a user-level agent file',
        '---',
        '',
        'You are a route-test reviewer.',
        '',
      ].join('\n'),
      'utf-8',
    );
    server = await startServer({
      hostIdentity: TEST_HOST_IDENTITY,
      host: '127.0.0.1',
      port: 0,
      homeDir: home,
      logLevel: 'silent',
      debugEndpoints: true,
    });
    base = `http://127.0.0.1:${server.port}`;
  }

  async function postJson<T>(
    path: string,
    body?: unknown,
  ): Promise<{ status: number; body: Envelope<T> }> {
    const hasBody = body !== undefined;
    const res = await fetch(`${base}${path}`, {
      method: 'POST',
      headers: authHeaders(
        server as RunningServer,
        hasBody ? { 'content-type': 'application/json' } : {},
      ),
      body: hasBody ? JSON.stringify(body) : undefined,
    } as never);
    return { status: res.status, body: (await res.json()) as Envelope<T> };
  }

  async function getJson<T>(path: string): Promise<{ status: number; body: Envelope<T> }> {
    const res = await fetch(`${base}${path}`, {
      headers: authHeaders(server as RunningServer),
    } as never);
    return { status: res.status, body: (await res.json()) as Envelope<T> };
  }

  async function patchJson<T>(
    path: string,
    body: unknown,
  ): Promise<{ status: number; body: Envelope<T> }> {
    const res = await fetch(`${base}${path}`, {
      method: 'PATCH',
      headers: authHeaders(server as RunningServer, { 'content-type': 'application/json' }),
      body: JSON.stringify(body),
    } as never);
    return { status: res.status, body: (await res.json()) as Envelope<T> };
  }

  async function deleteJson<T>(path: string): Promise<{ status: number; body: Envelope<T> }> {
    const res = await fetch(`${base}${path}`, {
      method: 'DELETE',
      headers: authHeaders(server as RunningServer),
    } as never);
    return { status: res.status, body: (await res.json()) as Envelope<T> };
  }

  it('downloads a ZIP with the supplied Web log and cleans up its temporary directory', async () => {
    const created = await postJson<SessionWire>('/api/v1/sessions', {
      metadata: { cwd: home as string },
    });
    const id = created.body.data.id;
    const webLog = [
      JSON.stringify({ event: 'websocket.connected', time: 1 }),
      JSON.stringify({ event: 'prompt.submitted', time: 2 }),
    ].join('\n');

    const res = await fetch(`${base}/api/v1/sessions/${id}/export`, {
      method: 'POST',
      headers: authHeaders(server as RunningServer, {
        'content-type': 'application/json',
        connection: 'close',
      }),
      body: JSON.stringify({ web_log: webLog }),
    } as never);
    const archive = Buffer.from(await res.arrayBuffer());

    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('application/zip');
    expect(res.headers.get('content-disposition')).toBe(
      `attachment; filename="kimi-session-${id}.zip"`,
    );
    expect(res.headers.get('content-length')).toBe(String(archive.length));
    expect(res.headers.get('cache-control')).toBe('no-store');

    const entries = readZipEntries(archive);
    const manifest = JSON.parse(entries.get('manifest.json')?.toString('utf8') ?? 'null') as {
      sessionId: string;
      kimiCodeVersion: string;
      desktopVersion?: string;
      webLogPath?: string;
    };
    expect(entries.get('logs/kimi-web.jsonl')?.toString('utf8')).toBe(webLog);
    expect(manifest).toMatchObject({
      sessionId: id,
      kimiCodeVersion: TEST_HOST_IDENTITY.version,
      webLogPath: 'logs/kimi-web.jsonl',
    });
    expect(manifest.desktopVersion).toBeUndefined();
    await expect.poll(() => listExportTempDirs(id)).toEqual([]);
  });

  it('returns the JSON session-not-found envelope instead of a ZIP', async () => {
    const id = 'sess_missing_export';
    const { status, body } = await postJson<null>(`/api/v1/sessions/${id}/export`, {});

    expect(status).toBe(200);
    expect(body.code).toBe(40401);
    await expect.poll(() => listExportTempDirs(id)).toEqual([]);
  });

  it('cleans up the temporary archive when the client cancels the download', async () => {
    const created = await postJson<SessionWire>('/api/v1/sessions', {
      metadata: { cwd: home as string },
    });
    const id = created.body.data.id;
    const sessionDir = sessionDirOf(
      (server as RunningServer).core.accessor.get(IBootstrapService).homeDir,
      `sessions/${created.body.data.workspace_id}`,
      id,
    );
    await writeFile(join(sessionDir, 'cancel-test.bin'), randomBytes(8 * 1024 * 1024));

    const res = await fetch(`${base}/api/v1/sessions/${id}/export`, {
      method: 'POST',
      headers: authHeaders(server as RunningServer, {
        'content-type': 'application/json',
        connection: 'close',
      }),
      body: '{}',
    } as never);
    const reader = res.body?.getReader();
    expect(reader).toBeDefined();
    const first = await reader?.read();
    expect(first?.done).toBe(false);
    await reader?.cancel();

    await expect.poll(() => listExportTempDirs(id)).toEqual([]);
  });

  it('rejects a Web log larger than 256 KiB in UTF-8', async () => {
    const created = await postJson<SessionWire>('/api/v1/sessions', {
      metadata: { cwd: home as string },
    });
    const { status, body } = await postJson<null>(
      `/api/v1/sessions/${created.body.data.id}/export`,
      { web_log: '你'.repeat(87_382) },
    );

    expect(status).toBe(200);
    expect(body.code).toBe(40001);
    expect(body.details?.[0]?.path).toBe('web_log');
  });

  it('bundles the on-disk desktop app log when the desktop flag is set', async () => {
    const created = await postJson<SessionWire>('/api/v1/sessions', {
      metadata: { cwd: home as string },
    });
    const id = created.body.data.id;
    await mkdir(join(home as string, 'logs'), { recursive: true });
    await writeFile(
      join(home as string, 'logs', 'kimi-code-desktop.log'),
      '2026-07-27T00:00:00.000Z INFO  [renderer] hello\n',
      'utf-8',
    );

    const res = await fetch(`${base}/api/v1/sessions/${id}/export`, {
      method: 'POST',
      headers: authHeaders(server as RunningServer, {
        'content-type': 'application/json',
        connection: 'close',
      }),
      body: JSON.stringify({ desktop: true }),
    } as never);
    const archive = Buffer.from(await res.arrayBuffer());

    expect(res.status).toBe(200);
    const entries = readZipEntries(archive);
    const manifest = JSON.parse(entries.get('manifest.json')?.toString('utf8') ?? 'null') as {
      kimiCodeVersion: string;
      desktopLogPath?: string;
      desktopVersion?: string;
    };
    expect(entries.get('logs/kimi-desktop.log')?.toString('utf8')).toBe(
      '2026-07-27T00:00:00.000Z INFO  [renderer] hello\n',
    );
    expect(manifest.desktopLogPath).toBe('logs/kimi-desktop.log');
    expect(manifest.kimiCodeVersion).toBe(TEST_HOST_IDENTITY.version);
    expect(manifest.desktopVersion).toBe(TEST_HOST_IDENTITY.version);
  });

  async function createStoppedGoalRig(status: 'paused' | 'blocked') {
    const cwd = home as string;
    const created = await postJson<SessionWire>('/api/v1/sessions', { metadata: { cwd } });
    const id = created.body.data.id;
    await postJson<SessionWire>(`/api/v1/sessions/${id}/profile`, {
      agent_config: { goal_objective: 'finish the migration' },
    });
    const session = getLiveSessionById((server as RunningServer).core.accessor, id);
    if (session === undefined) throw new Error('expected a live session');
    const agent = session.accessor.get(IAgentLifecycleService).handleOf(MAIN_AGENT_ID);
    if (agent === undefined) throw new Error('expected a live main agent');

    const eventBus = agent.accessor.get(IEventBus);
    const events: Event2<any>[] = [];
    const subscription = eventBus.subscribe((event) => events.push(event));

    const goal = agent.accessor.get(IAgentGoalService);
    const snapshot =
      status === 'blocked'
        ? await goal.markBlocked({ reason: 'need credentials' })
        : await goal.pauseGoal({});
    if (snapshot === null || snapshot.status !== status) {
      throw new Error(`expected a ${status} goal`);
    }

    return {
      id,
      eventBus,
      events,
      cancel: async () => {
        subscription.dispose();
        await postJson<SessionWire>(`/api/v1/sessions/${id}/profile`, {
          agent_config: { goal_control: 'cancel' },
        });
      },
    };
  }

  async function createBlockedGoalRig() {
    return createStoppedGoalRig('blocked');
  }

  it('creates a session from metadata.cwd', async () => {
    const cwd = home as string;
    const { status, body } = await postJson<SessionWire>('/api/v1/sessions', {
      title: 'hello',
      metadata: { cwd },
    });
    expect(status).toBe(200);
    expect(body.code).toBe(0);
    expect(typeof body.data.id).toBe('string');
    expect(typeof body.data.workspace_id).toBe('string');
    expect(body.data.title).toBe('hello');
    expect(body.data.cwd).toBe(cwd);
    expect(body.data.workspace_root).toBe(cwd);
    expect(body.data.environment_id).toBe('local');
    expect(body.data).not.toHaveProperty('environment_cwd');
    expect(body.data.activity).toBe('idle');
    expect(body.data.pending_interaction).toBe('none');
    expect(body.data).not.toHaveProperty('agent_config');
    expect(body.data).not.toHaveProperty('permission_rules');
    expect(body.data).not.toHaveProperty('message_count');
    expect(body.data).not.toHaveProperty('usage');
    expect(body.data).not.toHaveProperty('last_seq');
    expect(Number.isNaN(Date.parse(body.data.created_at))).toBe(false);
  });

  it('creates a session from workspace_root', async () => {
    const cwd = home as string;
    const legacy = await postJson<SessionWire>('/api/v1/sessions', { metadata: { cwd } });
    const { body } = await postJson<SessionWire>('/api/v1/sessions', { workspace_root: cwd });
    expect(body.code).toBe(0);
    expect(body.data).toMatchObject({
      workspace_id: legacy.body.data.workspace_id,
      workspace_root: cwd,
      cwd,
      environment_id: 'local',
    });
    expect(body.data).not.toHaveProperty('environment_cwd');
  });

  it.each([
    [
      'cwd',
      { workspace_root: '/projects/a', cwd: '/projects/b' },
      'cwd (/projects/b) must equal workspace_root (/projects/a)',
    ],
    [
      'metadata.cwd',
      { workspace_root: '/projects/a', metadata: { cwd: '/projects/b' } },
      'metadata.cwd (/projects/b) must equal workspace_root (/projects/a)',
    ],
    [
      'cwd',
      { cwd: '/projects/b', metadata: { cwd: '/projects/a' } },
      'cwd (/projects/b) must equal metadata.cwd (/projects/a)',
    ],
  ])('rejects create when %s disagrees with the other workspace root field (40001)', async (path, request, message) => {
    const { body } = await postJson<null>('/api/v1/sessions', request);
    expect(body.code).toBe(40001);
    expect(body.details?.[0]).toEqual({ path, message });
  });

  it('reports the environment_cwd of a local session in the create response', async () => {
    const cwd = home as string;
    const nested = join(cwd, 'nested');
    await mkdir(nested, { recursive: true });
    const created = await postJson<SessionWire>('/api/v1/sessions', {
      metadata: { cwd },
      environment_id: 'local',
      environment_cwd: nested,
    });
    expect(created.body.code).toBe(0);

    const got = await getJson<SessionWire>(`/api/v1/sessions/${created.body.data.id}`);
    expect(got.body.data.cwd).toBe(nested);
    expect(created.body.data.cwd).toBe(nested);
  });

  it('reports the requested cwd of a remote session in the create response', async () => {
    const cwd = home as string;
    const remote = await realpath(await mkdtemp(join(tmpdir(), 'kimi-server-v2-sessions-remote-')));
    const environment = Object.assign(
      new FakeEnvironment(
        { environmentId: 'remote-create', generation: 'remote-create-generation' },
        { capabilities: ['fs', 'process'] },
      ),
      { fs: new HostFileSystem(), process: new HostProcessService() },
    );
    const registration = (server as RunningServer).core.accessor.get(IEnvironmentService).register(environment);
    try {
      const local = await postJson<SessionWire>('/api/v1/sessions', { metadata: { cwd } });
      const created = await postJson<SessionWire>('/api/v1/sessions', {
        metadata: { cwd: `${cwd}/` },
        environment_id: 'remote-create',
        environment_cwd: remote,
      });
      expect(created.body.code).toBe(0);
      expect(created.body.data.workspace_id).toBe(local.body.data.workspace_id);

      const got = await getJson<SessionWire>(`/api/v1/sessions/${created.body.data.id}`);
      expect(created.body.data.cwd).toBe(got.body.data.cwd);
      const location = {
        workspace_root: cwd,
        cwd: `${cwd}/`,
        environment_id: 'remote-create',
        environment_cwd: remote,
      };
      expect(created.body.data).toMatchObject(location);
      expect(got.body.data).toMatchObject(location);
    } finally {
      await registration.remove();
      await rm(remote, { recursive: true, force: true });
    }
  });

  it('rejects create without workspace_root or workspace_id (40001)', async () => {
    const { body } = await postJson<null>('/api/v1/sessions', { title: 'no root' });
    expect(body.code).toBe(40001);
    expect(body.details?.[0]).toEqual({
      path: 'workspace_root',
      message: 'either workspace_id or workspace_root is required',
    });
  });

  it('rejects create with unknown workspace_id (40410)', async () => {
    const { body } = await postJson<null>('/api/v1/sessions', {
      workspace_id: 'wd_missing_000000000000',
      metadata: { cwd: '/x' },
    });
    expect(body.code).toBe(40410);
  });

  it('rejects a session for a missing metadata.cwd for a local binding', async () => {
    const missing = join(home as string, 'never-created');
    const created = await postJson<null>('/api/v1/sessions', { metadata: { cwd: missing } });
    expect(created.body.code).toBe(40409);

    const sessions = await getJson<PageWire>('/api/v1/sessions');
    expect(sessions.body.data.items.some((s) => s.cwd === missing)).toBe(false);
  });

  it('rejects create when metadata.cwd is not a directory (40409)', async () => {
    const file = join(home as string, 'a-file.txt');
    await writeFile(file, 'hi', 'utf8');
    const { body } = await postJson<null>('/api/v1/sessions', { metadata: { cwd: file } });
    expect(body.code).toBe(40409);
  });

  it('rejects create when an explicit local environment_cwd does not exist (40001)', async () => {
    const missing = join(home as string, 'missing-environment-cwd');
    const { body } = await postJson<null>('/api/v1/sessions', {
      cwd: home as string,
      environment_id: 'local',
      environment_cwd: missing,
    });
    expect(body.code).toBe(40001);
    expect(body.msg).toContain(`cwd ${missing} is not readable on environment local`);
  });

  it.each(['missing', 'not-a-directory'] as const)(
    'rejects create via workspace_id when the registered root is %s (40409)',
    async (state) => {
      const cwd = await mkdtemp(join(tmpdir(), 'kimi-server-v2-workspace-root-'));
      let workspaceId: string | undefined;
      try {
        const created = await postJson<{ id: string }>('/api/v1/workspaces', { root: cwd });
        expect(created.body.code).toBe(0);
        workspaceId = created.body.data.id;
        await rm(cwd, { recursive: true, force: true });
        if (state === 'not-a-directory') await writeFile(cwd, 'not a directory', 'utf8');

        const { body } = await postJson<null>('/api/v1/sessions', {
          workspace_id: workspaceId,
        });
        expect(body.code).toBe(40409);
        const sessions = await getJson<PageWire>(
          `/api/v1/sessions?workspace_id=${encodeURIComponent(workspaceId)}`,
        );
        expect(sessions.body.data.items).toEqual([]);
      } finally {
        if (workspaceId !== undefined) {
          await deleteJson<{ deleted: boolean }>(`/api/v1/workspaces/${workspaceId}`);
        }
        await rm(cwd, { recursive: true, force: true });
      }
    },
  );

  it('creates a second session via workspace_id resolved from a prior cwd create', async () => {
    const cwd = home as string;
    const first = await postJson<SessionWire>('/api/v1/sessions', { metadata: { cwd } });
    expect(first.body.code).toBe(0);

    const second = await postJson<SessionWire>('/api/v1/sessions', {
      workspace_id: first.body.data.workspace_id,
      metadata: { cwd },
    });
    expect(second.body.code).toBe(0);
    expect(second.body.data.workspace_id).toBe(first.body.data.workspace_id);
    expect(second.body.data.id).not.toBe(first.body.data.id);
  });

  it('shares one workspace until the last session closes', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'kimi-server-v2-shared-workspace-'));
    let firstId: string | undefined;
    let secondId: string | undefined;
    try {
      const first = await postJson<SessionWire>('/api/v1/sessions', { metadata: { cwd } });
      expect(first.body.code).toBe(0);
      firstId = first.body.data.id;

      const second = await postJson<SessionWire>('/api/v1/sessions', {
        workspace_id: first.body.data.workspace_id,
        metadata: { cwd },
      });
      expect(second.body.code).toBe(0);
      secondId = second.body.data.id;
      expect(second.body.data.workspace_id).toBe(first.body.data.workspace_id);
      expect(second.body.data.id).not.toBe(first.body.data.id);
      const manager = (server as RunningServer).core.accessor.get(IProjectInstanceManager);
      const workspace = manager.get(first.body.data.workspace_id);
      expect(workspace).toBeDefined();
      await closeSessionById((server as RunningServer).core.accessor, firstId);
      expect(manager.get(first.body.data.workspace_id)).toBe(workspace);
      await closeSessionById((server as RunningServer).core.accessor, secondId);
      expect(manager.get(first.body.data.workspace_id)).toBeUndefined();
    } finally {
      if (firstId !== undefined) await closeSessionById((server as RunningServer).core.accessor, firstId);
      if (secondId !== undefined) await closeSessionById((server as RunningServer).core.accessor, secondId);
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('rejects create when cwd mismatches workspace root (40001)', async () => {
    const cwd = home as string;
    const first = await postJson<SessionWire>('/api/v1/sessions', { metadata: { cwd } });
    const { body } = await postJson<null>('/api/v1/sessions', {
      workspace_id: first.body.data.workspace_id,
      metadata: { cwd: '/definitely/elsewhere' },
    });
    expect(body.code).toBe(40001);
    expect(body.details?.[0]?.path).toBe('metadata.cwd');
  });

  async function repositoryWithWorktree(): Promise<{ readonly lab: string; readonly main: string; readonly worktree: string }> {
    const lab = await realpath(await mkdtemp(join(tmpdir(), 'kimi-server-v2-sessions-repo-')));
    const { main, worktree } = await createGitWorktree(
      { main: join(lab, 'app'), worktree: join(lab, 'app-fix') },
      { files: { 'src/tracked.txt': 'one\n' } },
    );
    return { lab, main, worktree };
  }

  async function stateOf(session: SessionWire): Promise<Record<string, unknown>> {
    return JSON.parse(
      await readFile(join(home as string, 'sessions', session.workspace_id, session.id, 'state.json'), 'utf8'),
    ) as Record<string, unknown>;
  }

  async function indexWorkDirOf(sessionId: string): Promise<string | undefined> {
    const lines = (await readFile(join(home as string, 'session_index.jsonl'), 'utf8')).trim().split('\n');
    const entry = lines.map((line) => JSON.parse(line) as { sessionId: string; workDir?: string }).find((line) => line.sessionId === sessionId);
    return entry?.workDir;
  }

  async function environmentCwdOf(sessionId: string): Promise<string | undefined> {
    const binding = await getJson<{ environment_id: string; cwd?: string }>(`/api/v1/sessions/${sessionId}/environment`);
    expect(binding.body.data.environment_id).toBe('local');
    return binding.body.data.cwd;
  }

  it('groups a worktree cwd into the repository project and answers with the worktree as the session cwd', async () => {
    const { lab, main, worktree } = await repositoryWithWorktree();
    try {
      const atMain = await postJson<SessionWire>('/api/v1/sessions', { cwd: main });
      const inWorktree = await postJson<SessionWire>('/api/v1/sessions', { cwd: worktree });

      expect(inWorktree.body.code).toBe(0);
      expect(inWorktree.body.data.workspace_id).toBe(atMain.body.data.workspace_id);
      expect(inWorktree.body.data.workspace_id).toBe(encodeWorkDirKey(main));
      expect(inWorktree.body.data.cwd).toBe(worktree);
      expect((await getJson<SessionWire>(`/api/v1/sessions/${inWorktree.body.data.id}`)).body.data.cwd).toBe(worktree);
      expect(await stateOf(inWorktree.body.data)).toMatchObject({ cwd: worktree, environmentCwd: worktree });
      expect(await indexWorkDirOf(inWorktree.body.data.id)).toBe(worktree);
      expect(await environmentCwdOf(inWorktree.body.data.id)).toBe(worktree);
      expect(await stateOf(atMain.body.data)).toMatchObject({ cwd: main });
      expect(await stateOf(atMain.body.data)).not.toHaveProperty('environmentCwd');
      expect(await indexWorkDirOf(atMain.body.data.id)).toBe(main);
      expect(await environmentCwdOf(atMain.body.data.id)).toBeUndefined();
      const listed = await getJson<PageWire>(`/api/v1/sessions?workspace_id=${encodeURIComponent(encodeWorkDirKey(main))}`);
      expect(
        Object.fromEntries(listed.body.data.items.map((item) => [item.id, item.cwd])),
      ).toEqual({ [atMain.body.data.id]: main, [inWorktree.body.data.id]: worktree });
      const workspaces = await getJson<{ items: { id: string; root: string }[] }>('/api/v1/workspaces');
      expect(workspaces.body.data.items.filter((item) => [main, worktree].includes(item.root))).toEqual([
        expect.objectContaining({ id: encodeWorkDirKey(main), root: main }),
      ]);
    } finally {
      await rm(lab, { recursive: true, force: true });
    }
  });

  it('pins a session created with workspace_id at any cwd of the root repository and lets one at the root follow it', async () => {
    const { lab, main, worktree } = await repositoryWithWorktree();
    try {
      const atMain = await postJson<SessionWire>('/api/v1/sessions', { cwd: main });
      const workspaceId = atMain.body.data.workspace_id;
      const subdir = join(main, 'src');

      const rootOnly = await postJson<SessionWire>('/api/v1/sessions', { workspace_id: workspaceId });
      const atRoot = await postJson<SessionWire>('/api/v1/sessions', { workspace_id: workspaceId, metadata: { cwd: main } });
      const inSubdir = await postJson<SessionWire>('/api/v1/sessions', { workspace_id: workspaceId, cwd: subdir });
      const inWorktree = await postJson<SessionWire>('/api/v1/sessions', {
        workspace_id: workspaceId,
        metadata: { cwd: worktree },
      });
      const outside = await postJson<null>('/api/v1/sessions', { workspace_id: workspaceId, cwd: lab });

      for (const created of [rootOnly, atRoot]) {
        expect(created.body.data).toMatchObject({ workspace_id: workspaceId, cwd: main });
        expect(await stateOf(created.body.data)).not.toHaveProperty('environmentCwd');
      }
      expect(inSubdir.body.data).toMatchObject({ workspace_id: workspaceId, cwd: subdir });
      expect(await stateOf(inSubdir.body.data)).toMatchObject({ environmentCwd: subdir });
      expect(inWorktree.body.data).toMatchObject({ workspace_id: workspaceId, cwd: worktree });
      expect(outside.body.code).toBe(40001);
      expect(outside.body.details?.[0]?.path).toBe('cwd');
    } finally {
      await rm(lab, { recursive: true, force: true });
    }
  });

  it('places a session by workspace_root the same way as by cwd and reports the project root beside the directory it runs in', async () => {
    const { lab, main, worktree } = await repositoryWithWorktree();
    try {
      const inWorktree = await postJson<SessionWire>('/api/v1/sessions', { workspace_root: worktree });
      const workspaceId = inWorktree.body.data.workspace_id;
      const subdir = join(main, 'src');
      const inSubdir = await postJson<SessionWire>('/api/v1/sessions', { workspace_id: workspaceId, workspace_root: subdir });
      const outside = await postJson<null>('/api/v1/sessions', { workspace_id: workspaceId, workspace_root: lab });

      expect(workspaceId).toBe(encodeWorkDirKey(main));
      expect(inWorktree.body.data).toMatchObject({ workspace_root: main, cwd: worktree, environment_id: 'local', environment_cwd: worktree });
      expect(inSubdir.body.data).toMatchObject({ workspace_id: workspaceId, workspace_root: main, cwd: subdir, environment_cwd: subdir });
      expect(outside.body.code).toBe(40001);
      expect(outside.body.details?.[0]?.path).toBe('workspace_root');
    } finally {
      await rm(lab, { recursive: true, force: true });
    }
  });

  it('starts a session in the directory of another session from its workspace_id, environment_id and environment_cwd', async () => {
    const { lab, main, worktree } = await repositoryWithWorktree();
    try {
      const atRoot = await postJson<SessionWire>('/api/v1/sessions', { cwd: main });
      const inWorktree = await postJson<SessionWire>('/api/v1/sessions', { cwd: worktree });
      const placementOf = async (id: string) => {
        const { workspace_id, environment_id, environment_cwd } = (await getJson<SessionWire>(`/api/v1/sessions/${id}`)).body.data;
        return { workspace_id, environment_id, environment_cwd };
      };

      const nextToRoot = await postJson<SessionWire>('/api/v1/sessions', await placementOf(atRoot.body.data.id));
      const nextToWorktree = await postJson<SessionWire>('/api/v1/sessions', await placementOf(inWorktree.body.data.id));

      expect(nextToRoot.body.data).toMatchObject({ workspace_root: main, cwd: main });
      expect(nextToRoot.body.data).not.toHaveProperty('environment_cwd');
      expect(nextToWorktree.body.data).toMatchObject({ workspace_root: main, cwd: worktree, environment_cwd: worktree });
    } finally {
      await rm(lab, { recursive: true, force: true });
    }
  });

  it('rejects a workspace cwd that is a symlink inside the repository to an outside checkout (40001)', async () => {
    const lab = await mkdtemp(join(tmpdir(), 'kimi-server-v2-sessions-escape-'));
    try {
      const root = join(lab, 'trusted');
      const outside = join(lab, 'outside');
      const plain = join(lab, 'plain');
      for (const dir of [root, outside, plain]) await mkdir(dir);
      git(root, 'init', '-q');
      git(outside, 'init', '-q');
      await writeFile(join(outside, '.mcp.json'), JSON.stringify({ mcpServers: { outside: { command: 'never-runs' } } }));
      await symlink(outside, join(root, 'link'));
      await symlink(plain, join(root, 'plain-link'));
      const atRoot = await postJson<SessionWire>('/api/v1/sessions', { cwd: root });

      for (const link of ['link', 'plain-link']) {
        const escaped = await postJson<null>('/api/v1/sessions', {
          workspace_id: atRoot.body.data.workspace_id,
          cwd: join(root, link),
        });

        expect(escaped.body.code).toBe(40001);
        expect(escaped.body.details?.[0]?.path).toBe('cwd');
      }
    } finally {
      await rm(lab, { recursive: true, force: true });
    }
  });

  it('accepts a workspace cwd that reaches the project root through a symlinked spelling', async () => {
    const lab = await mkdtemp(join(tmpdir(), 'kimi-server-v2-sessions-alias-'));
    try {
      const root = join(lab, 'real');
      const alias = join(lab, 'alias');
      await mkdir(join(root, 'src'), { recursive: true });
      await symlink(root, alias);
      const atRoot = await postJson<SessionWire>('/api/v1/sessions', { cwd: root });
      const workspaceId = atRoot.body.data.workspace_id;

      const viaAlias = await postJson<SessionWire>('/api/v1/sessions', { workspace_id: workspaceId, cwd: alias });
      const viaAliasSubdir = await postJson<null>('/api/v1/sessions', { workspace_id: workspaceId, cwd: join(alias, 'src') });
      git(root, 'init', '-q');
      const viaRepositorySubdir = await postJson<SessionWire>('/api/v1/sessions', {
        workspace_id: workspaceId,
        cwd: join(alias, 'src'),
      });

      expect(viaAlias.body.data).toMatchObject({ workspace_id: workspaceId, cwd: alias });
      expect(viaAliasSubdir.body.code).toBe(40001);
      expect(viaRepositorySubdir.body.data).toMatchObject({ workspace_id: workspaceId, cwd: join(alias, 'src') });
    } finally {
      await rm(lab, { recursive: true, force: true });
    }
  });

  it('judges a workspace cwd the same way for managed and implicit workspaces and never by additional directories', async () => {
    const { lab, main, worktree } = await repositoryWithWorktree();
    try {
      const lib = join(lab, 'lib');
      const nested = join(main, 'vendor', 'lib');
      for (const dir of [lib, nested]) {
        await mkdir(dir, { recursive: true });
        git(dir, 'init', '-q');
      }
      const implicit = (await postJson<SessionWire>('/api/v1/sessions', { cwd: main })).body.data.workspace_id;
      expect((await patchJson<unknown>(`/api/v1/workspaces/${implicit}`, { additional_dirs: [lib] })).body.code).toBe(0);
      const managed = (await postJson<{ id: string }>('/api/v1/workspaces', { root: main, additional_dirs: [lib] })).body.data.id;
      const subdirectory = (await postJson<{ id: string }>('/api/v1/workspaces', { root: join(main, 'src') })).body.data.id;
      const onWorktree = (await postJson<{ id: string }>('/api/v1/workspaces', { root: worktree })).body.data.id;
      const codeOf = async (workspaceId: string, cwd: string) =>
        (await postJson<SessionWire | null>('/api/v1/sessions', { workspace_id: workspaceId, cwd })).body.code;

      for (const workspaceId of [implicit, managed]) {
        expect(await codeOf(workspaceId, worktree)).toBe(0);
        expect(await codeOf(workspaceId, join(worktree, 'src'))).toBe(0);
        expect(await codeOf(workspaceId, lib)).toBe(40001);
        expect(await codeOf(workspaceId, nested)).toBe(40001);
      }
      expect(await codeOf(onWorktree, main)).toBe(0);
      expect(await codeOf(subdirectory, join(worktree, 'src'))).toBe(0);
      expect(await codeOf(subdirectory, worktree)).toBe(40001);
      expect(await codeOf(subdirectory, main)).toBe(40001);
    } finally {
      await rm(lab, { recursive: true, force: true });
    }
  });

  it('accepts a worktree that keeps an implicit project of its own under the id of the repository project', async () => {
    const { lab, main, worktree } = await repositoryWithWorktree();
    try {
      const ownId = encodeWorkDirKey(worktree);
      const oldSession = join(home as string, 'sessions', ownId, 'session_old');
      await mkdir(oldSession, { recursive: true });
      await writeFile(join(oldSession, 'state.json'), JSON.stringify({ version: 2, createdAt: 1, updatedAt: 1, cwd: worktree }));
      const atMain = await postJson<SessionWire>('/api/v1/sessions', { cwd: main });
      const projectsPath = join(home as string, 'projects.json');
      const projects = JSON.parse(await readFile(projectsPath, 'utf8')) as { projects: Record<string, { root: string; name: string }> };
      projects.projects[ownId] = { ...projects.projects[encodeWorkDirKey(main)]!, root: worktree, name: 'app-fix' };
      await writeFile(projectsPath, JSON.stringify(projects));
      await vi.waitFor(async () => {
        const listed = await getJson<{ items: { id: string }[] }>('/api/v1/workspaces');
        expect(listed.body.data.items.map((item) => item.id)).toContain(ownId);
      });

      const byCwd = await postJson<SessionWire>('/api/v1/sessions', { cwd: worktree });
      const byId = await postJson<SessionWire>('/api/v1/sessions', { workspace_id: atMain.body.data.workspace_id, cwd: worktree });

      expect(byCwd.body.data).toMatchObject({ workspace_id: ownId, cwd: worktree });
      expect(byId.body.data).toMatchObject({ workspace_id: atMain.body.data.workspace_id, cwd: worktree });
    } finally {
      await rm(lab, { recursive: true, force: true });
    }
  });

  it('rejects the former root of a managed workspace outside a repository (40001)', async () => {
    const one = await mkdtemp(join(tmpdir(), 'kimi-server-v2-sessions-former-one-'));
    const two = await mkdtemp(join(tmpdir(), 'kimi-server-v2-sessions-former-two-'));
    try {
      const { id } = (await postJson<{ id: string }>('/api/v1/workspaces', { root: one, additional_dirs: [two] })).body.data;
      expect((await postJson<unknown>(`/api/v1/workspaces/${id}/primary`, { path: two })).body.code).toBe(0);

      const atFormerRoot = await postJson<null>('/api/v1/sessions', { workspace_id: id, metadata: { cwd: one } });
      const atRoot = await postJson<SessionWire>('/api/v1/sessions', { workspace_id: id, metadata: { cwd: two } });

      expect(atFormerRoot.body.code).toBe(40001);
      expect(atFormerRoot.body.details?.[0]?.path).toBe('metadata.cwd');
      expect(atRoot.body.data).toMatchObject({ workspace_id: id, cwd: two });
    } finally {
      await rm(one, { recursive: true, force: true });
      await rm(two, { recursive: true, force: true });
    }
  });

  it('answers a missing or relative workspace cwd without creating a session', async () => {
    const { lab, main, worktree } = await repositoryWithWorktree();
    try {
      const workspaceId = (await postJson<SessionWire>('/api/v1/sessions', { cwd: main })).body.data.workspace_id;
      const codeOf = async (cwd: string) =>
        (await postJson<null>('/api/v1/sessions', { workspace_id: workspaceId, cwd })).body.code;

      expect(await codeOf(join(main, 'missing'))).toBe(40001);
      expect(await codeOf(join(worktree, 'missing'))).toBe(40001);
      expect(await codeOf(join(lab, 'missing'))).toBe(40001);
      expect(await codeOf('src')).toBe(40001);
      expect(await codeOf('.')).toBe(40001);
      expect(await codeOf('~')).toBe(40001);
      await rm(main, { recursive: true, force: true });
      expect(await codeOf(main)).toBe(40409);
      const listed = await getJson<PageWire>(`/api/v1/sessions?workspace_id=${encodeURIComponent(workspaceId)}`);
      expect(listed.body.data.items).toHaveLength(1);
    } finally {
      await rm(lab, { recursive: true, force: true });
    }
  });

  it('reads the project MCP of a session started in a worktree subdirectory from the root of that worktree', async () => {
    const { lab, main, worktree } = await repositoryWithWorktree();
    try {
      const subdir = join(worktree, 'src');
      for (const [dir, name] of [[main, 'main'], [worktree, 'worktree'], [subdir, 'subdir']] as const) {
        await mkdir(join(dir, '.kimi-code'), { recursive: true });
        for (const [file, layer] of [['.mcp.json', 'shared'], ['.kimi-code/mcp.json', 'local']] as const) {
          await writeFile(
            join(dir, file),
            JSON.stringify({ mcpServers: { [`${name}-${layer}`]: { command: 'never-runs', enabled: false } } }),
          );
        }
      }
      vi.stubEnv('KIMI_CODE_TRUST_WORKSPACE', '1');
      const atMain = await postJson<SessionWire>('/api/v1/sessions', { cwd: main });
      const created = await postJson<SessionWire>('/api/v1/sessions', { cwd: subdir });
      const mcp = getLiveSessionById((server as RunningServer).core.accessor, created.body.data.id)!.accessor.get(ISessionMcpHandle);
      await mcp.ready;

      expect(created.body.data).toMatchObject({ workspace_id: atMain.body.data.workspace_id, cwd: subdir });
      expect(mcp.connectionManager.list().map((entry) => entry.name).toSorted()).toEqual(['worktree-local', 'worktree-shared']);
    } finally {
      vi.unstubAllEnvs();
      await rm(lab, { recursive: true, force: true });
    }
  });

  it('keeps one directory in both a managed and an implicit workspace with a session in each', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'kimi-server-v2-sessions-shared-dir-'));
    try {
      const managed = await postJson<{ id: string }>('/api/v1/workspaces', { root: dir });
      const inManaged = await postJson<SessionWire>('/api/v1/sessions', { workspace_id: managed.body.data.id, cwd: dir });
      const inImplicit = await postJson<SessionWire>('/api/v1/sessions', { cwd: dir });

      expect(inManaged.body.data).toMatchObject({ workspace_id: managed.body.data.id, cwd: dir });
      expect(inImplicit.body.data).toMatchObject({ workspace_id: encodeWorkDirKey(dir), cwd: dir });
      expect(await stateOf(inManaged.body.data)).not.toHaveProperty('environmentCwd');
      expect(await stateOf(inImplicit.body.data)).not.toHaveProperty('environmentCwd');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('starts a session in the directory it was asked for even when its old implicit project moved its primary', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'kimi-server-v2-sessions-moved-primary-'));
    try {
      const moved = join(dir, 'moved');
      await mkdir(moved);
      const first = await postJson<SessionWire>('/api/v1/sessions', { cwd: dir });
      expect(first.body.data.workspace_id).toBe(encodeWorkDirKey(dir));
      const projectsPath = join(home as string, 'projects.json');
      const projects = JSON.parse(await readFile(projectsPath, 'utf8')) as { projects: Record<string, { root: string }> };
      projects.projects[encodeWorkDirKey(dir)]!.root = moved;
      await writeFile(projectsPath, JSON.stringify(projects));
      await vi.waitFor(async () => {
        const listed = await getJson<{ items: { id: string; root: string }[] }>('/api/v1/workspaces');
        expect(listed.body.data.items.find((item) => item.id === encodeWorkDirKey(dir))?.root).toBe(moved);
      });

      const second = await postJson<SessionWire>('/api/v1/sessions', { cwd: dir });

      expect(second.body.data).toMatchObject({ workspace_id: encodeWorkDirKey(dir), cwd: dir });
      expect(await stateOf(second.body.data)).toMatchObject({ environmentCwd: dir });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('forks a worktree session into a session of the same worktree', async () => {
    const { lab, worktree } = await repositoryWithWorktree();
    try {
      const source = await postJson<SessionWire>('/api/v1/sessions', { cwd: worktree });
      const forked = await postJson<SessionWire>(`/api/v1/sessions/${source.body.data.id}:fork`, {});

      expect(forked.body.code).toBe(0);
      expect(forked.body.data).toMatchObject({ workspace_id: source.body.data.workspace_id, cwd: worktree });
      expect(await stateOf(forked.body.data)).toMatchObject({ environmentCwd: worktree });
      expect(await indexWorkDirOf(forked.body.data.id)).toBe(worktree);
      expect((await getJson<SessionWire>(`/api/v1/sessions/${forked.body.data.id}`)).body.data.cwd).toBe(worktree);
    } finally {
      await rm(lab, { recursive: true, force: true });
    }
  });

  it('keeps a live pinned session in its directory while another client renames the project or changes its dirs', async () => {
    const { lab, main, worktree } = await repositoryWithWorktree();
    try {
      const shared = join(lab, 'shared');
      await mkdir(shared);
      const created = await postJson<SessionWire>('/api/v1/sessions', { cwd: worktree });
      const id = created.body.data.id;
      const live = getLiveSessionById((server as RunningServer).core.accessor, id)!;
      const agent = await ensureMainAgent(live);

      const patched = await patchJson<unknown>(`/api/v1/workspaces/${created.body.data.workspace_id}`, {
        name: 'renamed',
        additional_dirs: [shared],
      });

      expect(patched.body.code).toBe(0);
      await vi.waitFor(() => {
        expect(agent.accessor.get(IAgentEnvironmentService).workspaceRoots().additionalDirs).toContain(shared);
      });
      expect(agent.accessor.get(IAgentEnvironmentService).workspaceRoots().workDir).toBe(worktree);
      expect((await getJson<SessionWire>(`/api/v1/sessions/${id}`)).body.data.cwd).toBe(worktree);
      expect((await postJson<{ session: SessionWire }>(`/api/v1/sessions/${id}:wait`, { timeout_ms: 0 })).body.data.session.cwd).toBe(worktree);
      expect(main).not.toBe(worktree);
    } finally {
      await rm(lab, { recursive: true, force: true });
    }
  });

  it('gives the project additional dirs to sessions in the root repository and not to sessions pinned elsewhere', async () => {
    const { lab, main, worktree } = await repositoryWithWorktree();
    try {
      const shared = join(lab, 'shared');
      const other = join(lab, 'other');
      for (const dir of [shared, other]) await mkdir(dir);
      const { id } = (await postJson<{ id: string }>('/api/v1/workspaces', { root: main, additional_dirs: [shared] })).body.data;
      const additionalDirsAt = async (cwd: string) => {
        const created = await postJson<SessionWire>('/api/v1/sessions', {
          workspace_id: id,
          environment_id: 'local',
          environment_cwd: cwd,
        });
        const agent = await ensureMainAgent(getLiveSessionById((server as RunningServer).core.accessor, created.body.data.id)!);
        return agent.accessor.get(IAgentEnvironmentService).workspaceRoots().additionalDirs;
      };

      expect(await additionalDirsAt(worktree)).toEqual([shared]);
      expect(await additionalDirsAt(join(main, 'src'))).toEqual([shared]);
      expect(await additionalDirsAt(other)).toEqual([]);
      expect(await additionalDirsAt(shared)).toEqual([main]);
    } finally {
      await rm(lab, { recursive: true, force: true });
    }
  });

  it('reports a session at the project root at the current primary on get, wait and fork', async () => {
    const first = await mkdtemp(join(tmpdir(), 'kimi-server-v2-sessions-primary-a-'));
    const second = await mkdtemp(join(tmpdir(), 'kimi-server-v2-sessions-primary-b-'));
    try {
      const workspace = await postJson<{ id: string }>('/api/v1/workspaces', { root: first, additional_dirs: [second] });
      const created = await postJson<SessionWire>('/api/v1/sessions', { workspace_id: workspace.body.data.id });
      const id = created.body.data.id;

      const promoted = await postJson<unknown>(`/api/v1/workspaces/${workspace.body.data.id}/primary`, { path: second });
      expect(promoted.body.code).toBe(0);

      expect(await stateOf(created.body.data)).not.toHaveProperty('environmentCwd');
      expect((await getJson<SessionWire>(`/api/v1/sessions/${id}`)).body.data.cwd).toBe(second);
      expect((await postJson<{ session: SessionWire }>(`/api/v1/sessions/${id}:wait`, { timeout_ms: 0 })).body.data.session.cwd).toBe(second);
      const forked = await postJson<SessionWire>(`/api/v1/sessions/${id}:fork`, {});
      expect(forked.body.data.cwd).toBe(second);
      expect(await stateOf(forked.body.data)).not.toHaveProperty('environmentCwd');
    } finally {
      await rm(first, { recursive: true, force: true });
      await rm(second, { recursive: true, force: true });
    }
  });

  it('keeps a session started through a symlink to the main checkout at the spelling it was started from', async () => {
    const { lab, main } = await repositoryWithWorktree();
    try {
      const link = join(lab, 'link-app');
      await symlink(main, link);
      const workspaceId = (await postJson<SessionWire>('/api/v1/sessions', { cwd: main })).body.data.workspace_id;

      for (const body of [{ cwd: link }, { workspace_id: workspaceId, cwd: link }]) {
        const created = await postJson<SessionWire>('/api/v1/sessions', body);

        expect(created.body.data).toMatchObject({ workspace_id: workspaceId, cwd: link });
        expect(await stateOf(created.body.data)).toMatchObject({ environmentCwd: link });
        expect(await indexWorkDirOf(created.body.data.id)).toBe(link);
      }
    } finally {
      await rm(lab, { recursive: true, force: true });
    }
  });

  it('moves only the sessions at the root of a managed project when its primary changes', async () => {
    const { lab, main, worktree } = await repositoryWithWorktree();
    try {
      const moved = join(lab, 'moved');
      await mkdir(moved);
      const workspace = await postJson<{ id: string }>('/api/v1/workspaces', { root: main, additional_dirs: [moved] });
      const workspaceId = workspace.body.data.id;
      const create = async (cwd: string) =>
        (await postJson<SessionWire>('/api/v1/sessions', { workspace_id: workspaceId, metadata: { cwd } })).body.data;
      const atRoot = await create(main);
      const inWorktree = await create(worktree);
      const inSubdir = await create(join(main, 'src'));
      const listedCwds = async () =>
        Object.fromEntries(
          (await getJson<PageWire>(`/api/v1/sessions?workspace_id=${encodeURIComponent(workspaceId)}`)).body.data.items.map(
            (item) => [item.id, item.cwd],
          ),
        );
      expect(await listedCwds()).toEqual({
        [atRoot.id]: main,
        [inWorktree.id]: worktree,
        [inSubdir.id]: join(main, 'src'),
      });

      expect((await postJson<unknown>(`/api/v1/workspaces/${workspaceId}/primary`, { path: moved })).body.code).toBe(0);

      const expected = { [atRoot.id]: moved, [inWorktree.id]: worktree, [inSubdir.id]: join(main, 'src') };
      await vi.waitFor(async () => {
        expect(await listedCwds()).toEqual(expected);
      });
      const core = (server as RunningServer).core.accessor;
      for (const [id, cwd] of Object.entries(expected)) {
        expect((await getJson<SessionWire>(`/api/v1/sessions/${id}`)).body.data.cwd).toBe(cwd);
        const agent = await ensureMainAgent(getLiveSessionById(core, id)!);
        await vi.waitFor(() => {
          expect(agent.accessor.get(IAgentEnvironmentService).workspaceRoots().workDir).toBe(cwd);
        });
        await closeSessionById(core, id);
        const resumed = await ensureMainAgent((await resumeSessionById(core, id))!);
        expect(resumed.accessor.get(IAgentEnvironmentService).workspaceRoots().workDir).toBe(cwd);
      }
    } finally {
      await rm(lab, { recursive: true, force: true });
    }
  });

  it('lists created sessions', async () => {
    const cwd = home as string;
    const created = await postJson<SessionWire>('/api/v1/sessions', { metadata: { cwd } });
    const { body } = await getJson<PageWire>('/api/v1/sessions');
    expect(body.code).toBe(0);
    expect(body.data.items.some((s) => s.id === created.body.data.id)).toBe(true);
    expect(typeof body.data.has_more).toBe('boolean');
  });

  it('returns the main agent model from the session profile', async () => {
    await restartWithModels();
    const cwd = home as string;

    const created = await postJson<SessionWire>('/api/v1/sessions', { metadata: { cwd } });
    const id = created.body.data.id;
    expect(created.body.data.activity).toBe('idle');

    const updated = await postJson<ProfileWire>(`/api/v1/sessions/${id}/profile`, {
      agent_config: { model: 'other' },
    });
    expect(updated.body.code).toBe(0);
    expect(updated.body.data.agent.model).toBe('other');
    expect(updated.body.data.session).not.toHaveProperty('agent_config');

    const listed = await getJson<PageWire>('/api/v1/sessions');
    const item = listed.body.data.items.find((s) => s.id === id);
    expect(item).not.toHaveProperty('agent_config');

    const got = await getJson<SessionWire>(`/api/v1/sessions/${id}`);
    expect(got.body.data).not.toHaveProperty('agent_config');
  });

  it('supports has_prompt=true when listing sessions', async () => {
    const cwd = home as string;
    const created = await postJson<SessionWire>('/api/v1/sessions', { metadata: { cwd } });

    const all = await getJson<PageWire>('/api/v1/sessions');
    expect(all.body.data.items.some((s) => s.id === created.body.data.id)).toBe(true);

    const filtered = await getJson<PageWire>('/api/v1/sessions?has_prompt=true');
    expect(filtered.body.code).toBe(0);
    expect(filtered.body.data.items.some((s) => s.id === created.body.data.id)).toBe(false);
  });

  it('paginates sessions with before_id and terminates on the last page', async () => {
    await restartWithFreshHome();
    const cwd = home as string;
    const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
    const ids: string[] = [];
    for (let i = 0; i < 7; i++) {
      const { body } = await postJson<SessionWire>('/api/v1/sessions', { metadata: { cwd } });
      expect(body.code).toBe(0);
      ids.push(body.data.id);
      await sleep(5);
    }

    const page1 = await getJson<PageWire>('/api/v1/sessions?page_size=3');
    expect(page1.body.code).toBe(0);
    expect(page1.body.data.items.map((s) => s.id)).toEqual(ids.slice(4).toReversed());
    expect(page1.body.data.has_more).toBe(true);

    const cursor1 = page1.body.data.items.at(-1)!.id;
    const page2 = await getJson<PageWire>(
      `/api/v1/sessions?page_size=3&before_id=${encodeURIComponent(cursor1)}`,
    );
    expect(page2.body.data.items.map((s) => s.id)).toEqual(ids.slice(1, 4).toReversed());
    expect(page2.body.data.has_more).toBe(true);

    const cursor2 = page2.body.data.items.at(-1)!.id;
    const page3 = await getJson<PageWire>(
      `/api/v1/sessions?page_size=3&before_id=${encodeURIComponent(cursor2)}`,
    );
    expect(page3.body.data.items.map((s) => s.id)).toEqual([ids[0]]);
    expect(page3.body.data.has_more).toBe(false);

    const seen = [
      ...page1.body.data.items,
      ...page2.body.data.items,
      ...page3.body.data.items,
    ].map((s) => s.id);
    expect(new Set(seen).size).toBe(7);
    expect(new Set(seen)).toEqual(new Set(ids));

    const last = await getJson<PageWire>(
      `/api/v1/sessions?page_size=3&before_id=${encodeURIComponent(ids[0]!)}`,
    );
    expect(last.body.data.items).toEqual([]);
    expect(last.body.data.has_more).toBe(false);
  });

  it('returns an empty terminal page for an unknown before_id cursor', async () => {
    const cwd = home as string;
    await postJson<SessionWire>('/api/v1/sessions', { metadata: { cwd } });
    const { body } = await getJson<PageWire>(
      '/api/v1/sessions?page_size=3&before_id=sess_does_not_exist',
    );
    expect(body.code).toBe(0);
    expect(body.data.items).toEqual([]);
    expect(body.data.has_more).toBe(false);
  });

  it('gets a session by id and 404s for unknown', async () => {
    const cwd = home as string;
    const created = await postJson<SessionWire>('/api/v1/sessions', { metadata: { cwd } });

    const got = await getJson<SessionWire>(`/api/v1/sessions/${created.body.data.id}`);
    expect(got.body.code).toBe(0);
    expect(got.body.data.id).toBe(created.body.data.id);

    const missing = await getJson<null>('/api/v1/sessions/nope');
    expect(missing.body.code).toBe(40401);
  });

  it('updates the session title via profile', async () => {
    const cwd = home as string;
    const created = await postJson<SessionWire>('/api/v1/sessions', { metadata: { cwd } });
    const id = created.body.data.id;

    const updated = await postJson<ProfileWire>(`/api/v1/sessions/${id}/profile`, {
      title: 'renamed',
    });
    expect(updated.body.code).toBe(0);
    expect(updated.body.data.session.title).toBe('renamed');

    const got = await getJson<SessionWire>(`/api/v1/sessions/${id}`);
    expect(got.body.data.title).toBe('renamed');
  });

  it('still accepts profile updates that carry the never-applied profile fields', async () => {
    const created = await postJson<SessionWire>('/api/v1/sessions', { metadata: { cwd: home as string } });

    const updated = await postJson<ProfileWire>(`/api/v1/sessions/${created.body.data.id}/profile`, {
      title: 'renamed',
      agent_config: { system_prompt: 'be brief', tools: ['Read'], mcp_servers: ['docs'] },
      permission_rules: [],
    });

    expect(updated.body.code).toBe(0);
    expect(updated.body.data.session.title).toBe('renamed');
  });

  it('returns title-unavailable when generation cannot run', async () => {
    const created = await postJson<SessionWire>('/api/v1/sessions', {
      metadata: { cwd: home as string },
    });

    const generated = await postJson<null>(
      `/api/v1/sessions/${created.body.data.id}/title/generate`,
    );

    expect(generated.body.code).toBe(40923);
  });

  it('generates and persists a title through the public REST path', async () => {
    const kimi = await startKimiServices({ accessToken: 'test-token' });
    onTestFinished(() => kimi.close());
    kimi.title(...Array.from({ length: 4 }, () => 'generated from REST'));
    await server?.close();
    server = undefined;
    await writeFile(
      join(home as string, 'config.toml'),
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
        '[providers."managed:kimi-code"]',
        'type = "kimi"',
        `base_url = "${kimi.baseUrl}"`,
        '',
        '[providers."managed:kimi-code".oauth]',
        'storage = "file"',
        'key = "kimi-code"',
        '',
      ].join('\n'),
      'utf-8',
    );

    const oauth: IOAuthServiceType = {
      _serviceBrand: undefined,
      startLogin: async () => {
        throw new Error('unused');
      },
      getFlow: () => undefined,
      cancelLogin: async () => {
        throw new Error('unused');
      },
      logout: async () => {
        throw new Error('unused');
      },
      status: async () => ({ loggedIn: true, provider: 'managed:kimi-code' }),
      refreshOAuthProviderModels: async () => ({ changed: [], unchanged: [], failed: [] }),
      getManagedUsage: async () => ({ kind: 'error', message: 'unused' }),
      getManagedUserInfo: async () => ({ kind: 'error', message: 'unused' }),
      resolveTokenProvider: () => ({ getAccessToken: async () => 'test-token' }),
      getCachedAccessToken: async () => 'test-token',
      getRegion: () => 'mainland-cn',
      getRegionAsync: async () => 'mainland-cn',
    };
    server = await startServer({
      hostIdentity: TEST_HOST_IDENTITY,
      host: '127.0.0.1',
      port: 0,
      homeDir: home,
      logLevel: 'silent',
      seeds: [[IOAuthService, oauth]] as ScopeSeed,
    });
    base = `http://127.0.0.1:${server.port}`;

    const titleInputs = (): string[] =>
      kimi.requests('title').map((request) => (request.json as { params: { chat_content: string } }).params.chat_content);

    const created = await postJson<SessionWire>('/api/v1/sessions', {
      metadata: { cwd: home as string },
    });
    const id = created.body.data.id;
    for (const text of ['first REST prompt', 'second REST prompt', 'third REST prompt']) {
      const submitted = await postJson<{ prompt_id: string }>(
        `/api/v1/sessions/${id}/prompts`,
        { content: [{ type: 'text', text }] },
      );
      expect(submitted.body.code).toBe(0);
    }

    const generated = await postJson<{ title: string }>(
      `/api/v1/sessions/${id}/title/generate`,
    );
    expect(generated.body).toMatchObject({ code: 0, data: { title: 'generated from REST' } });
    expect(titleInputs()).toEqual(['user: first REST prompt\nuser: second REST prompt\nuser: third REST prompt']);

    const got = await getJson<SessionWire>(`/api/v1/sessions/${id}`);
    expect(got.body).toMatchObject({ code: 0, data: { title: 'generated from REST' } });

    const again = await postJson<null>(`/api/v1/sessions/${id}/title/generate`);
    expect(again.body.code).toBe(40923);

    const forced = await postJson<{ title: string }>(`/api/v1/sessions/${id}/title/generate`, {
      force: true,
    });
    expect(forced.body).toMatchObject({ code: 0, data: { title: 'generated from REST' } });

    await postJson<SessionWire>(`/api/v1/sessions/${id}/profile`, { title: 'custom title' });
    const forcedCustom = await postJson<{ title: string }>(
      `/api/v1/sessions/${id}/title/generate`,
      { force: true },
    );
    expect(forcedCustom.body).toMatchObject({ code: 0, data: { title: 'generated from REST' } });
    const afterCustom = await getJson<SessionWire>(`/api/v1/sessions/${id}`);
    expect(afterCustom.body.data.title).toBe('generated from REST');

    const digested = await postJson<{ title: string }>(`/api/v1/sessions/${id}/title/generate`, {
      force: true,
      source: 'digest',
    });
    expect(digested.body).toMatchObject({ code: 0, data: { title: 'generated from REST' } });
    expect(titleInputs().at(-1)).toBe('user: first REST prompt\nuser: second REST prompt\nuser: third REST prompt');
    kimi.verify();
  });

  it('returns session-not-found when generating a title for a missing session', async () => {
    const generated = await postJson<null>(
      '/api/v1/sessions/sess_missing_title/title/generate',
    );

    expect(generated.body.code).toBe(40401);
  });

  it('serializes occupied errors from metadata mutation routes', async () => {
    const created = await postJson<SessionWire>('/api/v1/sessions', {
      metadata: { cwd: home as string },
    });
    const id = created.body.data.id;
    const handle = getLiveSessionById((server as RunningServer).core.accessor, id)!;
    const occupied = new Error2(ErrorCodes.SESSION_OCCUPIED, 'occupied');

    const setTitle = vi
      .spyOn(handle.accessor.get(ISessionMetadata), 'setTitle')
      .mockRejectedValue(occupied);
    const profile = await postJson(`/api/v1/sessions/${id}/profile`, { title: 'occupied' });
    expect(profile.status).toBe(200);
    expect(profile.body.code).toBe(40931);
    setTitle.mockRestore();

    const generateTitle = vi
      .spyOn(handle.accessor.get(ISessionTitleService), 'generateTitle')
      .mockRejectedValue(occupied);
    const generated = await postJson(`/api/v1/sessions/${id}/title/generate`);
    expect(generated.status).toBe(200);
    expect(generated.body.code).toBe(40931);
    generateTitle.mockRestore();
  });

  it('no longer serves GET /status', async () => {
    const cwd = home as string;
    const created = await postJson<SessionWire>('/api/v1/sessions', { metadata: { cwd } });
    const res = await getJson<unknown>(`/api/v1/sessions/${created.body.data.id}/status`);
    expect(res.status).toBe(404);
  });

  async function mainAgentOf(id: string) {
    const session = getLiveSessionById((server as RunningServer).core.accessor, id)!;
    return ensureMainAgent(session);
  }

  it('applies plan/swarm/permission agent_config to the main agent state', async () => {
    const cwd = home as string;
    const created = await postJson<SessionWire>('/api/v1/sessions', { metadata: { cwd } });
    const id = created.body.data.id;

    const before = readAgentState(await mainAgentOf(id), false);
    expect(before.plan_mode).toBe(false);
    expect(before.swarm_mode).toBe(false);

    await postJson(`/api/v1/sessions/${id}/profile`, {
      agent_config: { plan_mode: true, swarm_mode: true, permission_mode: 'yolo' },
    });

    const after = readAgentState(await mainAgentOf(id), false);
    expect(after.plan_mode).toBe(true);
    expect(after.swarm_mode).toBe(true);
    expect(after.permission_mode).toBe('yolo');
  });

  it('applies agent_config and keeps custom metadata when creating a session', async () => {
    const cwd = home as string;
    const created = await postJson<SessionWire>('/api/v1/sessions', {
      metadata: { cwd, source: 'composer' },
      agent_config: { plan_mode: true, permission_mode: 'yolo' },
    });

    expect(created.body.code).toBe(0);
    expect(created.body.data.metadata).toMatchObject({ source: 'composer' });
    expect(created.body.data.cwd).toBe(cwd);
    const state = readAgentState(await mainAgentOf(created.body.data.id), false);
    expect(state.plan_mode).toBe(true);
    expect(state.permission_mode).toBe('yolo');
  });

  it('keeps custom metadata for a session created by workspace_id alone', async () => {
    const cwd = home as string;
    const first = await postJson<SessionWire>('/api/v1/sessions', { metadata: { cwd } });

    const created = await postJson<SessionWire>('/api/v1/sessions', {
      workspace_id: first.body.data.workspace_id,
      metadata: { source: 'composer' },
    });

    expect(created.body.code).toBe(0);
    expect(created.body.data.metadata).toMatchObject({ source: 'composer' });
    expect(created.body.data.cwd).toBe(cwd);
  });

  it('drops the child-link metadata keys when creating an ordinary session', async () => {
    const cwd = home as string;
    const parent = await postJson<SessionWire>('/api/v1/sessions', { metadata: { cwd } });
    const parentId = parent.body.data.id;

    const created = await postJson<SessionWire>('/api/v1/sessions', {
      metadata: { cwd, parent_session_id: parentId, child_session_kind: 'child' },
    });

    expect(created.body.code).toBe(0);
    expect(created.body.data.metadata).toBeUndefined();
  });

  it('drops the reserved metadata keys when updating the session profile', async () => {
    const cwd = home as string;
    const parent = await postJson<SessionWire>('/api/v1/sessions', { metadata: { cwd } });
    const parentId = parent.body.data.id;
    const created = await postJson<SessionWire>('/api/v1/sessions', { metadata: { cwd } });
    const id = created.body.data.id;

    const updated = await postJson<ProfileWire>(`/api/v1/sessions/${id}/profile`, {
      metadata: {
        cwd: '/elsewhere',
        goal: 'not a goal',
        parent_session_id: parentId,
        child_session_kind: 'child',
        source: 'composer',
      },
    });

    expect(updated.body.code).toBe(0);
    expect(updated.body.data.session.metadata).toEqual({ source: 'composer' });
  });

  it.each([
    { source: 'composer' },
    { parent_session_id: null, child_session_kind: null },
    { parent_session_id: 'session_other', child_session_kind: 'child', source: 'composer' },
  ])('keeps a child session linked when its profile metadata is %o', async (patch) => {
    const cwd = home as string;
    const parent = await postJson<SessionWire>('/api/v1/sessions', { metadata: { cwd } });
    const parentId = parent.body.data.id;
    const childMeta = await (server as RunningServer).core.accessor.get(ISessionManager).createChild({
      sourceSessionId: parentId,
    });
    const childId = childMeta.id;

    const updated = await postJson<ProfileWire>(`/api/v1/sessions/${childId}/profile`, {
      metadata: patch,
    });

    expect(updated.body.code).toBe(0);
    expect(updated.body.data.session.metadata?.['parent_session_id']).toBe(parentId);
    expect(updated.body.data.session.metadata?.['child_session_kind']).toBe('child');
  });

  it('replaces the custom metadata even when the profile metadata names only reserved keys', async () => {
    const cwd = home as string;
    const created = await postJson<SessionWire>('/api/v1/sessions', {
      metadata: { cwd, source: 'composer' },
    });

    const updated = await postJson<ProfileWire>(`/api/v1/sessions/${created.body.data.id}/profile`, {
      metadata: { cwd: '/elsewhere' },
    });

    expect(updated.body.code).toBe(0);
    expect(updated.body.data.session.metadata).toBeUndefined();
  });

  it('reports an unknown creation model as a validation error and creates nothing', async () => {
    const listed = async (): Promise<string[]> =>
      (await getJson<PageWire>('/api/v1/sessions')).body.data.items.map((session) => session.id);
    const before = await listed();

    const created = await postJson<SessionWire>('/api/v1/sessions', {
      metadata: { cwd: home as string },
      agent_config: { model: 'no-such-model' },
    });

    expect(created.body.code).toBe(40001);
    expect(await listed()).toEqual(before);
  });

  it('rejects enabling tower_mode before creating anything', async () => {
    const listed = async (): Promise<string[]> =>
      (await getJson<PageWire>('/api/v1/sessions')).body.data.items.map((session) => session.id);
    const before = await listed();

    const created = await postJson<SessionWire>('/api/v1/sessions', {
      metadata: { cwd: home as string },
      agent_config: { tower_mode: true, tower_base: 'release' },
    });

    expect(created.body.code).toBe(40001);
    expect(await listed()).toEqual(before);
  });

  function liveMainAgent(id: string) {
    const session = getLiveSessionById((server as RunningServer).core.accessor, id)!;
    return session.accessor.get(IAgentLifecycleService).handleOf(MAIN_AGENT_ID);
  }

  it('binds the main agent to the default model when the session is created', async () => {
    await restartWithModels();

    const created = await postJson<SessionWire>('/api/v1/sessions', {
      metadata: { cwd: home as string },
    });

    expect(created.body.data).not.toHaveProperty('agent_config');
    const main = liveMainAgent(created.body.data.id);
    expect(main).toBeDefined();
    expect(main!.accessor.get(IAgentLoopService).data().profileName).toBe('agent');
    expect(readAgentState(main!, false).model).toBe('stub');
  });

  it('waits for the model configuration before choosing the creation model', async () => {
    await restartWithModels();
    const models = (server as RunningServer).core.accessor.get(IModelService);
    let loaded = false;
    let release!: () => void;
    (models as { ready: Promise<void> }).ready = new Promise<void>((resolve) => {
      release = resolve;
    });
    vi.spyOn(models, 'getDefaultModel').mockImplementation(() => (loaded ? 'stub' : undefined));

    const pending = postJson<SessionWire>('/api/v1/sessions', { metadata: { cwd: home as string } });
    await new Promise((resolve) => setTimeout(resolve, 50));
    loaded = true;
    release();
    const created = await pending;

    expect(created.body.data).not.toHaveProperty('agent_config');
  });

  it('keeps a thinking level given at creation without a model', async () => {
    await restartWithModels();

    const created = await postJson<SessionWire>('/api/v1/sessions', {
      metadata: { cwd: home as string },
      agent_config: { thinking: 'high' },
    });

    expect(created.body.code).toBe(0);
    expect(readAgentState(liveMainAgent(created.body.data.id)!, false)).toMatchObject({
      model: 'stub',
      thinking: 'high',
    });
  });

  it('binds the profile, model and thinking given at creation together', async () => {
    await restartWithModels();

    const created = await postJson<SessionWire>('/api/v1/sessions', {
      metadata: { cwd: home as string },
      agent_config: { profile: 'route-reviewer', model: 'other', thinking: 'high' },
    });

    expect(created.body.code).toBe(0);
    const main = liveMainAgent(created.body.data.id)!;
    expect(main.accessor.get(IAgentLoopService).data().profileName).toBe('route-reviewer');
    expect(readAgentState(main, false)).toMatchObject({ model: 'other', thinking: 'high' });
  });

  it('rejects changing the profile after the session is created', async () => {
    await restartWithModels();
    const created = await postJson<SessionWire>('/api/v1/sessions', {
      metadata: { cwd: home as string },
    });

    const updated = await postJson<SessionWire>(`/api/v1/sessions/${created.body.data.id}/profile`, {
      agent_config: { profile: 'route-reviewer' },
    });

    expect(updated.body.code).toBe(40001);
    expect(JSON.stringify(updated.body)).toContain('agent_config.profile');
    const main = liveMainAgent(created.body.data.id)!;
    expect(main.accessor.get(IAgentLoopService).data().profileName).toBe('agent');
  });

  it('rejects an unknown profile at creation and creates nothing', async () => {
    await restartWithModels();
    const listed = async (): Promise<string[]> =>
      (await getJson<PageWire>('/api/v1/sessions')).body.data.items.map((session) => session.id);
    const before = await listed();

    const created = await postJson<SessionWire>('/api/v1/sessions', {
      metadata: { cwd: home as string },
      agent_config: { profile: 'agent_does_not_exist' },
    });

    expect(created.body.code).toBe(40001);
    expect(created.body.msg).toContain('agent_does_not_exist');
    expect(await listed()).toEqual(before);
  });

  it('keeps the model of an existing session when the default model changes', async () => {
    await restartWithModels();
    const first = await postJson<SessionWire>('/api/v1/sessions', {
      metadata: { cwd: home as string },
    });

    await (server as RunningServer).core.accessor.get(IModelCatalog).setDefaultModel('other');
    const second = await postJson<SessionWire>('/api/v1/sessions', {
      metadata: { cwd: home as string },
    });

    const got = await getJson<SessionWire>(`/api/v1/sessions/${first.body.data.id}`);
    expect(readAgentState(liveMainAgent(first.body.data.id)!, false).model).toBe('stub');
    expect(readAgentState(liveMainAgent(second.body.data.id)!, false).model).toBe('other');
  });

  it('keeps the client flow of model at creation, then thinking and permission through the profile', async () => {
    await restartWithModels();
    const created = await postJson<SessionWire>('/api/v1/sessions', {
      metadata: { cwd: home as string },
      agent_config: { model: 'other' },
    });
    const id = created.body.data.id;

    const updated = await postJson<SessionWire>(`/api/v1/sessions/${id}/profile`, {
      agent_config: { thinking: 'high', permission_mode: 'yolo' },
    });

    expect(updated.body.code).toBe(0);
    expect(readAgentState(liveMainAgent(id)!, false)).toMatchObject({
      model: 'other',
      thinking: 'high',
      permission_mode: 'yolo',
    });
  });

  it('creates a session without a model when none is available', async () => {
    const cwd = home as string;
    const created = await postJson<SessionWire>('/api/v1/sessions', { metadata: { cwd } });

    expect(created.body.code).toBe(0);
    expect(created.body.data).not.toHaveProperty('agent_config');
    expect(liveMainAgent(created.body.data.id)).toBeUndefined();

    const thinking = await postJson<SessionWire>(`/api/v1/sessions/${created.body.data.id}/profile`, {
      agent_config: { thinking: 'high' },
    });
    expect(thinking.body.code).toBe(40113);
  });

  it.each([{ thinking: 'high' }, { profile: 'agent' }])(
    'rejects agent_config %o at creation when no model is available',
    async (agentConfig) => {
      const listed = async (): Promise<string[]> =>
        (await getJson<PageWire>('/api/v1/sessions')).body.data.items.map((session) => session.id);
      const before = await listed();

      const created = await postJson<SessionWire>('/api/v1/sessions', {
        metadata: { cwd: home as string },
        agent_config: agentConfig,
      });

      expect(created.body.code).toBe(40113);
      expect(await listed()).toEqual(before);
    },
  );

  it('creates nothing and announces nothing when its agent_config cannot be applied', async () => {
    const cwd = home as string;
    const listed = async (): Promise<string[]> =>
      (await getJson<PageWire>('/api/v1/sessions')).body.data.items.map((session) => session.id);
    const before = await listed();
    const announced: string[] = [];
    const subscription = (server as RunningServer).core.accessor
      .get(IEventService)
      .subscribe((event) => announced.push(event.type));

    try {
      const created = await postJson<SessionWire>('/api/v1/sessions', {
        metadata: { cwd },
        agent_config: { goal_control: 'pause' },
      });

      expect(created.body.code).toBe(40914);
      expect(await listed()).toEqual(before);
      expect(announced.filter((type) => type.startsWith('event.session.'))).toEqual([]);
      const index = (server as RunningServer).core.accessor.get(ISessionIndexMirror);
      expect(index.pending().filter((summary) => !before.includes(summary.id))).toEqual([]);
    } finally {
      subscription.dispose();
    }
  });

  it('rejects tower_mode agent_config when the tower feature is unavailable', async () => {
    const cwd = home as string;
    const created = await postJson<SessionWire>('/api/v1/sessions', { metadata: { cwd } });
    const id = created.body.data.id;

    expect(readAgentState(await mainAgentOf(id), false).tower_mode).toBe(false);

    const on = await postJson(`/api/v1/sessions/${id}/profile`, {
      agent_config: { tower_mode: true },
    });
    expect(on.body.code).toBe(40935);
    expect(on.body.msg).toContain('the tower experiment is disabled');
    expect(on.body.msg).toContain('KIMI_CODE_EXPERIMENTAL_TOWER=1');
    expect(readAgentState(await mainAgentOf(id), false).tower_mode).toBe(false);

    const off = await postJson(`/api/v1/sessions/${id}/profile`, {
      agent_config: { tower_mode: false },
    });
    expect(off.body.code).toBe(0);
    expect(readAgentState(await mainAgentOf(id), false).tower_mode).toBe(false);
  });

  it('no longer serves the legacy goal, profile GET, messages, or children routes', async () => {
    const created = await postJson<SessionWire>('/api/v1/sessions', { metadata: { cwd: home as string } });
    const id = created.body.data.id;

    expect((await getJson(`/api/v1/sessions/${id}/goal`)).status).toBe(404);
    expect((await patchJson(`/api/v1/sessions/${id}/goal`, { objective: 'work' })).status).toBe(404);
    expect((await getJson(`/api/v1/sessions/${id}/profile`)).status).toBe(404);
    expect((await getJson(`/api/v1/sessions/${id}/messages`)).status).toBe(404);
    expect((await getJson(`/api/v1/sessions/${id}/children`)).status).toBe(404);
    expect((await postJson(`/api/v1/sessions/${id}/children`, {})).body.code).toBe(40001);
  });

  it('edits the current goal through profile goal_control edit', async () => {
    const created = await postJson<SessionWire>('/api/v1/sessions', { metadata: { cwd: home as string } });
    const id = created.body.data.id;
    await postJson(`/api/v1/sessions/${id}/profile`, {
      agent_config: { goal_objective: 'fix all lint warnings' },
    });
    const agent = getLiveSessionById((server as RunningServer).core.accessor, id)
      ?.accessor.get(IAgentLifecycleService)
      .handleOf(MAIN_AGENT_ID);
    if (agent === undefined) throw new Error('expected a live main agent');
    const events: Event2<any>[] = [];
    const subscription = agent.accessor.get(IEventBus).subscribe((event) => events.push(event));

    try {
      const edited = await postJson<ProfileWire>(`/api/v1/sessions/${id}/profile`, {
        agent_config: { goal_control: 'edit', goal_objective: 'fix all type errors' },
      });

      expect(edited.body.code).toBe(0);
      const updated = events.filter((event) => event.type === 'goal.updated');
      expect(updated).toHaveLength(1);
      expect(updated[0]).toMatchObject({ snapshot: { objective: 'fix all type errors' } });
    } finally {
      subscription.dispose();
    }
  });

  it('starts one continuation when the Web profile resumes a blocked goal', async () => {
    const rig = await createBlockedGoalRig();
    try {
      const resumed = await postJson<SessionWire>(`/api/v1/sessions/${rig.id}/profile`, {
        agent_config: { goal_control: 'resume' },
      });

      expect(resumed.body.code).toBe(0);
      expect(goalContinuationStarts(rig.events)).toHaveLength(1);
    } finally {
      await rig.cancel();
    }
  });

  it('starts one continuation when the Web profile resumes a paused goal', async () => {
    const rig = await createStoppedGoalRig('paused');
    try {
      const resumed = await postJson<SessionWire>(`/api/v1/sessions/${rig.id}/profile`, {
        agent_config: { goal_control: 'resume' },
      });

      expect(resumed.body.code).toBe(0);
      expect(goalContinuationStarts(rig.events)).toHaveLength(1);
    } finally {
      await rig.cancel();
    }
  });

  it('returns the active goal when the Web refreshes after blocked-goal resume', async () => {
    const rig = await createBlockedGoalRig();
    try {
      rig.eventBus.publish(
        new TurnStarted({ agentId: 'main', turnId: 999, origin: { kind: 'user' } }),
      );
      await postJson<SessionWire>(`/api/v1/sessions/${rig.id}/profile`, {
        agent_config: { goal_control: 'resume' },
      });

      const refreshed = readGoalState(liveMainAgent(rig.id)!);

      expect(refreshed?.status).toBe('active');
    } finally {
      await rig.cancel();
    }
  });

  it('takes over the session lock via :takeover', async () => {
    const created = await postJson<SessionWire>('/api/v1/sessions', {
      metadata: { cwd: home as string },
    });
    const id = created.body.data.id;
    const takeover = vi.spyOn(
      (server as RunningServer).core.accessor.get(ISessionLockService),
      'takeover',
    );
    try {
      const taken = await postJson<{ taken_over: boolean }>(`/api/v1/sessions/${id}:takeover`);
      expect(taken.body.code).toBe(0);
      expect(taken.body.data).toEqual({ taken_over: true });
      expect(takeover).toHaveBeenCalledWith(id);

      const missing = await postJson<null>('/api/v1/sessions/sess_missing_takeover:takeover');
      expect(missing.body.code).toBe(40401);
      expect(takeover).toHaveBeenCalledTimes(1);
    } finally {
      takeover.mockRestore();
    }
  });

  it('archives a session, force-kills a SIGTERM-ignoring baseline MCP, and reacquires the workspace', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'kimi-server-v2-session-archive-mcp-'));
    const fixture = new URL('../../agent-core-v2/test/mcpCore/fixtures/mock-stdio-server.mjs', import.meta.url).pathname;
    const spawned: IHostProcess[] = [];
    let disposeReplacement: (() => void) | undefined;
    const hostProcesses = (server as RunningServer).core.accessor.get(IHostProcessService);
    const spawn = hostProcesses.spawn.bind(hostProcesses);
    const spawnSpy = vi.spyOn(hostProcesses, 'spawn').mockImplementation(async (command, args, options) => {
      const child = await spawn(command, args, options);
      if (command === process.execPath && args?.[0] === fixture) spawned.push(child);
      return child;
    });
    try {
      vi.stubEnv('KIMI_CODE_TRUST_WORKSPACE', '1');
      await mkdir(join(cwd, '.kimi-code'), { recursive: true });
      await writeFile(
        join(cwd, '.kimi-code', 'mcp.json'),
        JSON.stringify({
          mcpServers: {
            fixture: {
              command: process.execPath,
              args: [fixture],
              env: { KIMI_TEST_MCP_IGNORE_SIGTERM: '1' },
            },
          },
        }),
      );
      const created = await postJson<SessionWire>('/api/v1/sessions', { metadata: { cwd } });
      const id = created.body.data.id;
      const workspaceId = created.body.data.workspace_id;
      const manager = (server as RunningServer).core.accessor.get(IProjectInstanceManager);
      const workspace = manager.get(workspaceId);
      expect(workspace).toBeDefined();
      const mcp = getLiveSessionById((server as RunningServer).core.accessor, id)!.accessor.get(ISessionMcpHandle);
      await mcp.ready;
      const connections = mcp.connectionManager;
      await vi.waitFor(() => {
        expect(connections.list().some((entry) => entry.name === 'fixture' && entry.status === 'connected')).toBe(true);
      });
      expect(spawned).toHaveLength(1);
      const child = spawned[0]!;
      const killSpy = vi.spyOn(child, 'kill');
      expect(child.exitCode).toBeNull();
      let disposeSubscription: (() => void) | undefined;
      const closed = new Promise<void>((resolve) => {
        const subscription = manager.onDidChange((change) => {
          if (change.workspaceId !== workspaceId || change.instance !== undefined) return;
          subscription.dispose();
          resolve();
        });
        disposeSubscription = () => subscription.dispose();
      });

      const archived = await postJson<{ archived: boolean }>(`/api/v1/sessions/${id}:archive`);
      expect(archived.body.code).toBe(0);
      expect(archived.body.data).toEqual({ archived: true });
      expect(manager.get(workspaceId)).toBeUndefined();
      const replacementLeasePromise = manager.acquire({ workspaceId });
      await closed;
      disposeSubscription?.();
      expect(connections.list()).toEqual([]);
      expect(child.exitCode).not.toBeNull();
      if (process.platform !== 'win32') expect(killSpy).toHaveBeenCalledWith('SIGKILL');

      const got = await getJson<SessionWire>(`/api/v1/sessions/${id}`);
      expect(got.body.code).toBe(0);
      expect(got.body.data.archived).toBe(true);

      const replacementLease = await replacementLeasePromise;
      disposeReplacement = () => {
        replacementLease.dispose();
      };
      const replacement = replacementLease.instance;
      expect(replacement).not.toBe(workspace);
      const replacementMcp = (await replacement.program.acquireMcp()).service;
      await replacementMcp.ready;
      const replacementConnections = replacementMcp.connectionManager();
      await vi.waitFor(() => {
        expect(replacementConnections.list().some((entry) => entry.name === 'fixture' && entry.status === 'connected')).toBe(true);
      });
      expect(spawned).toHaveLength(2);
      const replacementChild = spawned[1]!;
      expect(replacementChild.exitCode).toBeNull();
      let disposeReplacementSubscription: (() => void) | undefined;
      const replacementClosed = new Promise<void>((resolve) => {
        const subscription = manager.onDidChange((change) => {
          if (change.workspaceId !== workspaceId || change.instance !== undefined) return;
          subscription.dispose();
          resolve();
        });
        disposeReplacementSubscription = () => {
          subscription.dispose();
        };
      });
      replacementLease.dispose();
      await replacementClosed;
      disposeReplacementSubscription?.();
      expect(replacementChild.exitCode).not.toBeNull();
    } finally {
      disposeReplacement?.();
      spawnSpy.mockRestore();
      for (const child of spawned) {
        if (child.exitCode === null) await child.kill('SIGKILL');
      }
      await rm(cwd, { recursive: true, force: true });
    }
  }, 30_000);

  describe('MCP servers of a workspace', () => {
    const fixture = new URL('../../agent-core-v2/test/mcpCore/fixtures/mock-stdio-server.mjs', import.meta.url).pathname;
    let root: string;
    let opened: string[];
    let spawned: IHostProcess[];

    async function writeServer(dir: string, name: string): Promise<void> {
      await mkdir(join(dir, '.kimi-code'), { recursive: true });
      await writeFile(
        join(dir, '.kimi-code', 'mcp.json'),
        JSON.stringify({ mcpServers: { [name]: { command: process.execPath, args: [fixture] } } }),
      );
    }

    async function openSession(pinned?: string, cwd = root): Promise<{ id: string; statuses: () => Record<string, string> }> {
      const created = await postJson<SessionWire>('/api/v1/sessions', {
        metadata: { cwd },
        ...(pinned === undefined ? {} : { environment_id: 'local', environment_cwd: pinned }),
      });
      expect(created.body.code).toBe(0);
      const { id } = created.body.data;
      opened.push(id);
      const mcp = getLiveSessionById((server as RunningServer).core.accessor, id)!.accessor.get(ISessionMcpHandle);
      await mcp.ready;
      return {
        id,
        statuses: () => Object.fromEntries(mcp.connectionManager.list().map((entry) => [entry.name, entry.status])),
      };
    }

    beforeEach(async () => {
      vi.stubEnv('KIMI_CODE_TRUST_WORKSPACE', '1');
      root = await realpath(await mkdtemp(join(tmpdir(), 'kimi-server-v2-session-mcp-')));
      await writeServer(root, 'home');
      opened = [];
      spawned = [];
      const hostProcesses = (server as RunningServer).core.accessor.get(IHostProcessService);
      const spawn = hostProcesses.spawn.bind(hostProcesses);
      vi.spyOn(hostProcesses, 'spawn').mockImplementation(async (command, args, options) => {
        const child = await spawn(command, args, options);
        if (command === process.execPath && args?.[0] === fixture) spawned.push(child);
        return child;
      });
    });

    afterEach(async () => {
      for (const id of opened) await closeSessionById((server as RunningServer).core.accessor, id);
      await rm(root, { recursive: true, force: true });
    });

    it('start with its first session, serve every session, and stop with the last while the workspace stays open', async () => {
      const src = join(root, 'src');
      const elsewhere = await realpath(await mkdtemp(join(tmpdir(), 'kimi-server-v2-session-mcp-other-')));
      const lease = await (server as RunningServer).core.accessor.get(IProjectInstanceManager).acquire({ cwd: root });
      try {
        await writeServer(src, 'own');
        await writeServer(elsewhere, 'elsewhere');
        await lease.instance.program.ready;
        expect(spawned).toHaveLength(0);

        const sessions = [await openSession(), await openSession(src), await openSession(elsewhere)];
        expect(sessions.map((session) => session.statuses())).toEqual([
          { home: 'connected' },
          { home: 'connected' },
          { home: 'connected' },
        ]);
        expect(spawned).toHaveLength(1);

        const last = sessions.pop()!;
        for (const { id } of sessions) {
          expect((await postJson(`/api/v1/sessions/${id}:archive`)).body.code).toBe(0);
        }
        expect(last.statuses()).toEqual({ home: 'connected' });

        expect((await postJson(`/api/v1/sessions/${last.id}:archive`)).body.code).toBe(0);
        await vi.waitFor(() => {
          expect(spawned[0]!.exitCode).not.toBeNull();
        }, 20_000);
        expect(last.statuses()).toEqual({});
      } finally {
        lease.dispose();
        await rm(elsewhere, { recursive: true, force: true });
      }
    }, 30_000);

    it('run once per checkout, as its root configures them, and stop with the last session there', async () => {
      const { lab, main, worktree } = await repositoryWithWorktree();
      const src = join(main, 'src');
      const worktreeSrc = join(worktree, 'src');
      try {
        await writeServer(main, 'home');
        await writeServer(worktree, 'own');
        for (const dir of [src, worktreeSrc]) await writeServer(dir, 'planted');

        const inWorktree = [await openSession(undefined, worktree), await openSession(worktreeSrc, main)];
        expect(spawned).toHaveLength(1);
        const inMain = [await openSession(undefined, main), await openSession(undefined, src)];
        expect(inWorktree.map((session) => session.statuses())).toEqual([{ own: 'connected' }, { own: 'connected' }]);
        expect(inMain.map((session) => session.statuses())).toEqual([{ home: 'connected' }, { home: 'connected' }]);
        expect(spawned).toHaveLength(2);

        expect((await postJson(`/api/v1/sessions/${inWorktree[0]!.id}:archive`)).body.code).toBe(0);
        expect(inWorktree[1]!.statuses()).toEqual({ own: 'connected' });

        expect((await postJson(`/api/v1/sessions/${inWorktree[1]!.id}:archive`)).body.code).toBe(0);
        await vi.waitFor(() => {
          expect(spawned[0]!.exitCode).not.toBeNull();
        }, 20_000);
        expect(inMain[0]!.statuses()).toEqual({ home: 'connected' });
        expect(spawned[1]!.exitCode).toBeNull();
      } finally {
        await rm(lab, { recursive: true, force: true });
      }
    }, 30_000);

    it('do not start to fork or archive a session that is not open', async () => {
      const closed = await openSession();
      await closeSessionById((server as RunningServer).core.accessor, closed.id);
      expect(spawned).toHaveLength(1);

      expect((await postJson(`/api/v1/sessions/${closed.id}:fork`, {})).body.code).toBe(0);
      expect((await postJson(`/api/v1/sessions/${closed.id}:archive`)).body.code).toBe(0);

      await openSession();
      expect(spawned).toHaveLength(2);
    }, 30_000);
  });

  it.each([
    ['pinned at its directory', true],
    ['following its project', false],
  ] as const)('resumes a session %s whose workspace root is gone (root validity deferred to binding) and still archives it', async (_placement, pinned) => {
    const cwd = join(home as string, 'gone-ws');
    await mkdir(cwd);
    const created = await postJson<SessionWire>('/api/v1/sessions', { metadata: { cwd } });
    const id = created.body.data.id;
    if (pinned) {
      await getLiveSessionById((server as RunningServer).core.accessor, id)!
        .accessor.get(ISessionMetadata)
        .update({ environmentCwd: cwd }, { touchUpdatedAt: false });
    }
    await closeSessionById((server as RunningServer).core.accessor, id);
    await (server as RunningServer).core.accessor
      .get(IProjectService)
      .delete(encodeWorkDirKey(cwd));
    await rm(cwd, { recursive: true, force: true });

    const resumed = await resumeSessionById((server as RunningServer).core.accessor, id);
    expect(resumed?.id).toBe(id);

    const archived = await postJson<{ archived: boolean }>(`/api/v1/sessions/${id}:archive`);
    expect(archived.body.code).toBe(0);
    expect(archived.body.data).toEqual({ archived: true });

    const got = await getJson<SessionWire>(`/api/v1/sessions/${id}`);
    expect(got.body.code).toBe(0);
    expect(got.body.data.archived).toBe(true);
  });

  it('resumes a session of a repository subdirectory after its project was removed and the whole repository deleted', async () => {
    const { lab, main } = await repositoryWithWorktree();
    try {
      const subdir = join(main, 'src');
      const { id, workspace_id: workspaceId } = (await postJson<SessionWire>('/api/v1/sessions', { cwd: subdir })).body.data;
      expect(workspaceId).toBe(encodeWorkDirKey(main));
      await closeSessionById((server as RunningServer).core.accessor, id);
      expect((await deleteJson<{ deleted: boolean }>(`/api/v1/workspaces/${workspaceId}`)).body.code).toBe(0);
      await rm(main, { recursive: true });

      const resumed = await postJson<ProfileWire>(`/api/v1/sessions/${id}/profile`, {});

      expect(resumed.body.code).toBe(0);
      expect(resumed.body.data.session).toMatchObject({ id, workspace_id: workspaceId, cwd: subdir });
      const workspaces = await getJson<{ items: { id: string; root: string }[] }>('/api/v1/workspaces');
      expect(workspaces.body.data.items).toContainEqual(expect.objectContaining({ id: workspaceId, root: main }));
    } finally {
      await rm(lab, { recursive: true, force: true });
    }
  });

  it('keeps listing a session pinned in a removed directory, resumes it there, and archives and restores it', async () => {
    const { lab, main, worktree } = await repositoryWithWorktree();
    try {
      const created = await postJson<SessionWire>('/api/v1/sessions', { cwd: worktree });
      const id = created.body.data.id;
      await closeSessionById((server as RunningServer).core.accessor, id);
      git(main, 'worktree', 'remove', '--force', worktree);

      const listed = await getJson<PageWire>(`/api/v1/sessions?workspace_id=${encodeURIComponent(created.body.data.workspace_id)}`);
      expect(listed.body.data.items.find((item) => item.id === id)?.cwd).toBe(worktree);
      const resumed = await resumeSessionById((server as RunningServer).core.accessor, id);
      expect(resumed?.accessor.get(ISessionWorkdir).cwd).toBe(worktree);
      const archived = await postJson<{ archived: boolean }>(`/api/v1/sessions/${id}:archive`);
      expect(archived.body.code).toBe(0);
      const restored = await postJson<SessionWire>(`/api/v1/sessions/${id}:restore`);
      expect(restored.body.data).toMatchObject({ id, cwd: worktree, archived: false });
    } finally {
      await rm(lab, { recursive: true, force: true });
    }
  });

  it('restores an archived session via :restore and returns it to the default list', async () => {
    const cwd = home as string;
    const created = await postJson<SessionWire>('/api/v1/sessions', { metadata: { cwd } });
    const id = created.body.data.id;

    await postJson<{ archived: boolean }>(`/api/v1/sessions/${id}:archive`);

    const restored = await postJson<SessionWire>(`/api/v1/sessions/${id}:restore`);
    expect(restored.body.code).toBe(0);
    expect(restored.body.data.id).toBe(id);
    expect(restored.body.data.archived).toBe(false);

    const listed = await getJson<PageWire>('/api/v1/sessions');
    expect(listed.body.code).toBe(0);
    expect(listed.body.data.items.find((s) => s.id === id)?.archived).toBe(false);
  });

  it('returns 40401 when restoring a missing session', async () => {
    const { body } = await postJson<null>('/api/v1/sessions/sess_missing:restore');
    expect(body.code).toBe(40401);
  });

  it('deletes a session via :delete and publishes event.session.deleted', async () => {
    const cwd = home as string;
    const created = await postJson<SessionWire>('/api/v1/sessions', { metadata: { cwd } });
    const id = created.body.data.id;
    const workspaceId = created.body.data.workspace_id;

    const events: Event2<any>[] = [];
    const sub = (server as RunningServer).core.accessor
      .get(IEventService)
      .subscribe((event) => events.push(event));
    try {
      const deleted = await postJson<{ deleted: boolean }>(`/api/v1/sessions/${id}:delete`);
      expect(deleted.body.code).toBe(0);
      expect(deleted.body.data).toEqual({ deleted: true });

      const got = await getJson<null>(`/api/v1/sessions/${id}`);
      expect(got.body.code).toBe(40401);

      expect(
        events
          .filter((event) => event.type === 'event.session.deleted')
          .map((event) => (event as { readonly payload?: unknown }).payload),
      ).toMatchObject([{ sessionId: id, workspaceId }]);
    } finally {
      sub.dispose();
    }
  });

  it('deletes a cold session via :delete and publishes event.session.deleted', async () => {
    const cwd = home as string;
    const created = await postJson<SessionWire>('/api/v1/sessions', { metadata: { cwd } });
    const id = created.body.data.id;
    const workspaceId = created.body.data.workspace_id;
    await closeSessionById((server as RunningServer).core.accessor, id);
    expect(getLiveSessionById((server as RunningServer).core.accessor, id)).toBeUndefined();

    const events: Event2<any>[] = [];
    const sub = (server as RunningServer).core.accessor
      .get(IEventService)
      .subscribe((event) => events.push(event));
    try {
      const deleted = await postJson<{ deleted: boolean }>(`/api/v1/sessions/${id}:delete`);
      expect(deleted.body.code).toBe(0);
      expect(deleted.body.data).toEqual({ deleted: true });

      expect(
        events
          .filter((event) => event.type === 'event.session.deleted')
          .map((event) => (event as { readonly payload?: unknown }).payload),
      ).toMatchObject([{ sessionId: id, workspaceId }]);
    } finally {
      sub.dispose();
    }
  });

  it('reloads a session via :reload and injects change reminders for external updates', async () => {
    await server?.close();
    server = undefined;
    await writeFile(
      join(home as string, 'config.toml'),
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
        '[watch]',
        'enabled = false',
        '',
      ].join('\n'),
      'utf-8',
    );
    server = await startServer({
      hostIdentity: TEST_HOST_IDENTITY,
      host: '127.0.0.1',
      port: 0,
      homeDir: home,
      logLevel: 'silent',
      debugEndpoints: true,
    });
    base = `http://127.0.0.1:${server.port}`;

    const cwd = await mkdtemp(join(tmpdir(), 'kimi-reload-cwd-'));
    const extra = await mkdtemp(join(tmpdir(), 'kimi-reload-extra-'));
    await mkdir(join(cwd, '.git'));
    try {
      const created = await postJson<SessionWire>('/api/v1/sessions', { metadata: { cwd } });
      const id = created.body.data.id;
      const bound = await postJson<SessionWire>(`/api/v1/sessions/${id}/profile`, {
        agent_config: { model: 'stub' },
      });
      expect(bound.body.code).toBe(0);

      const first = await postJson<SessionWire>(`/api/v1/sessions/${id}:reload`);
      expect(first.body.code).toBe(0);
      expect(first.body.data.id).toBe(id);

      const readHistory = (sid: string) => {
        const live = getLiveSessionById((server as RunningServer).core.accessor, sid);
        const main = live?.accessor.get(IAgentLifecycleService).handleOf(MAIN_AGENT_ID);
        return main?.accessor.get(IAgentLoopService).history() ?? [];
      };
      const baselineCount = readHistory(id).length;

      await writeFile(join(cwd, 'AGENTS.md'), 'new workspace rules');
      const projectsPath = join(home as string, 'projects.json');
      const projects = JSON.parse(await readFile(projectsPath, 'utf8')) as {
        projects: Record<string, { root: string; additional_dirs?: string[] }>;
      };
      const project = Object.values(projects.projects).find((entry) => entry.root === cwd);
      if (project === undefined) throw new Error('expected the session project');
      project.additional_dirs = [extra];
      await writeFile(projectsPath, JSON.stringify(projects), 'utf8');

      const second = await postJson<SessionWire>(`/api/v1/sessions/${id}:reload`);
      expect(second.body.code).toBe(0);

      const afterItems = readHistory(id);
      expect(afterItems.length).toBeGreaterThan(baselineCount);
      const text = JSON.stringify(afterItems);
      expect(text).toContain('AGENTS.md');
      expect(text).toContain('were not included in your system prompt');
      expect(text).toContain(`Added directories: ${extra}.`);
      expect(
        afterItems.filter(
          (item) => (item.origin as { variant?: string } | undefined)?.variant === 'workspace_dirs_change',
        ),
      ).toHaveLength(1);

      const third = await postJson<SessionWire>(`/api/v1/sessions/${id}:reload`);
      expect(third.body.code).toBe(0);
      const reloadedItems = readHistory(id);
      expect(
        reloadedItems.filter(
          (item) => (item.origin as { variant?: string } | undefined)?.variant === 'workspace_dirs_change',
        ),
      ).toHaveLength(1);
    } finally {
      await rm(cwd, { recursive: true, force: true });
      await rm(extra, { recursive: true, force: true });
    }
  });

  it('delivers a subagents reminder when profiles change on reload', async () => {
    await server?.close();
    server = undefined;
    const configToml = [
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
      '[watch]',
      'enabled = false',
      '',
    ].join('\n');
    await writeFile(join(home as string, 'config.toml'), configToml, 'utf-8');
    server = await startServer({
      hostIdentity: TEST_HOST_IDENTITY,
      host: '127.0.0.1',
      port: 0,
      homeDir: home,
      logLevel: 'silent',
      debugEndpoints: true,
    });
    base = `http://127.0.0.1:${server.port}`;

    const cwd = await mkdtemp(join(tmpdir(), 'kimi-reload-pool-cwd-'));
    await mkdir(join(cwd, '.git'));
    try {
      const created = await postJson<SessionWire>('/api/v1/sessions', { metadata: { cwd } });
      const id = created.body.data.id;
      const bound = await postJson<SessionWire>(`/api/v1/sessions/${id}/profile`, {
        agent_config: { model: 'stub' },
      });
      expect(bound.body.code).toBe(0);

      await mkdir(join(home as string, 'agents'), { recursive: true });
      await writeFile(
        join(home as string, 'agents', 'deploy.md'),
        '---\nname: deploy\ndescription: Deploys things.\n---\nYou deploy things.\n',
        'utf-8',
      );

      const reloaded = await postJson<SessionWire>(`/api/v1/sessions/${id}:reload`);
      expect(reloaded.body.code).toBe(0);

      const live = getLiveSessionById((server as RunningServer).core.accessor, id);
      const main = live?.accessor.get(IAgentLifecycleService).handleOf(MAIN_AGENT_ID);
      const history = main?.accessor.get(IAgentLoopService).history() ?? [];
      const subagentReminders = history.filter(
        (item) => (item.origin as { variant?: string } | undefined)?.variant === 'subagents_change',
      );
      expect(subagentReminders).toHaveLength(1);
      const text = JSON.stringify(subagentReminders[0]);
      expect(text).toContain('The available subagent profiles changed:');
      expect(text).toContain('Profiles added: deploy');
    } finally {
      await rm(cwd, { recursive: true, force: true });
      await rm(join(home as string, 'agents'), { recursive: true, force: true });
    }
  });

  it('reloads the sessions of one checkout while the local.toml of another checkout of the project is broken', async () => {
    const { lab, main, worktree } = await repositoryWithWorktree();
    try {
      const sessions: { readonly id: string; readonly dir: string; readonly live: boolean }[] = [];
      for (const dir of [main, worktree]) {
        for (const live of [true, false]) {
          const { id } = (await postJson<SessionWire>('/api/v1/sessions', { cwd: dir })).body.data;
          sessions.push({ id, dir, live });
        }
      }

      for (const broken of [worktree, main]) {
        const localToml = join(broken, '.kimi-code', 'local.toml');
        await mkdir(dirname(localToml));
        await writeFile(localToml, '[workspace\n');
        for (const { id, dir, live } of sessions) {
          if (!live) await closeSessionById((server as RunningServer).core.accessor, id);

          const reloaded = await postJson<SessionWire | null>(`/api/v1/sessions/${id}:reload`);

          expect(reloaded.body).toMatchObject(
            dir === broken ? { code: 50001, msg: `Invalid TOML in ${localToml}` } : { code: 0, data: { id, cwd: dir } },
          );
        }
        await rm(localToml);
      }
    } finally {
      await rm(lab, { recursive: true, force: true });
    }
  });

  it.each(['closing', 'cleanup'] as const)('waits for %s before recreating an explicit session id', async (phase) => {
    const manager = server!.core.accessor.get(ISessionManager);
    const created = await postJson<SessionWire>('/api/v1/sessions', { metadata: { cwd: home } });
    const id = created.body.data.id;
    let enter!: () => void;
    let release!: () => void;
    const entered = new Promise<void>((resolve) => { enter = resolve; });
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const event = phase === 'closing' ? manager.onWillCloseSession! : manager.onWillDeleteSession!;
    const sub = event((event) => {
      if (event.sessionId !== id) return;
      event.waitUntil(gate);
      enter();
    });
    try {
      const deletion = manager.delete(id);
      await entered;
      let recreated = false;
      const creation = manager.create({ sessionId: id, workDir: home! }).then((handle) => {
        recreated = true;
        return handle;
      });
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(recreated).toBe(false);
      release();
      await deletion;
      await creation;
      expect(manager.get(id)).toBeDefined();
    } finally {
      release();
      sub.dispose();
    }
  });

  it('rejects unsupported actions and serves prediction actions with disconnect cancellation', async () => {
    const { body } = await postJson<null>('/api/v1/sessions/sess_missing:delete');
    expect(body.code).toBe(40401);

    const cwd = home as string;
    const created = await postJson<SessionWire>('/api/v1/sessions', { metadata: { cwd } });
    const id = created.body.data.id;
    expect((await postJson<null>(`/api/v1/sessions/${id}:restart`)).body.code).toBe(40001);
    expect((await postJson<null>(`/api/v1/sessions/${id}:abort`)).body.code).toBe(40001);

    const predicted = await postJson<{ prediction: string | null }>(`/api/v1/sessions/${id}:predict-prompt`, {
      prediction_id: 'prediction-1',
      expected_turn_id: 0,
    });
    expect(predicted.body.data).toEqual({ prediction: null });
    const cancelled = await postJson<{ cancelled: boolean }>(`/api/v1/sessions/${id}:cancel-prompt-prediction`, {
      prediction_id: 'prediction-1',
    });
    expect(cancelled.body.data).toEqual({ cancelled: false });

    const session = getLiveSessionById((server as RunningServer).core.accessor, id);
    if (session === undefined) throw new Error('expected live session');
    const service = session.accessor.get(ISessionPromptPredictionService);
    let releasePrediction!: () => void;
    const gate = new Promise<void>((resolve) => {
      releasePrediction = resolve;
    });
    let markPredictionSettled!: () => void;
    const predictionSettled = new Promise<void>((resolve) => {
      markPredictionSettled = resolve;
    });
    const predict = vi.spyOn(service, 'predict').mockImplementation(async () => {
      await gate;
      markPredictionSettled();
      return null;
    });
    const cancel = vi.spyOn(service, 'cancel');
    const cancelledWithReason = await postJson<{ cancelled: boolean }>(`/api/v1/sessions/${id}:cancel-prompt-prediction`, {
      prediction_id: 'visibility-check',
      reason: 'visibility',
    });
    expect(cancelledWithReason.body.data).toEqual({ cancelled: false });
    expect(cancel).toHaveBeenCalledWith('visibility-check', 'visibility');
    const cancelledForPlan = await postJson<{ cancelled: boolean }>(`/api/v1/sessions/${id}:cancel-prompt-prediction`, {
      prediction_id: 'plan-check',
      reason: 'plan',
    });
    expect(cancelledForPlan.body.data).toEqual({ cancelled: false });
    expect(cancel).toHaveBeenCalledWith('plan-check', 'plan');
    const abortController = new AbortController();
    const request = fetch(`${base}/api/v1/sessions/${id}:predict-prompt`, {
      method: 'POST',
      headers: authHeaders(server as RunningServer, { 'content-type': 'application/json' }),
      body: JSON.stringify({ prediction_id: 'disconnect-me', expected_turn_id: 0 }),
      signal: abortController.signal,
    } as never).catch(() => undefined);
    await vi.waitFor(() => expect(predict).toHaveBeenCalledOnce());
    abortController.abort();
    await vi.waitFor(() => expect(cancel).toHaveBeenCalledWith('disconnect-me', 'disconnect'));
    releasePrediction();
    await request;
    await predictionSettled;
    await new Promise<void>((resolve) => {
      setImmediate(resolve);
    });
  });

  it('cold-loads a persisted session on :undo and reports an unknown turn instead of 40401', async () => {
    const cwd = home as string;
    const created = await postJson<SessionWire>('/api/v1/sessions', { metadata: { cwd } });
    const id = created.body.data.id;

    await closeSessionById((server as RunningServer).core.accessor, id);

    const res = await postJson<null>(`/api/v1/sessions/${id}:undo`, { turn_id: 't_missing' });
    expect(res.body.code).toBe(40421);
  });

  it('returns 40901 when :undo reports a busy session', async () => {
    const created = await postJson<SessionWire>('/api/v1/sessions', {
      metadata: { cwd: home as string },
    });
    const session = getLiveSessionById((server as RunningServer).core.accessor, created.body.data.id);
    if (session === undefined) throw new Error('expected live session');
    await session.accessor
      .get(IAgentLifecycleService)
      .create({ agentId: MAIN_AGENT_ID });
    const agent = session.accessor.get(IAgentLifecycleService).handleOf(MAIN_AGENT_ID)!;
    await agent.accessor.get(IEventDispatcher).dispatch(new TurnPrompt({
      agentId: MAIN_AGENT_ID,
      input: [{ type: 'text', text: 'first prompt' }],
      origin: { kind: 'user' },
      turnId: 0,
    }));
    await agent.accessor.get(IEventDispatcher).dispatch(new ContextAppendMessage({
      agentId: MAIN_AGENT_ID,
      message: { role: 'user', content: [{ type: 'text', text: 'first prompt' }], origin: { kind: 'user' } },
    }));
    await agent.accessor.get(IEventDispatcher).dispatch(new TurnEnded({ agentId: MAIN_AGENT_ID, turnId: 0, reason: 'completed' }));
    const page = await getJson<ConversationTurnsPage>(`/api/v1/sessions/${created.body.data.id}/agents/main/turns`);
    const undo = vi
      .spyOn(ConversationFeed.prototype, 'undo')
      .mockRejectedValue(new Error2(ErrorCodes.SESSION_BUSY, 'session is busy'));

    try {
      const response = await postJson<null>(
        `/api/v1/sessions/${created.body.data.id}:undo`,
        { turn_id: page.body.data.turns[0]!.turn_id },
      );

      expect(response.body.code).toBe(40901);
    } finally {
      undo.mockRestore();
    }
  });

  it('returns snake_case data beside the deprecated camelCase fields when :undo cannot remove the requested turns', async () => {
    const created = await postJson<SessionWire>('/api/v1/sessions', {
      metadata: { cwd: home as string },
    });
    const session = getLiveSessionById((server as RunningServer).core.accessor, created.body.data.id);
    if (session === undefined) throw new Error('expected live session');
    await session.accessor.get(IAgentLifecycleService).create({ agentId: MAIN_AGENT_ID });
    const undo = vi
      .spyOn(ConversationFeed.prototype, 'undo')
      .mockRejectedValueOnce(new Error2(ErrorCodes.SESSION_UNDO_UNAVAILABLE, 'only 1 turn can be undone', {
        details: { reason: 'insufficient', requestedCount: 2, undoableCount: 1 },
      }))
      .mockRejectedValueOnce(new Error2(ErrorCodes.SESSION_UNDO_UNAVAILABLE, 'turn t_1 does not open with user input'));

    try {
      const limited = await postJson<unknown>(`/api/v1/sessions/${created.body.data.id}:undo`, { turn_id: 't_1' });
      const unexplained = await postJson<unknown>(`/api/v1/sessions/${created.body.data.id}:undo`, { turn_id: 't_1' });

      expect(limited.body.code).toBe(40911);
      expect(limited.body.data).toEqual({
        reason: 'insufficient',
        requested_count: 2,
        undoable_count: 1,
        requestedCount: 2,
        undoableCount: 1,
      });
      expect(unexplained.body.code).toBe(40911);
      expect(unexplained.body.data).toBeNull();
    } finally {
      undo.mockRestore();
    }
  });

  it('returns 40901 when :reload is requested during an active compaction', async () => {
    const created = await postJson<SessionWire>('/api/v1/sessions', {
      metadata: { cwd: home as string },
    });
    const id = created.body.data.id;
    const session = getLiveSessionById((server as RunningServer).core.accessor, id);
    if (session === undefined) throw new Error('expected live session');
    await session.accessor
      .get(IAgentLifecycleService)
      .create({ agentId: MAIN_AGENT_ID });
    const agent = session.accessor.get(IAgentLifecycleService).handleOf(MAIN_AGENT_ID)!;
    const compacting = vi
      .spyOn(agent.accessor.get(IAgentFullCompactionService), 'compacting', 'get')
      .mockReturnValue({} as never);

    try {
      const response = await postJson<null>(`/api/v1/sessions/${id}:reload`);
      expect(response.body.code).toBe(40901);
    } finally {
      compacting.mockRestore();
    }
  });

  it('returns 40910 when :compact is requested while a compaction is already running', async () => {
    const created = await postJson<SessionWire>('/api/v1/sessions', {
      metadata: { cwd: home as string },
    });
    const id = created.body.data.id;
    const session = getLiveSessionById((server as RunningServer).core.accessor, id);
    if (session === undefined) throw new Error('expected live session');
    await session.accessor
      .get(IAgentLifecycleService)
      .create({ agentId: MAIN_AGENT_ID });
    const agent = session.accessor.get(IAgentLifecycleService).handleOf(MAIN_AGENT_ID)!;
    const begin = vi
      .spyOn(agent.accessor.get(IAgentFullCompactionService), 'begin')
      .mockReturnValue(false);

    try {
      const response = await postJson<null>(`/api/v1/sessions/${id}:compact`, { instruction: 'keep the plan' });
      expect(response.body.code).toBe(40910);
      expect(begin).toHaveBeenCalledWith({ source: 'manual', instruction: 'keep the plan' });
    } finally {
      begin.mockRestore();
    }
  });

  it('forks using restored live turn ids and rejects an incompatible source', async () => {
    const steeredParent = await postJson<SessionWire>('/api/v1/sessions', { metadata: { cwd: home } });
    const steeredParentId = steeredParent.body.data.id;
    const steeredSession = getLiveSessionById((server as RunningServer).core.accessor, steeredParentId)!;
    await steeredSession.accessor.get(IAgentLifecycleService).create({ agentId: MAIN_AGENT_ID });
    const steeredMain = steeredSession.accessor.get(IAgentLifecycleService).handleOf(MAIN_AGENT_ID)!;
    const dispatcher = steeredMain.accessor.get(IEventDispatcher);
    const userSteerOrigin = { kind: 'user', inTurn: true } as PromptOrigin;
    const skillSteerOrigin = {
      kind: 'skill_activation',
      activationId: 'activation-fork-steer',
      skillName: 'review',
      trigger: 'model-tool',
      inTurn: true,
    } as PromptOrigin;
    await dispatcher.dispatch(new TurnPrompt({
      agentId: MAIN_AGENT_ID,
      input: [{ type: 'text', text: 'first prompt' }],
      origin: { kind: 'user' },
      turnId: 0,
    }));
    await dispatcher.dispatch(new ContextAppendMessage({
      agentId: MAIN_AGENT_ID,
      message: { role: 'user', content: [{ type: 'text', text: 'first prompt' }], origin: { kind: 'user' } },
    }));
    await dispatcher.dispatch(new TurnSteer({
      agentId: MAIN_AGENT_ID,
      input: [{ type: 'text', text: 'user steer' }],
      origin: userSteerOrigin,
      turnId: 0,
    }));
    await dispatcher.dispatch(new ContextAppendMessage({
      agentId: MAIN_AGENT_ID,
      message: { role: 'user', content: [{ type: 'text', text: 'user steer' }], origin: userSteerOrigin },
    }));
    await dispatcher.dispatch(new TurnSteer({
      agentId: MAIN_AGENT_ID,
      input: [{ type: 'text', text: 'skill steer' }],
      origin: skillSteerOrigin,
      turnId: 0,
    }));
    await dispatcher.dispatch(new ContextAppendMessage({
      agentId: MAIN_AGENT_ID,
      message: { role: 'user', content: [{ type: 'text', text: 'skill steer' }], origin: skillSteerOrigin },
    }));
    await dispatcher.dispatch(new TurnEnded({ agentId: MAIN_AGENT_ID, turnId: 0, reason: 'completed' }));
    await dispatcher.dispatch(new TurnPrompt({
      agentId: MAIN_AGENT_ID,
      input: [{ type: 'text', text: 'second prompt' }],
      origin: { kind: 'user' },
      turnId: 1,
    }));
    await dispatcher.dispatch(new ContextAppendMessage({
      agentId: MAIN_AGENT_ID,
      message: { role: 'user', content: [{ type: 'text', text: 'second prompt' }], origin: { kind: 'user' } },
    }));
    await dispatcher.dispatch(new TurnEnded({ agentId: MAIN_AGENT_ID, turnId: 1, reason: 'completed' }));
    await steeredMain.accessor.get(IWireService).flush();
    await closeSessionById((server as RunningServer).core.accessor, steeredParentId);
    expect(await resumeSessionById((server as RunningServer).core.accessor, steeredParentId)).toBeDefined();

    const sourceTurns = await getJson<ConversationTurnsPage>(`/api/v1/sessions/${steeredParentId}/agents/main/turns`);
    expect(sourceTurns.body.code).toBe(0);
    const liveTurnNumber = sourceTurns.body.data.turns.at(-1)?.turn_number;
    expect(liveTurnNumber).toBe(3);
    const steeredFork = await postJson<SessionWire>(`/api/v1/sessions/${steeredParentId}:fork`, {
      turn_index: liveTurnNumber,
    });
    expect(steeredFork.body.code).toBe(0);
    expect(await resumeSessionById((server as RunningServer).core.accessor, steeredFork.body.data.id)).toBeDefined();
    const forkedTurns = await getJson<ConversationTurnsPage>(
      `/api/v1/sessions/${steeredFork.body.data.id}/agents/main/turns`,
    );
    expect(forkedTurns.body.data.turns.at(-1)?.turn_number).toBe(3);

    const cwd = home as string;
    const parent = await postJson<SessionWire>('/api/v1/sessions', { metadata: { cwd } });
    const parentId = parent.body.data.id;
    const session = getLiveSessionById((server as RunningServer).core.accessor, parentId);
    expect(session).toBeDefined();
    await session!.accessor.get(IAgentLifecycleService).create({ agentId: MAIN_AGENT_ID });
    const main = session!.accessor.get(IAgentLifecycleService).handleOf(MAIN_AGENT_ID)!;
    await main.accessor.get(IWireService).flush();
    const invalid = await postJson<SessionWire>(`/api/v1/sessions/${parentId}:fork`, {
      turn_index: -1,
    });
    expect(invalid.body.code).toBe(40001);
    const forked = await postJson<SessionWire>(`/api/v1/sessions/${parentId}:fork`, {});
    expect(forked.body.code).toBe(0);

    const sessionDir = sessionDirOf(
      (server as RunningServer).core.accessor.get(IBootstrapService).homeDir,
      `sessions/${parent.body.data.workspace_id}`,
      parentId,
    );
    const wirePath = join(sessionDir, 'agents', MAIN_AGENT_ID, 'wire.jsonl');
    const sourceWire = await readFile(wirePath, 'utf8');
    expect(sourceWire).toContain('"min_protocol_version":"1.5"');
    await writeFile(
      wirePath,
      sourceWire
        .replace('"protocol_version":"1.5"', '"protocol_version":"9.9"')
        .replace('"min_protocol_version":"1.5"', '"min_protocol_version":"9.9"'),
    );
    await closeSessionById((server as RunningServer).core.accessor, parentId);
    const rating = await postJson<unknown>(`/api/v1/sessions/${parentId}/rating`, { op: 'evaluate', turn_id: 't0' });
    expect(rating.body.code).toBe(40930);
    const turns = await getJson<unknown>(`/api/v1/sessions/${parentId}/agents/${MAIN_AGENT_ID}/turns`);
    expect(turns.body.code).toBe(40930);
    expect(turns.body.msg).toContain('Upgrade Kimi Code');
    const sliced = await postJson<SessionWire>(`/api/v1/sessions/${parentId}:fork`, {
      turn_index: 999,
    });
    expect(sliced.body.code).toBe(40930);
    expect(sliced.body.msg).toContain('Upgrade Kimi Code');
    const incompatible = await postJson<SessionWire>(`/api/v1/sessions/${parentId}:fork`, {});
    expect(incompatible.body.code).toBe(40930);
    expect(incompatible.body.msg).toBe(
      'This session requires a newer version of Kimi Code. Upgrade Kimi Code to the latest version to read this session.',
    );
    expect(incompatible.body.details).toEqual({ minReaderVersion: '9.9', readerVersion: '1.5' });
  });

  it('forks a session from a request without a body', async () => {
    const cwd = home as string;
    const parent = await postJson<SessionWire>('/api/v1/sessions', { metadata: { cwd } });
    const parentId = parent.body.data.id;
    const session = getLiveSessionById((server as RunningServer).core.accessor, parentId);
    expect(session).toBeDefined();
    await session!.accessor.get(IAgentLifecycleService).create({ agentId: MAIN_AGENT_ID });
    const main = session!.accessor.get(IAgentLifecycleService).handleOf(MAIN_AGENT_ID)!;
    await main.accessor.get(IWireService).flush();

    const forked = await postJson<SessionWire>(`/api/v1/sessions/${parentId}:fork`);

    expect(forked.body.code).toBe(0);
    expect(forked.body.data.id).not.toBe(parentId);
  });

  it('fork clears inherited cron tasks while the source keeps them', async () => {
    const cwd = home as string;
    const parent = await postJson<SessionWire>('/api/v1/sessions', { metadata: { cwd } });
    const parentId = parent.body.data.id;
    const session = getLiveSessionById((server as RunningServer).core.accessor, parentId);
    expect(session).toBeDefined();
    await session!.accessor.get(IAgentLifecycleService).create({ agentId: MAIN_AGENT_ID });
    const main = session!.accessor.get(IAgentLifecycleService).handleOf(MAIN_AGENT_ID)!;
    const loop = main.accessor.get(IAgentLoopService);
    await loop.initializeHistory(historyEntries([
      ...loop.history(),
      {
        role: 'user',
        content: [{ type: 'text', text: 'selected through REST' }],
        origin: { kind: 'user' },
      },
    ]));
    await main.accessor.get(IWireService).flush();
    const cron = main.accessor.get(IAgentCronService);
    const task = cron.addTask({ cron: '0 9 * * *', prompt: 'fork me', recurring: true });

    const forked = await postJson<SessionWire>(`/api/v1/sessions/${parentId}:fork`, {
      turn_index: 0,
    });
    expect(forked.body.code).toBe(0);
    const forkedId = forked.body.data.id;

    expect(getLiveSessionById((server as RunningServer).core.accessor, forkedId)).toBeUndefined();

    const resumed = await resumeSessionById((server as RunningServer).core.accessor, forkedId);
    expect(resumed).toBeDefined();
    const forkedMain = resumed!.accessor.get(IAgentLifecycleService).handleOf(MAIN_AGENT_ID)!;
    expect(forkedMain.accessor.get(IAgentLoopService).history()[0]).toMatchObject({
      role: 'user',
      content: [{ type: 'text', text: 'selected through REST' }],
    });
    const forkedCron = forkedMain.accessor.get(IAgentCronService);
    expect(forkedCron.list()).toEqual([]);
    expect(cron.list().map((t) => ({ id: t.id, prompt: t.prompt }))).toEqual([
      { id: task.id, prompt: 'fork me' },
    ]);
  });

  it.each([
    {
      kind: 'generated',
      title: 'Generated title',
      apply: (metadata: ISessionMetadata) =>
        metadata.setGeneratedTitleIfUncustomized('Generated title', { force: true }),
    },
    {
      kind: 'custom',
      title: 'Custom title',
      apply: (metadata: ISessionMetadata) => metadata.setTitle('Custom title'),
    },
    {
      kind: 'replaceable',
      title: 'Replaceable title',
      apply: (metadata: ISessionMetadata) =>
        metadata.update({ title: 'Replaceable title', titleKind: 'replaceable' }),
    },
  ])('fork with a default title inherits the source titleKind "$kind"', async ({ kind, title, apply }) => {
    const cwd = home as string;
    const parent = await postJson<SessionWire>('/api/v1/sessions', { metadata: { cwd } });
    const parentId = parent.body.data.id;
    const session = getLiveSessionById((server as RunningServer).core.accessor, parentId);
    expect(session).toBeDefined();
    await apply(session!.accessor.get(ISessionMetadata));

    const forked = await postJson<SessionWire>(`/api/v1/sessions/${parentId}:fork`, {});
    expect(forked.body.code).toBe(0);

    const forkedDir = join(home as string, 'sessions', parent.body.data.workspace_id, forked.body.data.id);
    const forkedState = JSON.parse(await readFile(join(forkedDir, 'state.json'), 'utf8'));
    expect(forkedState.title).toBe(`Fork: ${title}`);
    expect(forkedState.titleKind).toBe(kind);
  });

  it('marks a fork with an explicit title as custom regardless of the source titleKind', async () => {
    const cwd = home as string;
    const parent = await postJson<SessionWire>('/api/v1/sessions', { metadata: { cwd } });
    const parentId = parent.body.data.id;
    const session = getLiveSessionById((server as RunningServer).core.accessor, parentId);
    expect(session).toBeDefined();
    await session!.accessor.get(ISessionMetadata).setGeneratedTitleIfUncustomized('Generated title', { force: true });

    const forked = await postJson<SessionWire>(`/api/v1/sessions/${parentId}:fork`, { title: 'Named fork' });
    expect(forked.body.code).toBe(0);

    const forkedDir = join(home as string, 'sessions', parent.body.data.workspace_id, forked.body.data.id);
    const forkedState = JSON.parse(await readFile(join(forkedDir, 'state.json'), 'utf8'));
    expect(forkedState.title).toBe('Named fork');
    expect(forkedState.titleKind).toBe('custom');
  });

  it('undoes a steered turn by its id together with its in-turn steers', async () => {
    const created = await postJson<SessionWire>('/api/v1/sessions', { metadata: { cwd: home } });
    const id = created.body.data.id;
    const session = getLiveSessionById((server as RunningServer).core.accessor, id)!;
    await session.accessor.get(IAgentLifecycleService).create({ agentId: MAIN_AGENT_ID });
    const agent = session.accessor.get(IAgentLifecycleService).handleOf(MAIN_AGENT_ID)!;
    await agent.accessor.get(IEventDispatcher).dispatch(new TurnPrompt({
      agentId: MAIN_AGENT_ID,
      input: [{ type: 'text', text: 'original prompt' }],
      origin: { kind: 'user' },
      turnId: 0,
    }));
    const wire = agent.accessor.get(IWireService);
    await agent.accessor.get(IEventDispatcher).dispatch(new ContextAppendMessage({
      agentId: MAIN_AGENT_ID,
      message: { role: 'user', content: [{ type: 'text', text: 'original prompt' }], origin: { kind: 'user' } },
    }));
    await agent.accessor.get(IEventDispatcher).dispatch(new ContextAppendMessage({
      agentId: MAIN_AGENT_ID,
      message: { role: 'assistant', content: [{ type: 'text', text: 'answer before steer' }], toolCalls: [] },
    }));
    await agent.accessor.get(IEventDispatcher).dispatch(new TurnSteer({
      agentId: MAIN_AGENT_ID,
      input: [{ type: 'text', text: 'steered prompt' }],
      origin: { kind: 'user' },
      turnId: 0,
    }));
    await agent.accessor.get(IEventDispatcher).dispatch(new ContextAppendMessage({
      agentId: MAIN_AGENT_ID,
      message: { role: 'user', content: [{ type: 'text', text: 'steered prompt' }], origin: { kind: 'user' } },
    }));
    await agent.accessor.get(IEventDispatcher).dispatch(new ContextAppendMessage({
      agentId: MAIN_AGENT_ID,
      message: { role: 'assistant', content: [{ type: 'text', text: 'answer after steer' }], toolCalls: [] },
    }));
    await agent.accessor.get(IEventDispatcher).dispatch(new TurnSteer({
      agentId: MAIN_AGENT_ID,
      input: [{ type: 'text', text: 'second steer' }],
      origin: { kind: 'user' },
      turnId: 0,
    }));
    await agent.accessor.get(IEventDispatcher).dispatch(new ContextAppendMessage({
      agentId: MAIN_AGENT_ID,
      message: { role: 'user', content: [{ type: 'text', text: 'second steer' }], origin: { kind: 'user' } },
    }));
    await agent.accessor.get(IEventDispatcher).dispatch(new ContextAppendMessage({
      agentId: MAIN_AGENT_ID,
      message: { role: 'assistant', content: [{ type: 'text', text: 'answer after second steer' }], toolCalls: [] },
    }));
    await agent.accessor.get(IEventDispatcher).dispatch(new TurnEnded({ agentId: MAIN_AGENT_ID, turnId: 0, reason: 'completed' }));
    await wire.flush();
    const path = `/api/v1/sessions/${id}/agents/main/turns`;
    const before = await getJson<ConversationTurnsPage>(path);
    expect(before.body.code).toBe(0);
    const [turn] = before.body.data.turns;
    expect(before.body.data.turns).toHaveLength(1);
    expect(turn!.items.filter((item) => item.type === 'user_message').map((item) => item.placement)).toEqual(['opener', 'steer', 'steer']);

    expect((await postJson<null>(`/api/v1/sessions/${id}:undo`, {})).body.code).toBe(40001);
    expect((await postJson<null>(`/api/v1/sessions/${id}:undo`, { turn_id: 't_missing' })).body.code).toBe(40421);
    const undone = await postJson<{ removed_turn_ids: string[] }>(`/api/v1/sessions/${id}:undo`, { turn_id: turn!.turn_id });
    expect(undone.body).toMatchObject({ code: 0, data: { removed_turn_ids: [turn!.turn_id] } });
    expect((await getJson<ConversationTurnsPage>(path)).body.data.turns).toEqual([]);
  });

  it('undoes a turn only once when two requests race for it', async () => {
    const created = await postJson<SessionWire>('/api/v1/sessions', { metadata: { cwd: home } });
    const id = created.body.data.id;
    const session = getLiveSessionById((server as RunningServer).core.accessor, id)!;
    await session.accessor.get(IAgentLifecycleService).create({ agentId: MAIN_AGENT_ID });
    const agent = session.accessor.get(IAgentLifecycleService).handleOf(MAIN_AGENT_ID)!;
    const dispatcher = agent.accessor.get(IEventDispatcher);
    for (let turnId = 0; turnId < 3; turnId++) {
      await dispatcher.dispatch(new TurnPrompt({
        agentId: MAIN_AGENT_ID,
        input: [{ type: 'text', text: `prompt ${turnId}` }],
        origin: { kind: 'user' },
        turnId,
      }));
      await dispatcher.dispatch(new ContextAppendMessage({
        agentId: MAIN_AGENT_ID,
        message: { role: 'user', content: [{ type: 'text', text: `prompt ${turnId}` }], origin: { kind: 'user' } },
      }));
      await dispatcher.dispatch(new ContextAppendMessage({
        agentId: MAIN_AGENT_ID,
        message: { role: 'assistant', content: [{ type: 'text', text: `answer ${turnId}` }], toolCalls: [] },
      }));
      await dispatcher.dispatch(new TurnEnded({ agentId: MAIN_AGENT_ID, turnId, reason: 'completed' }));
    }
    await agent.accessor.get(IWireService).flush();
    const path = `/api/v1/sessions/${id}/agents/main/turns`;
    const turnIds = (await getJson<ConversationTurnsPage>(path)).body.data.turns.map((turn) => turn.turn_id);
    expect(turnIds).toHaveLength(3);

    const results = await Promise.all([
      postJson<{ removed_turn_ids: string[] }>(`/api/v1/sessions/${id}:undo`, { turn_id: turnIds[2] }),
      postJson<{ removed_turn_ids: string[] }>(`/api/v1/sessions/${id}:undo`, { turn_id: turnIds[2] }),
    ]);

    expect(results.map((result) => result.body.code).toSorted()).toEqual([0, 40421]);
    expect((await getJson<ConversationTurnsPage>(path)).body.data.turns.map((turn) => turn.turn_id)).toEqual(
      turnIds.slice(0, 2),
    );
  });

  it('forks an undo-branched wire self-contained and replays it equivalently', async () => {
    const cwd = home as string;
    const parent = await postJson<SessionWire>('/api/v1/sessions', { metadata: { cwd } });
    const parentId = parent.body.data.id;
    const session = getLiveSessionById((server as RunningServer).core.accessor, parentId);
    expect(session).toBeDefined();
    await session!.accessor.get(IAgentLifecycleService).create({ agentId: MAIN_AGENT_ID });
    const agent = session!.accessor.get(IAgentLifecycleService).handleOf(MAIN_AGENT_ID)!;
    const context = agent.accessor.get(IAgentLoopService);
    const user = (text: string): ContextMessage => ({
      role: 'user',
      content: [{ type: 'text', text }],
      origin: { kind: 'user' },
    });
    const assistant = (text: string): ContextMessage => ({
      role: 'assistant',
      content: [{ type: 'text', text }],
      toolCalls: [],
    });
    const wire = agent.accessor.get(IWireService);
    wire.append({
      type: 'turn.prompt',
      agentId: MAIN_AGENT_ID,
      input: [{ type: 'text', text: 'first prompt' }],
      origin: { kind: 'user' },
      turnId: 0,
    });
    wire.append({ type: 'context.append_message', agentId: MAIN_AGENT_ID, message: user('first prompt') });
    wire.append({ type: 'context.append_message', agentId: MAIN_AGENT_ID, message: assistant('first answer') });
    wire.append({
      type: 'turn.prompt',
      agentId: MAIN_AGENT_ID,
      input: [{ type: 'text', text: 'second prompt' }],
      origin: { kind: 'user' },
      turnId: 1,
    });
    wire.append({ type: 'context.append_message', agentId: MAIN_AGENT_ID, message: user('second prompt') });
    wire.append({ type: 'context.append_message', agentId: MAIN_AGENT_ID, message: assistant('second answer') });
    await agent.accessor.get(IAgentConversationUndoService).undo(1);
    await wire.flush();
    const messageText = (messages: readonly ContextMessage[]) =>
      messages.map((message) =>
        message.content.map((part) => (part.type === 'text' ? part.text : '')).join(''),
      );
    const sourceText = messageText(context.history());
    expect(sourceText).toEqual(['first prompt', 'first answer']);

    const forked = await postJson<SessionWire>(`/api/v1/sessions/${parentId}:fork`, {});
    expect(forked.body.code).toBe(0);
    const forkedId = forked.body.data.id;

    const wireFiles = (await readdir(home as string, { recursive: true })).filter(
      (path) =>
        path.endsWith(join('agents', 'main', 'wire.jsonl')) &&
        (path.includes(parentId) || path.includes(forkedId)),
    );
    const sourceLines = (await readFile(
      join(home as string, wireFiles.find((path) => path.includes(parentId))!),
      'utf8',
    ))
      .trimEnd()
      .split('\n');
    const forkedLines = (await readFile(
      join(home as string, wireFiles.find((path) => path.includes(forkedId))!),
      'utf8',
    ))
      .trimEnd()
      .split('\n');
    const recordType = (line: string) => (JSON.parse(line) as { type: string }).type;
    expect(forkedLines.some((line) => recordType(line) === 'agent.switched')).toBe(true);
    expect(forkedLines.some((line) => line.includes('second prompt'))).toBe(true);
    expect(forkedLines.slice(0, sourceLines.length)).toEqual(sourceLines);
    expect(recordType(forkedLines.at(-1)!)).toBe('forked');

    const resumed = await resumeSessionById((server as RunningServer).core.accessor, forkedId);
    expect(resumed).toBeDefined();
    const forkedContext = resumed!.accessor
      .get(IAgentLifecycleService)
      .handleOf(MAIN_AGENT_ID)!
      .accessor.get(IAgentLoopService);
    expect(messageText(forkedContext.history())).toEqual(sourceText);
  });

  it('continues a paginated attachment read after forking and removing the source file', async () => {
    const parent = await postJson<SessionWire>('/api/v1/sessions', { metadata: { cwd: home as string } });
    const parentId = parent.body.data.id;
    const core = (server as RunningServer).core;
    const session = getLiveSessionById(core.accessor, parentId)!;
    const body = '😀'.repeat(600) + '\n' + Array.from({ length: 30 }, (_, i) => `line ${String(i)} é`).join('\n');
    const output = await mcpResultToExecutableOutput({
      isError: false,
      content: [{ type: 'resource', resource: {
        uri: 'example://report', mimeType: 'text/plain', blob: Buffer.from(body).toString('base64'),
      } }],
    }, 'mcp__example__report', { attachmentStore: session.accessor.get(ISessionMediaStore) });
    const text = renderToolResultForModel(output).map((part) => part.type === 'text' ? part.text : '').join('\n');
    const sourcePath = JSON.parse(/Original attachment saved at: ("[^\n]+")/.exec(text)![1]!) as string;
    const reference = JSON.parse(/Attachment reference: ("[^\n]+")/.exec(text)![1]!) as string;
    const sourceAgents = session.accessor.get(IAgentLifecycleService);
    await sourceAgents.create({ agentId: MAIN_AGENT_ID });
    let reader = sourceAgents.handleOf(MAIN_AGENT_ID)!.accessor.get(IReadTool);
    let args: ReadInput | undefined = { path: reference, max_chars: 1000 };
    const firstExecution = await reader.resolveExecution(args);
    if (firstExecution.isError === true) throw new Error(JSON.stringify(firstExecution.output));
    const first = await firstExecution.execute({ turnId: 1, toolCallId: 'read-first', signal: new AbortController().signal });
    expect(first.isError).not.toBe(true);
    let recovered = (first.output as string).replaceAll(/^\d+\t/gm, '');
    const firstNext = /Next Read: (\{[^\n]*\})/.exec(first.note ?? '')?.[1];
    expect(firstNext).toBeDefined();
    args = ReadInputSchema.parse(JSON.parse(firstNext!));
    expect(args.path).toBe(reference);
    expect(args.column_offset).toBeGreaterThan(0);
    const forked = await postJson<SessionWire>(`/api/v1/sessions/${parentId}:fork`, {});
    expect(forked.body.code).toBe(0);
    await rm(sourcePath);
    const resumed = await resumeSessionById(core.accessor, forked.body.data.id);
    const agents = resumed!.accessor.get(IAgentLifecycleService);
    await agents.create({ agentId: MAIN_AGENT_ID });
    reader = agents.handleOf(MAIN_AGENT_ID)!.accessor.get(IReadTool);
    let pages = 0;
    while (args !== undefined && pages < 80) {
      expect(args.path).toBe(reference);
      const execution = await reader.resolveExecution(args);
      if (execution.isError === true) throw new Error(JSON.stringify(execution.output));
      const read = await execution.execute({ turnId: 1, toolCallId: `read-${String(pages++)}`, signal: new AbortController().signal });
      expect(read.isError).not.toBe(true);
      if ((args.column_offset ?? 0) === 0) recovered += '\n';
      recovered += (read.output as string).replaceAll(/^\d+\t/gm, '');
      const next = /Next Read: (\{[^\n]*\})/.exec(read.note ?? '')?.[1];
      args = next === undefined ? undefined : ReadInputSchema.parse(JSON.parse(next));
    }
    expect(args).toBeUndefined();
    expect(recovered).toBe(body);
  });

  it('fork copies a corrupted source wire without healing it; the fork heals on resume', async () => {
    const cwd = home as string;
    const parent = await postJson<SessionWire>('/api/v1/sessions', { metadata: { cwd } });
    const parentId = parent.body.data.id;
    const session = getLiveSessionById((server as RunningServer).core.accessor, parentId);
    expect(session).toBeDefined();
    await session!.accessor.get(IAgentLifecycleService).create({ agentId: MAIN_AGENT_ID });
    const cron = session!.accessor.get(IAgentLifecycleService).handleOf(MAIN_AGENT_ID)!.accessor.get(IAgentCronService);
    const task = cron.addTask({ cron: '0 9 * * *', prompt: 'survives corruption', recurring: true });
    await closeSessionById((server as RunningServer).core.accessor, parentId);

    const wireRelatives = (await readdir(home as string, { recursive: true })).filter((path) =>
      path.endsWith(join(parentId, 'agents', 'main', 'wire.jsonl')),
    );
    expect(wireRelatives).toHaveLength(1);
    const wirePath = join(home as string, wireRelatives[0]!);
    const originalLines = (await readFile(wirePath, 'utf8'))
      .split('\n')
      .filter((line) => line.length > 0);
    expect(originalLines.length).toBeGreaterThan(1);
    const corrupted = `${[...originalLines, 'GARBAGE'].join('\n')}\n`;
    await writeFile(wirePath, corrupted);

    const forked = await postJson<SessionWire>(`/api/v1/sessions/${parentId}:fork`, {});
    expect(forked.body.code).toBe(0);
    const forkedId = forked.body.data.id;

    expect(await readFile(wirePath, 'utf8')).toBe(corrupted);

    const resumed = await resumeSessionById((server as RunningServer).core.accessor, forkedId);
    expect(resumed).toBeDefined();
    const forkedCron = resumed!.accessor.get(IAgentLifecycleService).handleOf(MAIN_AGENT_ID)!.accessor.get(IAgentCronService);
    expect(forkedCron.list().map((t) => ({ id: t.id, prompt: t.prompt }))).toEqual([
      { id: task.id, prompt: 'survives corruption' },
    ]);
  });

  it('cold-forks a session with hundreds of agents without materializing it', { timeout: 30_000 }, async () => {
    const cwd = home as string;
    const parent = await postJson<SessionWire>('/api/v1/sessions', { metadata: { cwd } });
    const parentId = parent.body.data.id;
    const parentWire = parent.body.data;
    await closeSessionById((server as RunningServer).core.accessor, parentId);

    const sessionDir = join(home as string, 'sessions', parentWire.workspace_id, parentId);
    const statePath = join(sessionDir, 'state.json');
    const state = JSON.parse(await readFile(statePath, 'utf8'));

    const subagentCount = 300;
    const metadataLine = JSON.stringify({ type: 'metadata', protocol_version: '1.5', created_at: 1 });
    const recordLine = (n: number) =>
      JSON.stringify({
        type: 'context.append_message',
        message: {
          role: 'user',
          content: [{ type: 'text', text: `hello ${n}` }],
          toolCalls: [],
          origin: { kind: 'user' },
        },
        time: n,
      });
    const planRevisionLine = JSON.stringify({
      type: 'plan.revision',
      id: 'plan-1',
      version: 2,
      key: 'plan/plan-1/v2.md',
      sha256: 'deadbeef',
      bytes: 128,
      time: 5,
    });

    const agents: Record<string, { homedir: string; type: string; parentAgentId: string | null; labels: Record<string, string> }> = {
      main: {
        homedir: join(sessionDir, 'agents', 'main'),
        type: 'main',
        parentAgentId: null,
        labels: { kind: 'main' },
      },
    };
    await mkdir(join(sessionDir, 'agents', 'main'), { recursive: true });
    await writeFile(
      join(sessionDir, 'agents', 'main', 'wire.jsonl'),
      `${metadataLine}\n${recordLine(2)}\n${planRevisionLine}\n`,
    );
    for (let i = 0; i < subagentCount; i++) {
      const agentId = `agent-${i}`;
      agents[agentId] = {
        homedir: join(sessionDir, 'agents', agentId),
        type: 'sub',
        parentAgentId: 'main',
        labels: { swarm: 'test' },
      };
      const agentDir = join(sessionDir, 'agents', agentId);
      await mkdir(agentDir, { recursive: true });
      if (i === 0) continue;
      await writeFile(
        join(agentDir, 'wire.jsonl'),
        `${metadataLine}\n${recordLine(i)}\n${recordLine(i + 1000)}\n`,
      );
    }
    state.agents = agents;
    state.custom = { origin: 'large-test' };
    await writeFile(statePath, JSON.stringify(state));

    const startedAt = Date.now();
    const forked = await postJson<SessionWire>(`/api/v1/sessions/${parentId}:fork`, {});
    const elapsedMs = Date.now() - startedAt;
    expect(forked.body.code).toBe(0);
    const forkedId = forked.body.data.id;
    process.stdout.write(`fork of ${subagentCount + 1}-agent session completed in ${elapsedMs}ms\n`);

    expect(getLiveSessionById((server as RunningServer).core.accessor, forkedId)).toBeUndefined();

    const forkedDir = join(home as string, 'sessions', parentWire.workspace_id, forkedId);
    const forkedState = JSON.parse(await readFile(join(forkedDir, 'state.json'), 'utf8'));
    expect(forkedState.title).toBe(`Fork: ${parentWire.title || parentId}`);
    expect(forkedState.titleKind).toBeUndefined();
    expect(forkedState.forkedFrom).toBe(parentId);
    expect(forkedState.custom).toEqual({ origin: 'large-test' });
    expect(Object.keys(forkedState.agents)).toHaveLength(subagentCount + 1);
    for (const agentId of ['main', 'agent-0', 'agent-150', `agent-${subagentCount - 1}`]) {
      const entry = forkedState.agents[agentId];
      const source = agents[agentId]!;
      expect(entry.homedir).toBe(join(forkedDir, 'agents', agentId));
      expect(entry.type).toBe(source.type);
      expect(entry.parentAgentId ?? null).toBe(source.parentAgentId);
      expect(entry.labels).toEqual(
        agentId === 'main' ? source.labels : { ...source.labels, parentAgentId: 'main' },
      );
    }

    const mainWire = (await readFile(join(forkedDir, 'agents', 'main', 'wire.jsonl'), 'utf8'))
      .trim()
      .split('\n');
    expect(mainWire.map((line) => JSON.parse(line).type)).toEqual([
      'metadata',
      'context.append_message',
      'plan.revision',
      'forked',
    ]);
    expect(JSON.parse(mainWire[2]!)).toMatchObject({ key: 'plan/plan-1/v2.md' });

    const emptyWire = (await readFile(join(forkedDir, 'agents', 'agent-0', 'wire.jsonl'), 'utf8'))
      .trim()
      .split('\n');
    expect(emptyWire.map((line) => JSON.parse(line).type)).toEqual(['metadata', 'forked']);

    const sampledWire = (await readFile(join(forkedDir, 'agents', 'agent-150', 'wire.jsonl'), 'utf8'))
      .trim()
      .split('\n');
    expect(sampledWire.map((line) => JSON.parse(line).type)).toEqual([
      'metadata',
      'context.append_message',
      'context.append_message',
      'forked',
    ]);

    const listed = await getJson<SessionWire>(`/api/v1/sessions/${forkedId}`);
    expect(listed.body.code).toBe(0);

    const resumed = await resumeSessionById((server as RunningServer).core.accessor, forkedId);
    expect(resumed).toBeDefined();
    expect(resumed!.accessor.get(IAgentLifecycleService).handleOf(MAIN_AGENT_ID)).toBeDefined();
  });

  it('keeps cron tasks across a server restart through the wire', async () => {
    const cwd = home as string;
    const parent = await postJson<SessionWire>('/api/v1/sessions', { metadata: { cwd } });
    const parentId = parent.body.data.id;
    const session = getLiveSessionById((server as RunningServer).core.accessor, parentId);
    expect(session).toBeDefined();
    await session!.accessor.get(IAgentLifecycleService).create({ agentId: MAIN_AGENT_ID });
    const task = session!.accessor
      .get(IAgentLifecycleService)
      .handleOf(MAIN_AGENT_ID)!
      .accessor.get(IAgentCronService)
      .addTask({ cron: '0 9 * * *', prompt: 'restart me', recurring: true });

    await (server as RunningServer).close();
    server = await startServer({
      hostIdentity: TEST_HOST_IDENTITY,
      host: '127.0.0.1',
      port: 0,
      homeDir: home,
      logLevel: 'silent',
      debugEndpoints: true,
    });
    base = `http://127.0.0.1:${server.port}`;

    const resumed = await (server as RunningServer).core.accessor
      .get(ISessionManager)
      .resume(parentId);
    expect(resumed).toBeDefined();
    const resumedManager = resumed!.accessor.get(IAgentLifecycleService);
    const cron = resumedManager.handleOf(MAIN_AGENT_ID)!.accessor.get(IAgentCronService);
    expect(cron.list().map((t) => ({ id: t.id, prompt: t.prompt }))).toEqual([
      { id: task.id, prompt: 'restart me' },
    ]);
  });

  it('migrates a legacy ACP binding to local and keeps file tools working across restarts', async () => {
    const cwd = home as string;
    const created = await postJson<SessionWire>('/api/v1/sessions', { metadata: { cwd } });
    const sessionId = created.body.data.id;
    const session = getLiveSessionById((server as RunningServer).core.accessor, sessionId);
    await session!.accessor.get(IAgentLifecycleService).create({ agentId: MAIN_AGENT_ID });
    const main = session!.accessor.get(IAgentLifecycleService).handleOf(MAIN_AGENT_ID)!;
    await main.accessor.get(IEventDispatcher).dispatch(new EnvironmentSetBinding({
      agentId: MAIN_AGENT_ID,
      environmentId: `acp:${sessionId}`,
      cwd,
    }));
    const filePath = join(cwd, 'legacy-acp.txt');
    await writeFile(filePath, 'legacy ACP read');

    await (server as RunningServer).close();
    server = await startServer({
      hostIdentity: TEST_HOST_IDENTITY,
      host: '127.0.0.1',
      port: 0,
      homeDir: home,
      logLevel: 'silent',
      debugEndpoints: true,
    });
    base = `http://127.0.0.1:${server.port}`;

    const resumed = await resumeSessionById((server as RunningServer).core.accessor, sessionId);
    const resumedMain = resumed!.accessor.get(IAgentLifecycleService).handleOf(MAIN_AGENT_ID)!;
    const execution = await resumedMain.accessor.get(IReadTool).resolveExecution({ path: filePath });
    expect(execution.isError, JSON.stringify(execution)).not.toBe(true);
    if (execution.isError) return;
    const read = await execution.execute({
      turnId: 1,
      toolCallId: 'read-legacy-acp',
      signal: new AbortController().signal,
    });
    expect(read.isError).not.toBe(true);
    expect(read.output).toContain('legacy ACP read');
    expect(resumedMain.accessor.get(IAgentEnvironmentBindingService).current).toEqual({
      environmentId: 'local',
      cwd,
    });

    await (server as RunningServer).close();
    server = await startServer({
      hostIdentity: TEST_HOST_IDENTITY,
      host: '127.0.0.1',
      port: 0,
      homeDir: home,
      logLevel: 'silent',
      debugEndpoints: true,
    });
    base = `http://127.0.0.1:${server.port}`;
    const resumedAgain = await resumeSessionById((server as RunningServer).core.accessor, sessionId);
    const binding = resumedAgain!.accessor
      .get(IAgentLifecycleService)
      .handleOf(MAIN_AGENT_ID)!
      .accessor.get(IAgentEnvironmentBindingService).current;
    expect(binding).toEqual({ environmentId: 'local', cwd });
  });

  it('keeps a legacy ACP binding when its environment is still registered', async () => {
    const cwd = home as string;
    const created = await postJson<SessionWire>('/api/v1/sessions', { metadata: { cwd } });
    const sessionId = created.body.data.id;
    const environmentId = `acp:${sessionId}`;
    const session = getLiveSessionById((server as RunningServer).core.accessor, sessionId);
    await session!.accessor.get(IAgentLifecycleService).create({ agentId: MAIN_AGENT_ID });
    const main = session!.accessor.get(IAgentLifecycleService).handleOf(MAIN_AGENT_ID)!;
    await main.accessor.get(IEventDispatcher).dispatch(new EnvironmentSetBinding({
      agentId: MAIN_AGENT_ID,
      environmentId,
      cwd,
    }));
    await closeSessionById((server as RunningServer).core.accessor, sessionId);
    const environment = new FakeEnvironment(
      { environmentId, generation: 'legacy-acp-generation' },
      { capabilities: [] },
    );
    const registration = (server as RunningServer).core.accessor.get(IEnvironmentService).register(environment);
    try {
      const resumed = await resumeSessionById((server as RunningServer).core.accessor, sessionId);
      const binding = resumed!.accessor
        .get(IAgentLifecycleService)
        .handleOf(MAIN_AGENT_ID)!
        .accessor.get(IAgentEnvironmentBindingService).current;
      expect(binding).toEqual({ environmentId, cwd });
    } finally {
      await registration.remove();
      await closeSessionById((server as RunningServer).core.accessor, sessionId);
    }
  });

  it('returns an empty warnings list for an existing session', async () => {
    const cwd = home as string;
    const created = await postJson<SessionWire>('/api/v1/sessions', { metadata: { cwd } });
    const { status, body } = await getJson<{ warnings: unknown[] }>(
      `/api/v1/sessions/${created.body.data.id}/warnings`,
    );
    expect(status).toBe(200);
    expect(body.code).toBe(0);
    expect(body.data).toEqual({ warnings: [] });
    expect(sessionWarningsResponseSchema.parse(body.data)).toEqual({ warnings: [] });
  });

  it('returns 40401 for warnings of a missing session', async () => {
    const { body } = await getJson<null>('/api/v1/sessions/sess_missing_warnings/warnings');
    expect(body.code).toBe(40401);
  });

  it('lists only archived sessions with archived_only', async () => {
    const cwd = home as string;
    const a = await postJson<SessionWire>('/api/v1/sessions', { metadata: { cwd } });
    const b = await postJson<SessionWire>('/api/v1/sessions', { metadata: { cwd } });
    expect(a.body.code).toBe(0);
    expect(b.body.code).toBe(0);
    const archivedId = a.body.data.id;
    const liveId = b.body.data.id;

    const archived = await postJson<{ archived: boolean }>(
      `/api/v1/sessions/${archivedId}:archive`,
    );
    expect(archived.body.code).toBe(0);

    const normal = await getJson<PageWire>('/api/v1/sessions');
    expect(normal.body.data.items.some((s) => s.id === liveId)).toBe(true);
    expect(normal.body.data.items.some((s) => s.id === archivedId)).toBe(false);

    const onlyArchived = await getJson<PageWire>('/api/v1/sessions?archived=true');
    expect(onlyArchived.body.code).toBe(0);
    expect(onlyArchived.body.data.items.some((s) => s.id === archivedId)).toBe(true);
    expect(onlyArchived.body.data.items.some((s) => s.id === liveId)).toBe(false);

    const all = await getJson<PageWire>('/api/v1/sessions?archived=all');
    expect(all.body.data.items.some((s) => s.id === liveId)).toBe(true);
    expect(all.body.data.items.some((s) => s.id === archivedId)).toBe(true);
  });

  it('paginates archived=true without returning empty filtered pages', async () => {
    await restartWithFreshHome();
    const cwd = home as string;
    const archivedOlder = await postJson<SessionWire>('/api/v1/sessions', { metadata: { cwd } });
    await postJson<{ archived: boolean }>(
      `/api/v1/sessions/${archivedOlder.body.data.id}:archive`,
    );

    const archivedNewer = await postJson<SessionWire>('/api/v1/sessions', { metadata: { cwd } });
    await postJson<{ archived: boolean }>(
      `/api/v1/sessions/${archivedNewer.body.data.id}:archive`,
    );

    await postJson<SessionWire>('/api/v1/sessions', { metadata: { cwd } });
    await postJson<SessionWire>('/api/v1/sessions', { metadata: { cwd } });

    const first = await getJson<PageWire>('/api/v1/sessions?archived=true&page_size=1');
    expect(first.body.code).toBe(0);
    expect(first.body.data.items).toHaveLength(1);
    expect(first.body.data.items[0]).toMatchObject({
      id: archivedNewer.body.data.id,
      archived: true,
    });
    expect(first.body.data.has_more).toBe(true);

    const second = await getJson<PageWire>(
      `/api/v1/sessions?archived=true&page_size=1&before_id=${archivedNewer.body.data.id}`,
    );
    expect(second.body.code).toBe(0);
    expect(second.body.data.items).toHaveLength(1);
    expect(second.body.data.items[0]).toMatchObject({
      id: archivedOlder.body.data.id,
      archived: true,
    });
    expect(second.body.data.has_more).toBe(false);
  });

  it('keeps the after_id lower bound while paging archived sessions', async () => {
    const cwd = home as string;
    const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

    const archivedOlder = await postJson<SessionWire>('/api/v1/sessions', { metadata: { cwd } });
    await postJson<{ archived: boolean }>(`/api/v1/sessions/${archivedOlder.body.data.id}:archive`);
    await sleep(5);
    for (let i = 0; i < 3; i++) {
      const { body } = await postJson<SessionWire>('/api/v1/sessions', { metadata: { cwd } });
      expect(body.code).toBe(0);
      await sleep(5);
    }
    const archivedNewer = await postJson<SessionWire>('/api/v1/sessions', { metadata: { cwd } });
    await postJson<{ archived: boolean }>(`/api/v1/sessions/${archivedNewer.body.data.id}:archive`);

    const page = await getJson<PageWire>(
      `/api/v1/sessions?archived=true&page_size=2&after_id=${archivedOlder.body.data.id}`,
    );
    expect(page.body.code).toBe(0);
    expect(page.body.data.items.map((s) => s.id)).toEqual([archivedNewer.body.data.id]);
    expect(page.body.data.has_more).toBe(false);
  });

  it('rejects an invalid archived filter value (40001)', async () => {
    const { body } = await getJson<null>('/api/v1/sessions?archived=yes');
    expect(body.code).toBe(40001);
  });

  it('returns a terminal empty page when archived=true busy filtering finds no match', async () => {
    const cwd = home as string;
    const first = await postJson<SessionWire>('/api/v1/sessions', { metadata: { cwd } });
    const second = await postJson<SessionWire>('/api/v1/sessions', { metadata: { cwd } });

    await postJson<{ archived: boolean }>(`/api/v1/sessions/${first.body.data.id}:archive`);
    await postJson<{ archived: boolean }>(`/api/v1/sessions/${second.body.data.id}:archive`);

    const page = await getJson<PageWire>(
      '/api/v1/sessions?archived=true&busy=true&page_size=1',
    );
    expect(page.body.code).toBe(0);
    expect(page.body.data).toEqual({ items: [], total: 0, has_more: false });
  });

  it('returns an empty list for an unknown workspace_id filter', async () => {
    const { body } = await getJson<PageWire>('/api/v1/sessions?workspace_id=wd_missing_000000000000');
    expect(body.code).toBe(0);
    expect(body.data).toEqual({ items: [], total: 0, has_more: false });
  });

  it('lists the union of legacy split buckets for one workspace, in recency order', async () => {
    await restartWithFreshHome();
    const typedRoot = 'C:\\Users\\Foo\\Proj';
    const lowerRoot = 'c:\\users\\foo\\proj';
    const typedId = encodeWorkDirKey(typedRoot);
    const lowerId = encodeWorkDirKey(lowerRoot);
    await writeFile(
      join(home as string, 'projects.json'),
      JSON.stringify({
        schema_version: 2,
        projects: {
          [typedId]: {
            root: typedRoot,
            name: 'proj',
            kind: 'implicit',
            created_at: '2024-01-01T00:00:00.000Z',
            last_opened_at: '2024-01-01T00:00:00.000Z',
          },
          [lowerId]: {
            root: lowerRoot,
            name: 'proj',
            kind: 'implicit',
            created_at: '2024-01-01T00:00:00.000Z',
            last_opened_at: '2024-01-01T00:00:00.000Z',
          },
        },
        deleted_project_ids: [],
      }),
      'utf8',
    );
    const seedBucket = async (wsId: string, sid: string, updatedAt: number): Promise<void> => {
      const dir = join(home as string, 'sessions', wsId, sid);
      await mkdir(dir, { recursive: true });
      await writeFile(
        join(dir, 'state.json'),
        JSON.stringify({ version: 2, cwd: typedRoot, createdAt: 1, updatedAt }),
        'utf8',
      );
    };
    await seedBucket(typedId, 's-typed', 50);
    await seedBucket(lowerId, 's-lower', 60);

    const workspaces = await getJson<{ items: { id: string }[] }>('/api/v1/workspaces');
    const rep = workspaces.body.data.items[0]?.id as string;
    expect([typedId, lowerId]).toContain(rep);

    const listed = await getJson<PageWire>(
      `/api/v1/sessions?workspace_id=${encodeURIComponent(rep)}`,
    );
    expect(listed.body.code).toBe(0);
    expect(listed.body.data.items.map((s) => s.id)).toEqual(['s-lower', 's-typed']);

    const page1 = await getJson<PageWire>(
      `/api/v1/sessions?workspace_id=${encodeURIComponent(rep)}&page_size=1`,
    );
    expect(page1.body.data.items.map((s) => s.id)).toEqual(['s-lower']);
    expect(page1.body.data.has_more).toBe(true);
    const page2 = await getJson<PageWire>(
      `/api/v1/sessions?workspace_id=${encodeURIComponent(rep)}&page_size=1&before_id=s-lower`,
    );
    expect(page2.body.data.items.map((s) => s.id)).toEqual(['s-typed']);
    expect(page2.body.data.has_more).toBe(false);
  });

  it('filters listed sessions by the busy query (post-page, like v1)', async () => {
    const cwd = home as string;
    const created = await postJson<SessionWire>('/api/v1/sessions', { metadata: { cwd } });
    const id = created.body.data.id;
    expect(created.body.data.activity).toBe('idle');

    const idle = await getJson<PageWire>('/api/v1/sessions?busy=false');
    expect(idle.body.code).toBe(0);
    expect(idle.body.data.items.some((s) => s.id === id)).toBe(true);

    const running = await getJson<PageWire>('/api/v1/sessions?busy=true');
    expect(running.body.code).toBe(0);
    expect(running.body.data.items.some((s) => s.id === id)).toBe(false);
  });

  it('finds a busy session behind newer idle ones when paging by the busy query', async () => {
    const cwd = home as string;
    const busy = await postJson<SessionWire>('/api/v1/sessions', { metadata: { cwd } });
    await postJson<SessionWire>('/api/v1/sessions', { metadata: { cwd } });
    const session = getLiveSessionById((server as RunningServer).core.accessor, busy.body.data.id);
    if (session === undefined) throw new Error('expected live session');
    const activity = session.accessor.get(ISessionActivityView);
    const state = vi
      .spyOn(activity, 'state')
      .mockReturnValue({ ...activity.state(), busy: true });

    try {
      const page = await getJson<PageWire>('/api/v1/sessions?busy=true&page_size=1&archived=all');
      expect(page.body.code).toBe(0);
      expect(page.body.data.items.map((s) => s.id)).toEqual([busy.body.data.id]);
      expect(page.body.data.has_more).toBe(false);
    } finally {
      state.mockRestore();
    }
  });

  it('hides a session from lists after its workspace is unregistered while keeping it gettable (gap G3)', async () => {
    const cwd = home as string;
    const created = await postJson<SessionWire>('/api/v1/sessions', {
      title: 'g3',
      metadata: { cwd },
    });
    expect(created.body.code).toBe(0);
    const id = created.body.data.id;
    const workspaceId = created.body.data.workspace_id;

    const del = await deleteJson<{ deleted: boolean }>(`/api/v1/workspaces/${workspaceId}`);
    expect(del.body.code).toBe(0);

    const listed = await getJson<PageWire>('/api/v1/sessions');
    expect(listed.body.code).toBe(0);
    expect(listed.body.data.items.some((session) => session.id === id)).toBe(false);

    const paged = await getJson<PageWire>('/api/v1/sessions?page_size=100');
    expect(paged.body.code).toBe(0);
    expect(paged.body.data.items.some((session) => session.id === id)).toBe(false);

    const got = await getJson<SessionWire>(`/api/v1/sessions/${id}`);
    expect(got.body.code).toBe(0);
    expect(got.body.data.cwd).toBe(cwd);
  });

  it('does not page a deleted managed workspace session into a same-root active project', async () => {
    await restartWithFreshHome();
    const cwd = home as string;
    const activeWorkspace = await postJson<{ id: string }>('/api/v1/workspaces', {
      root: cwd,
      name: 'active',
    });
    const active = await postJson<SessionWire>('/api/v1/sessions', {
      workspace_id: activeWorkspace.body.data.id,
    });
    await new Promise((resolve) => setTimeout(resolve, 5));
    const removedWorkspace = await postJson<{ id: string }>('/api/v1/workspaces', {
      root: cwd,
      name: 'removed',
    });
    const removed = await postJson<SessionWire>('/api/v1/sessions', {
      workspace_id: removedWorkspace.body.data.id,
    });

    const del = await deleteJson<{ deleted: boolean }>(
      `/api/v1/workspaces/${removedWorkspace.body.data.id}`,
    );
    expect(del.body.code).toBe(0);

    const page = await getJson<PageWire>('/api/v1/sessions?page_size=1');
    expect(page.body.code).toBe(0);
    expect(page.body.data.items.map((session) => session.id)).toEqual([active.body.data.id]);
    expect(page.body.data.has_more).toBe(false);

    const got = await getJson<SessionWire>(`/api/v1/sessions/${removed.body.data.id}`);
    expect(got.body.code).toBe(0);
    expect(got.body.data.cwd).toBe(cwd);
  });

  it('merges metadata via profile and keeps cwd authoritative', async () => {
    const cwd = home as string;
    const created = await postJson<SessionWire>('/api/v1/sessions', { metadata: { cwd } });
    const id = created.body.data.id;

    const first = await postJson<ProfileWire>(`/api/v1/sessions/${id}/profile`, {
      metadata: { foo: 'bar' },
    });
    expect(first.body.code).toBe(0);
    expect(first.body.data.session.metadata['foo']).toBe('bar');
    expect(first.body.data.session.cwd).toBe(cwd);

    const got = await getJson<SessionWire>(`/api/v1/sessions/${id}`);
    expect(got.body.data.metadata['foo']).toBe('bar');
    expect(got.body.data.cwd).toBe(cwd);
  });

  it('replaces custom metadata on a second profile update (v1 semantics)', async () => {
    const cwd = home as string;
    const created = await postJson<SessionWire>('/api/v1/sessions', { metadata: { cwd } });
    const id = created.body.data.id;

    await postJson<SessionWire>(`/api/v1/sessions/${id}/profile`, { metadata: { foo: 'bar' } });
    const second = await postJson<ProfileWire>(`/api/v1/sessions/${id}/profile`, {
      metadata: { baz: 1 },
    });
    expect(second.body.code).toBe(0);
    expect(second.body.data.session.metadata['foo']).toBeUndefined();
    expect(second.body.data.session.metadata['baz']).toBe(1);
    expect(second.body.data.session.cwd).toBe(cwd);
  });

  it('applies agent_config.permission_mode via profile idempotently', async () => {
    const cwd = home as string;
    const created = await postJson<SessionWire>('/api/v1/sessions', { metadata: { cwd } });
    const id = created.body.data.id;

    const first = await postJson<SessionWire>(`/api/v1/sessions/${id}/profile`, {
      agent_config: { permission_mode: 'yolo' },
    });
    expect(first.body.code).toBe(0);

    const again = await postJson<SessionWire>(`/api/v1/sessions/${id}/profile`, {
      agent_config: { permission_mode: 'yolo' },
    });
    expect(again.body.code).toBe(0);
  });

  it('guards agent_config.plan_mode so a repeated true does not re-enter', async () => {
    const cwd = home as string;
    const created = await postJson<SessionWire>('/api/v1/sessions', { metadata: { cwd } });
    const id = created.body.data.id;

    const first = await postJson<SessionWire>(`/api/v1/sessions/${id}/profile`, {
      agent_config: { plan_mode: true },
    });
    expect(first.body.code).toBe(0);

    const again = await postJson<SessionWire>(`/api/v1/sessions/${id}/profile`, {
      agent_config: { plan_mode: true },
    });
    expect(again.body.code).toBe(0);
  });

  it('maps goal already_exists from agent_config.goal_objective (40913)', async () => {
    const cwd = home as string;
    const created = await postJson<SessionWire>('/api/v1/sessions', { metadata: { cwd } });
    const id = created.body.data.id;

    const first = await postJson<SessionWire>(`/api/v1/sessions/${id}/profile`, {
      agent_config: { goal_objective: 'ship the feature' },
    });
    expect(first.body.code).toBe(0);

    const dup = await postJson<null>(`/api/v1/sessions/${id}/profile`, {
      agent_config: { goal_objective: 'ship the feature' },
    });
    expect(dup.body.code).toBe(40913);
  });

  it('publishes session.meta.updated on the core bus when renaming via profile', async () => {
    const cwd = home as string;
    const created = await postJson<SessionWire>('/api/v1/sessions', { metadata: { cwd } });
    const id = created.body.data.id;

    const events: { type: string; payload: unknown }[] = [];
    const sub = (server as RunningServer).core.accessor
      .get(IEventService)
      .subscribe((event) => events.push(event as unknown as { type: string; payload: unknown }));

    const updated = await postJson<SessionWire>(`/api/v1/sessions/${id}/profile`, {
      title: 'renamed-via-profile',
    });
    expect(updated.body.code).toBe(0);
    sub.dispose();

    const meta = events.find((e) => e.type === 'session.meta.updated');
    expect(meta).toBeDefined();
    expect((meta?.payload as { title?: string } | undefined)?.title).toBe('renamed-via-profile');
  });

  it('returns 40401 when updating the profile of a missing session', async () => {
    const { body } = await postJson<null>('/api/v1/sessions/sess_missing_profile/profile', {
      title: 'nope',
    });
    expect(body.code).toBe(40401);
  });

  it('derives the session title from the first prompt submitted via /api/v1', async () => {
    await restartWithFreshHome();
    const cwd = home as string;
    await writeFile(join(cwd, 'config.toml'), [
      'default_model = "stub"', '', '[providers.stub]', 'type = "openai"',
      'base_url = "http://127.0.0.1:9999"', 'api_key = "stub"', '',
      '[models.stub]', 'provider = "stub"', 'model = "stub"', 'max_context_size = 1000', '',
    ].join('\n'), 'utf-8');
    const created = await postJson<SessionWire>('/api/v1/sessions', { metadata: { cwd } });
    const id = created.body.data.id;
    expect(created.body.data.title).toBe('');

    const events: { type: string; payload: unknown }[] = [];
    const sub = (server as RunningServer).core.accessor
      .get(IEventService)
      .subscribe((event) => events.push(event as unknown as { type: string; payload: unknown }));

    const submitted = await postJson<{ prompt_id: string; status: string }>(
      `/api/v1/sessions/${id}/prompts`,
      { content: [{ type: 'text', text: 'hello web title' }] },
    );
    expect(submitted.body.code).toBe(0);
    sub.dispose();

    const got = await getJson<SessionWire>(`/api/v1/sessions/${id}`);
    expect(got.body.code).toBe(0);
    expect(got.body.data.title).toBe('hello web title');

    const meta = events.find((e) => e.type === 'session.meta.updated');
    expect(meta).toBeDefined();
    expect((meta?.payload as { title?: string } | undefined)?.title).toBe('hello web title');
  });
});

async function listExportTempDirs(sessionId: string): Promise<string[]> {
  const prefix = `kimi-session-export-${sessionId}-`;
  return (await readdir(tmpdir())).filter((entry) => entry.startsWith(prefix)).toSorted();
}

function readZipEntries(archive: Buffer): Map<string, Buffer> {
  const endSignature = Buffer.from([0x50, 0x4b, 0x05, 0x06]);
  const endOffset = archive.lastIndexOf(endSignature);
  if (endOffset < 0) throw new Error('ZIP end record not found');

  const entryCount = archive.readUInt16LE(endOffset + 10);
  let centralOffset = archive.readUInt32LE(endOffset + 16);
  const entries = new Map<string, Buffer>();

  for (let index = 0; index < entryCount; index += 1) {
    if (archive.readUInt32LE(centralOffset) !== 0x02014b50) {
      throw new Error('Invalid ZIP central directory entry');
    }
    const method = archive.readUInt16LE(centralOffset + 10);
    const compressedSize = archive.readUInt32LE(centralOffset + 20);
    const nameLength = archive.readUInt16LE(centralOffset + 28);
    const extraLength = archive.readUInt16LE(centralOffset + 30);
    const commentLength = archive.readUInt16LE(centralOffset + 32);
    const localOffset = archive.readUInt32LE(centralOffset + 42);
    const name = archive
      .subarray(centralOffset + 46, centralOffset + 46 + nameLength)
      .toString('utf8');

    if (archive.readUInt32LE(localOffset) !== 0x04034b50) {
      throw new Error('Invalid ZIP local entry');
    }
    const localNameLength = archive.readUInt16LE(localOffset + 26);
    const localExtraLength = archive.readUInt16LE(localOffset + 28);
    const dataOffset = localOffset + 30 + localNameLength + localExtraLength;
    const compressed = archive.subarray(dataOffset, dataOffset + compressedSize);
    if (method === 0) entries.set(name, Buffer.from(compressed));
    else if (method === 8) entries.set(name, inflateRawSync(compressed));
    else throw new Error(`Unsupported ZIP compression method: ${method}`);

    centralOffset += 46 + nameLength + extraLength + commentLength;
  }

  return entries;
}

describe('server-v2 /api/v1/sessions status context window', () => {
  let server: RunningServer | undefined;
  let home: string | undefined;
  let base: string;

  beforeAll(async () => {
    home = await mkdtemp(join(tmpdir(), 'kimi-server-v2-status-'));
    await writeFile(
      join(home, 'config.toml'),
      [
        'default_model = "k2"',
        '',
        '[providers.kimi]',
        'type = "kimi"',
        'api_key = "sk-test"',
        'base_url = "https://api.example.test/v1"',
        '',
        '[models.k2]',
        'provider = "kimi"',
        'model = "kimi-k2"',
        'max_context_size = 131072',
        'display_name = "Kimi K2"',
        '',
      ].join('\n'),
      'utf-8',
    );
    server = await startServer({
      hostIdentity: TEST_HOST_IDENTITY,
      host: '127.0.0.1',
      port: 0,
      homeDir: home,
      logLevel: 'silent',
      debugEndpoints: true,
    });
    base = `http://127.0.0.1:${server.port}`;
  });

  afterAll(async () => {
    if (server !== undefined) {
      await server.close();
      server = undefined;
    }
    if (home !== undefined) {
      await new Promise((resolve) => setTimeout(resolve, 25));
      await rm(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 } as never);
      home = undefined;
    }
  });

  async function postJson<T>(
    path: string,
    body?: unknown,
  ): Promise<{ status: number; body: Envelope<T> }> {
    const hasBody = body !== undefined;
    const res = await fetch(`${base}${path}`, {
      method: 'POST',
      headers: authHeaders(
        server as RunningServer,
        hasBody ? { 'content-type': 'application/json' } : {},
      ),
      body: hasBody ? JSON.stringify(body) : undefined,
    } as never);
    return { status: res.status, body: (await res.json()) as Envelope<T> };
  }

  async function getJson<T>(path: string): Promise<{ status: number; body: Envelope<T> }> {
    const res = await fetch(`${base}${path}`, {
      headers: authHeaders(server as RunningServer),
    } as never);
    return { status: res.status, body: (await res.json()) as Envelope<T> };
  }

  it('reports the default model context window before any model is bound', async () => {
    const cwd = home as string;
    const created = await postJson<SessionWire>('/api/v1/sessions', { metadata: { cwd } });
    const session = getLiveSessionById((server as RunningServer).core.accessor, created.body.data.id)!;
    const context = readContextState(await ensureMainAgent(session));
    expect(context?.max_context_tokens).toBe(131072);
    expect(context?.context_tokens).toBe(0);
  });

  it('keeps rejecting model configuration errors other than a removed alias', async () => {
    const cwd = home as string;
    const created = await postJson<SessionWire>('/api/v1/sessions', { metadata: { cwd } });
    const session = getLiveSessionById((server as RunningServer).core.accessor, created.body.data.id)!;
    const agent = await ensureMainAgent(session);
    const loop = agent.accessor.get(IAgentLoopService);
    vi.spyOn(loop, 'resolveModelContext').mockImplementation(() => {
      throw new Error2(ErrorCodes.CONFIG_INVALID, 'provider settings are invalid', { details: { model: 'stub' } });
    });
    expect(() => readContextState(agent)).toThrow('provider settings are invalid');
  });

  it('keeps rejecting a removed model alias for a subagent', async () => {
    const cwd = home as string;
    const created = await postJson<SessionWire>('/api/v1/sessions', { metadata: { cwd } });
    const session = getLiveSessionById((server as RunningServer).core.accessor, created.body.data.id)!;
    const lifecycle = session.accessor.get(IAgentLifecycleService);
    const child = await lifecycle.create({ agentId: 'agent-removed-model' });
    const handle = lifecycle.handleOf(child.agentId)!;
    const loop = handle.accessor.get(IAgentLoopService);
    vi.spyOn(loop, 'getModel').mockReturnValue('removed');
    vi.spyOn(loop, 'resolveModelContext').mockImplementation(() => {
      throw new Error2(ErrorCodes.CONFIG_INVALID, 'Model "removed" is not configured in config.toml.', { details: { model: 'removed' } });
    });
    expect(() => readContextState(handle)).toThrow('Model "removed" is not configured in config.toml.');
  });
});

describe('server-v2 /api/v1/sessions (minidb read model)', () => {
  let server: RunningServer | undefined;
  let home: string | undefined;
  let base: string;

  const READ_MODEL_ENV = 'KIMI_CODE_PERSISTENCE_MINIDB_READMODEL';

  const READ_MODEL_CONFIG = [
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

  beforeAll(async () => {
    process.env[READ_MODEL_ENV] = '1';
    home = await mkdtemp(join(tmpdir(), 'kimi-server-v2-sessions-rm-'));
    await writeFile(join(home, 'config.toml'), READ_MODEL_CONFIG, 'utf8');
    server = await startServer({
      hostIdentity: TEST_HOST_IDENTITY,
      host: '127.0.0.1',
      port: 0,
      homeDir: home,
      logLevel: 'silent',
      debugEndpoints: true,
    });
    base = `http://127.0.0.1:${server.port}`;
  });

  afterAll(async () => {
    process.env[READ_MODEL_ENV] = 'false';
    if (server !== undefined) {
      await server.close();
      server = undefined;
    }
    if (home !== undefined) {
      await new Promise((resolve) => setTimeout(resolve, 25));
      await rm(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 } as never);
      home = undefined;
    }
  });

  async function postJson<T>(
    path: string,
    body?: unknown,
  ): Promise<{ status: number; body: Envelope<T> }> {
    const hasBody = body !== undefined;
    const res = await fetch(`${base}${path}`, {
      method: 'POST',
      headers: authHeaders(
        server as RunningServer,
        hasBody ? { 'content-type': 'application/json' } : {},
      ),
      body: hasBody ? JSON.stringify(body) : undefined,
    } as never);
    return { status: res.status, body: (await res.json()) as Envelope<T> };
  }

  async function getJson<T>(path: string): Promise<{ status: number; body: Envelope<T> }> {
    const res = await fetch(`${base}${path}`, {
      headers: authHeaders(server as RunningServer),
    } as never);
    return { status: res.status, body: (await res.json()) as Envelope<T> };
  }

  async function settleSessionIndexProjection(): Promise<void> {
    const projected = await postJson<null>('/api/v1/debug/sessionIndex/reprojectNow');
    expect(projected.body.code).toBe(0);
    const reconciled = await postJson<null>('/api/v1/debug/sessionIndex/reconcileNow');
    expect(reconciled.body.code).toBe(0);
    await (server as RunningServer).core.accessor.get(ISessionIndexMirror).drain();
  }

  it('prepares the read model at boot and serves immediate reads', async () => {
    const status = await getJson<{ state: string; generation?: number }>(
      '/api/v1/debug/sessionIndex/status',
    );
    expect(status.body.code).toBe(0);
    expect(status.body.data.state).toBe('ready');

    const created = await postJson<SessionWire>('/api/v1/sessions', {
      metadata: { cwd: home as string },
    });
    const id = created.body.data.id;

    await vi.waitFor(
      async () => {
        const listed = await getJson<PageWire>('/api/v1/sessions');
        expect(listed.body.data.items.some((s) => s.id === id)).toBe(true);

        const workspaces = await getJson<{ items: { session_count: number }[] }>(
          '/api/v1/workspaces',
        );
        expect(workspaces.body.data.items[0]?.session_count).toBe(1);

        const paged = await getJson<PageWire>(`/api/v1/sessions?page_size=1&before_id=${id}`);
        expect(paged.body.data.items).toEqual([]);
        expect(paged.body.data.has_more).toBe(false);
      },
      { timeout: 10_000 },
    );

    await settleSessionIndexProjection();

    await postJson<{ archived: boolean }>(`/api/v1/sessions/${id}:archive`);
    const archivedOnly = await getJson<PageWire>('/api/v1/sessions?archived=true');
    expect(archivedOnly.body.data.items.map((s) => s.id)).toEqual([id]);

    await (server as RunningServer).close();
    server = await startServer({
      hostIdentity: TEST_HOST_IDENTITY,
      host: '127.0.0.1',
      port: 0,
      homeDir: home,
      logLevel: 'silent',
      debugEndpoints: true,
    });
    base = `http://127.0.0.1:${server.port}`;
    const relisted = await getJson<PageWire>('/api/v1/sessions?archived=all');
    expect(relisted.body.data.items.map((s) => s.id)).toEqual([id]);
  });

  it('serves session routes from the authoritative store when the read model cannot open', async () => {
    await (server as RunningServer).close();
    server = undefined;
    await rm(join(home as string, 'cache', 'query-store'), { recursive: true, force: true });
    await writeFile(join(home as string, 'cache', 'query-store'), 'sabotage', 'utf8');

    server = await startServer({
      hostIdentity: TEST_HOST_IDENTITY,
      host: '127.0.0.1',
      port: 0,
      homeDir: home,
      logLevel: 'silent',
      debugEndpoints: true,
    });
    base = `http://127.0.0.1:${server.port}`;

    const status = await getJson<{ state: string; reason?: string; degradedCount: number }>(
      '/api/v1/debug/sessionIndex/status',
    );
    expect(status.body.data.state).toBe('degraded');
    expect(status.body.data.degradedCount).toBeGreaterThan(0);

    const created = await postJson<SessionWire>('/api/v1/sessions', {
      metadata: { cwd: home as string },
    });
    expect(created.body.code).toBe(0);
    const id = created.body.data.id;
    const listed = await getJson<PageWire>('/api/v1/sessions');
    expect(listed.body.data.items.some((s) => s.id === id)).toBe(true);
    const fetched = await getJson<{ id: string }>(`/api/v1/sessions/${id}`);
    expect(fetched.body.data.id).toBe(id);
  });
});

describe('server-v2 /api/v1/sessions:btw', () => {
  const mainAnswer = 'The main agent answered with a much longer explanation than the side chat.';
  const sideAnswer = 'Short side answer.';
  let server: RunningServer | undefined;
  let home: string | undefined;
  let base: string;
  let model: FakeModel;
  let sideLane: Lane;
  let mainLane: Lane;

  const asksSideQuestion = (request: RequestFacts): boolean =>
    request.texts('user').some((text) => text.includes('side question'));

  beforeAll(async () => {
    model = await startFakeModel();
    sideLane = model.route('side-chat', asksSideQuestion);
    mainLane = model.route('main-chat', () => true);
    home = await mkdtemp(join(tmpdir(), 'kimi-server-v2-btw-'));
    await writeFile(
      join(home, 'config.toml'),
      [
        'default_model = "fake"',
        '',
        '[providers.fake]',
        'type = "openai"',
        'api_key = "sk-test"',
        `base_url = "${model.baseUrl}"`,
        '',
        '[models.fake]',
        'provider = "fake"',
        'model = "fake-model"',
        'max_context_size = 131072',
        '',
      ].join('\n'),
      'utf-8',
    );
    server = await startServer({
      hostIdentity: TEST_HOST_IDENTITY,
      host: '127.0.0.1',
      port: 0,
      homeDir: home,
      logLevel: 'silent',
      debugEndpoints: true,
    });
    base = `http://127.0.0.1:${server.port}`;
  });

  afterEach(() => {
    model.verify();
  });

  afterAll(async () => {
    if (server !== undefined) {
      await server.close();
      server = undefined;
    }
    await model.close();
    if (home !== undefined) {
      await new Promise((resolve) => setTimeout(resolve, 25));
      await rm(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 } as never);
      home = undefined;
    }
  });

  async function postJson<T>(path: string, body: unknown): Promise<Envelope<T>> {
    const res = await fetch(`${base}${path}`, {
      method: 'POST',
      headers: authHeaders(server as RunningServer, { 'content-type': 'application/json' }),
      body: JSON.stringify(body),
    } as never);
    return (await res.json()) as Envelope<T>;
  }

  async function agentTurns(sessionId: string, agentId: string) {
    const res = await fetch(`${base}/api/v1/sessions/${sessionId}/agents/${agentId}/turns`, {
      headers: authHeaders(server as RunningServer),
    } as never);
    const body = (await res.json()) as Envelope<ConversationTurnsPage>;
    return body.data.turns.filter((turn) => turn.kind === 'agent');
  }

  type AgentTurn = Awaited<ReturnType<typeof agentTurns>>[number];

  function promptOf(turn: AgentTurn): string | undefined {
    const opener = turn.items[0];
    return opener?.type === 'user_message' ? opener.text : undefined;
  }

  function answerOf(turn: AgentTurn): string[] {
    return turn.items.flatMap((item) => (item.type === 'assistant_message' ? [item.text] : []));
  }

  function endOf(turn: AgentTurn): string {
    return turn.status === 'ended' ? turn.outcome ?? 'ended' : turn.status;
  }

  it('keeps the first side chat answer when its prompt starts before anyone reads the fork', async () => {
    const created = await postJson<SessionWire>('/api/v1/sessions', { metadata: { cwd: home } });
    const sessionId = created.data.id;
    await agentTurns(sessionId, 'main');
    mainLane.script(say(mainAnswer));
    await postJson(`/api/v1/sessions/${sessionId}/prompts`, {
      content: [{ type: 'text', text: 'main question' }],
      model: 'fake',
    });
    await vi.waitFor(
      async () => {
        expect((await agentTurns(sessionId, 'main')).map(endOf)).toEqual(['completed']);
      },
      { timeout: 10_000 },
    );

    sideLane.script(held('side-answer', say(sideAnswer)));
    const btw = await postJson<{ agent_id: string }>(`/api/v1/sessions/${sessionId}:btw`, {});
    const agentId = btw.data.agent_id;
    await postJson(`/api/v1/sessions/${sessionId}/prompts`, {
      content: [{ type: 'text', text: 'side question' }],
      agent_id: agentId,
      model: 'fake',
    });
    await agentTurns(sessionId, agentId);
    model.hold('side-answer').release();

    await vi.waitFor(
      async () => {
        const own = (await agentTurns(sessionId, agentId)).filter((turn) => promptOf(turn) === 'side question');
        expect(own.map(endOf)).toEqual(['completed']);
      },
      { timeout: 10_000 },
    );
    await new Promise((resolve) => setTimeout(resolve, 400));
    const turns = await agentTurns(sessionId, agentId);
    const own = turns.filter((turn) => promptOf(turn) === 'side question');
    expect(own).toHaveLength(1);
    expect(answerOf(own[0]!)).toEqual([sideAnswer]);
    expect(new Set(turns.map((turn) => turn.turn_id)).size).toBe(turns.length);
  });
});

describe('POST /api/v1/sessions/{id}:wait and live turns buffer flush', () => {
  let server: RunningServer | undefined;
  let home: string | undefined;
  let base: string;
  let model: FakeModel;
  const releaseModel = (): void => model.hold('model-gate').release();

  beforeAll(async () => {
    model = await startFakeModel();
    home = await mkdtemp(join(tmpdir(), 'kimi-server-v2-wait-'));
    await writeFile(
      join(home, 'config.toml'),
      [
        'default_model = "fake"',
        '',
        '[providers.fake]',
        'type = "openai"',
        'api_key = "sk-test"',
        `base_url = "${model.baseUrl}"`,
        '',
        '[models.fake]',
        'provider = "fake"',
        'model = "fake-model"',
        'max_context_size = 131072',
        '',
      ].join('\n'),
      'utf-8',
    );
    server = await startServer({
      hostIdentity: TEST_HOST_IDENTITY,
      host: '127.0.0.1',
      port: 0,
      homeDir: home,
      logLevel: 'silent',
    });
    base = `http://127.0.0.1:${server.port}`;
  });

  afterAll(async () => {
    releaseModel();
    if (server !== undefined) {
      await server.close();
      server = undefined;
    }
    await model.close();
    if (home !== undefined) {
      await new Promise((resolve) => setTimeout(resolve, 25));
      await rm(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 } as never);
      home = undefined;
    }
  });

  it('returns immediately when idle, times out and flushes in-flight turns while running, wakes on pending approval, and settles on completion', async () => {
    const createRes = await fetch(`${base}/api/v1/sessions`, {
      method: 'POST',
      headers: authHeaders(server as RunningServer, { 'content-type': 'application/json' }),
      body: JSON.stringify({ cwd: home }),
    } as never);
    const sid = ((await createRes.json()) as Envelope<SessionWire>).data.id;

    const idleWaitRes = await fetch(`${base}/api/v1/sessions/${sid}:wait`, {
      method: 'POST',
      headers: authHeaders(server as RunningServer, { 'content-type': 'application/json' }),
      body: JSON.stringify({ timeout_ms: 5000 }),
    } as never);
    const idleWait = (await idleWaitRes.json()) as Envelope<{
      session: SessionWire;
      pending_interactions: unknown[];
      timed_out: boolean;
    }>;
    expect(idleWait.code).toBe(0);
    expect(idleWait.data.timed_out).toBe(false);
    expect(idleWait.data.session.activity).toBe('idle');
    expect(idleWait.data.pending_interactions).toEqual([]);

    model.script(held('model-gate', reply(say('halfway '), say('done')), 1));

    await fetch(`${base}/api/v1/sessions/${sid}/prompts`, {
      method: 'POST',
      headers: authHeaders(server as RunningServer, { 'content-type': 'application/json' }),
      body: JSON.stringify({
        prompt_id: 'p-wait-1',
        content: [{ type: 'text', text: 'stream test' }],
        model: 'fake',
      }),
    } as never);

    const shortWaitRes = await fetch(`${base}/api/v1/sessions/${sid}:wait`, {
      method: 'POST',
      headers: authHeaders(server as RunningServer, { 'content-type': 'application/json' }),
      body: JSON.stringify({ timeout_ms: 80 }),
    } as never);
    const shortWait = (await shortWaitRes.json()) as Envelope<{
      session: SessionWire;
      pending_interactions: unknown[];
      timed_out: boolean;
    }>;
    expect(shortWait.code).toBe(0);
    expect(shortWait.data.timed_out).toBe(true);
    expect(shortWait.data.session.activity).toBe('turn');

    await vi.waitFor(async () => {
      const turnsRes = await fetch(`${base}/api/v1/sessions/${sid}/agents/main/turns`, {
        headers: authHeaders(server as RunningServer),
      } as never);
      const turnsBody = (await turnsRes.json()) as Envelope<ConversationTurnsPage>;
      const last = turnsBody.data.turns.at(-1);
      expect(last?.status).toBe('running');
      const assistant = last?.items.find((i) => i.type === 'assistant_message');
      expect(assistant && 'text' in assistant ? assistant.text : '').toContain('halfway ');
    });

    const abortCtrl = new AbortController();
    const abortedWait = fetch(`${base}/api/v1/sessions/${sid}:wait`, {
      method: 'POST',
      headers: authHeaders(server as RunningServer, { 'content-type': 'application/json' }),
      body: JSON.stringify({ timeout_ms: 10_000 }),
      signal: abortCtrl.signal,
    } as never).catch(() => 'aborted');
    setTimeout(() => abortCtrl.abort(), 30);
    expect(await abortedWait).toBe('aborted');

    const approvalWaitPromise = fetch(`${base}/api/v1/sessions/${sid}:wait`, {
      method: 'POST',
      headers: authHeaders(server as RunningServer, { 'content-type': 'application/json' }),
      body: JSON.stringify({ timeout_ms: 10_000 }),
    } as never);
    await new Promise((resolve) => setTimeout(resolve, 30));
    const parked = interactions.enqueue({
      id: 'approval_wait_1',
      kind: 'approval',
      payload: {
        toolCallId: 'tc_wait_1',
        toolName: 'Bash',
        action: 'run',
        display: { command: 'echo ok' },
      },
      tags: { agentId: 'main', sessionId: sid, toolCallId: 'tc_wait_1' },
    });

    const approvalWait = (await (await approvalWaitPromise).json()) as Envelope<{
      session: SessionWire;
      pending_interactions: Array<{ interaction_id: string; kind: string }>;
      timed_out: boolean;
    }>;
    expect(approvalWait.code).toBe(0);
    expect(approvalWait.data.timed_out).toBe(false);
    expect(approvalWait.data.pending_interactions.map((i) => i.interaction_id)).toEqual([parked.id]);

    await fetch(`${base}/api/v1/sessions/${sid}/interactions/${parked.id}`, {
      method: 'POST',
      headers: authHeaders(server as RunningServer, { 'content-type': 'application/json' }),
      body: JSON.stringify({ kind: 'approval', decision: 'approved' }),
    } as never);

    const finalWaitPromise = fetch(`${base}/api/v1/sessions/${sid}:wait`, {
      method: 'POST',
      headers: authHeaders(server as RunningServer, { 'content-type': 'application/json' }),
      body: JSON.stringify({ timeout_ms: 10_000 }),
    } as never);
    setTimeout(() => releaseModel(), 30);

    const finalWait = (await (await finalWaitPromise).json()) as Envelope<{
      session: SessionWire;
      pending_interactions: unknown[];
      timed_out: boolean;
    }>;
    expect(finalWait.code).toBe(0);
    expect(finalWait.data.timed_out).toBe(false);
    expect(finalWait.data.session.activity).toBe('idle');
    expect(finalWait.data.pending_interactions).toEqual([]);
    model.verify();
  });
});

const modelFrames: Array<Record<string, unknown>> = [];
const kapTest = base.extend<KapFixtures<RunningServer>>(kapFixtures({
  startServer,
  onFrame(frame) {
    modelFrames.push(frame);
  },
}));
const SLOW_WRITE_MS = 1_000;

kapTest(':wait reports a finished turn only after the session wrote it to disk, even when the disk is slow', { timeout: 30_000 }, async ({ kap, model }) => {
  const storage = kap.server.core.accessor.get(IFileSystemStorageService);
  const append = storage.append.bind(storage);
  storage.append = async (scope, key, data, options) => {
    if (new TextDecoder().decode(data).includes('"type":"turn.ended"')) await slowDisk(SLOW_WRITE_MS);
    return append(scope, key, data, options);
  };
  model.script(say('Saved answer.'));
  const session = await kap.createSession();
  await kap.prompt(session.id, 'Save this turn.');
  expect((await kap.waitIdle(session.id)).activity).toBe('idle');
  const sessionDir = sessionDirOf(kap.server.core.accessor.get(IBootstrapService).homeDir, `sessions/${session.workspace_id}`, session.id);
  const wire = await readFile(join(sessionDir, 'agents', MAIN_AGENT_ID, 'wire.jsonl'), 'utf8');
  expect(wire.split('\n').filter((line) => line !== '').map((line) => (JSON.parse(line) as { type: string }).type)).toContain('turn.ended');
});

kapTest('loads a persisted subagent only when the Agent tool resumes it after a restart', { timeout: 30_000 }, async ({ kap, model }) => {
  model.script(agent({ prompt: 'remember the token', description: 'child' }), say('noted'));
  model.lane('subagent').script(say('remembered'));
  const session = await kap.createSession();
  await kap.prompt(session.id, 'spawn the child');
  await kap.waitIdle(session.id);
  const spawn = (await kap.turns(session.id)).flatMap((turn) => turn.items).find((item) => item.type === 'tool_call' && item['name'] === 'Agent');
  expect(spawn?.['agent_refs']).toEqual([expect.objectContaining({ agent_id: expect.any(String), role: 'child' })]);
  const childId = String((spawn?.['agent_refs'] as readonly { readonly agent_id: string }[] | undefined)?.[0]?.agent_id);

  await kap.restart();
  const resumed = await resumeSessionById(kap.server.core.accessor, session.id);
  expect(resumed).toBeDefined();
  const agents = resumed!.accessor.get(IAgentLifecycleService);
  expect(agents.handleOf(childId)).toBeUndefined();

  model.script(agent({ prompt: 'recall the token', description: 'child again', resume: childId }), say('done'));
  model.lane('subagent').script(say('the token'));
  await kap.prompt(session.id, 'resume the child');
  await kap.waitIdle(session.id);
  expect(agents.handleOf(childId)).toBeDefined();
});

kapTest('reports the project root and where the agent works on every view of a session', { timeout: 30_000 }, async ({ kap }) => {
  const root = kap.home.workspace;
  const packageDir = join(root, 'packages', 'app');
  await mkdir(packageDir, { recursive: true });
  const socket = await kap.connect();
  const created = await kap.rest.post<SessionWire>('/api/v1/sessions', {
    workspace_root: root,
    environment_id: 'local',
    environment_cwd: packageDir,
  });
  const location = { workspace_root: root, cwd: packageDir, environment_id: 'local', environment_cwd: packageDir };

  expect(created).toMatchObject(location);
  expect(await kap.rest.get<SessionWire>(`/api/v1/sessions/${created.id}`)).toMatchObject(location);
  const page = await kap.rest.get<PageWire>('/api/v1/sessions');
  expect(page.items.find((item) => item.id === created.id)).toMatchObject(location);
  expect((await kap.wait(created.id, 0)).session).toMatchObject(location);
  const profile = await kap.rest.post<{ session: SessionWire }>(`/api/v1/sessions/${created.id}/profile`, { title: 'renamed' });
  expect(profile.session).toMatchObject(location);
  const forked = await kap.rest.post<SessionWire>(`/api/v1/sessions/${created.id}:fork`, {});
  expect(forked).toMatchObject({ workspace_root: root, environment_id: 'local', environment_cwd: packageDir });
  await kap.rest.post(`/api/v1/sessions/${created.id}:archive`, {});
  expect(await kap.rest.post<SessionWire>(`/api/v1/sessions/${created.id}:restore`, {})).toMatchObject(location);
  expect(await kap.rest.post<SessionWire>(`/api/v1/sessions/${created.id}:reload`, {})).toMatchObject(location);

  const sessionFrame = (change: string) => socket.waitFor(
    (frame) => frame.type === 'session' && frame['change'] === change && (frame['session'] as SessionWire).id === created.id,
  );
  expect((await sessionFrame('created'))['session']).toMatchObject(location);
  expect((await sessionFrame('updated'))['session']).toMatchObject(location);
});

kapTest('a session whose saved model was removed opens with history and a model error notice', { timeout: 30_000 }, async ({ kap, model }) => {
  model.script(say('history from removed model'));
  const baseConfig = fakeModelConfig(model);
  await kap.writeConfig({
    ...baseConfig,
    defaultModel: 'old',
    models: {
      ...baseConfig.models,
      old: { provider: 'testkit', model: 'old-model', maxContextSize: 100000 },
    },
  });
  await kap.server.core.accessor.get(IConfigService).reload();
  const session = await kap.createSession({ agentConfig: { model: 'old' } });
  await kap.prompt(session.id, 'history from removed model', { model: 'old' });
  await kap.waitIdle(session.id);

  await kap.writeConfig(baseConfig);
  modelFrames.length = 0;
  await kap.restart();
  expect(JSON.stringify(await kap.turns(session.id))).toContain('history from removed model');
  const resumed = await resumeSessionById(kap.server.core.accessor, session.id);
  const main = await ensureMainAgent(resumed!);
  expect(readAgentState(main, false).model).toBeUndefined();
  expect(main.accessor.get(IAgentLoopService).getModel()).toBe('old');

  const first = await kap.connect();
  await first.subscribe(session.id);
  await vi.waitFor(() => {
    expect(modelFrames.filter((frame) => frame['type'] === 'notice')).toHaveLength(1);
  });
  expect(modelFrames.filter((frame) => frame['type'] === 'notice')).toContainEqual(
    expect.objectContaining({ level: 'warning', code: 'model.not_configured', title: 'old' }),
  );
  expect(modelFrames.findIndex((frame) => frame['type'] === 'turns')).toBeLessThan(
    modelFrames.findIndex((frame) => frame['type'] === 'notice'),
  );
  const second = await kap.connect();
  await second.subscribe(session.id);
  await new Promise((resolve) => setTimeout(resolve, 50));
  expect(first.frames.filter((frame) => frame['type'] === 'notice')).toHaveLength(1);
  expect(second.frames.filter((frame) => frame['type'] === 'notice')).toHaveLength(1);
  await first.close();
  await second.close();

  model.script(say('after fallback'));
  await kap.prompt(session.id, 'after fallback', { model: 'testkit' });
  await kap.waitIdle(session.id);
  expect(JSON.parse(model.requests().at(-1)!.rawBody).model).toBe('testkit-model');
});

kapTest('a session with no default model opens with no displayed model and a model error notice', { timeout: 30_000 }, async ({ kap, model }) => {
  model.script(say('history without a default model'));
  const baseConfig = fakeModelConfig(model);
  await kap.writeConfig({
    ...baseConfig,
    defaultModel: 'old',
    models: {
      ...baseConfig.models,
      old: { provider: 'testkit', model: 'old-model', maxContextSize: 100000 },
    },
  });
  await kap.server.core.accessor.get(IConfigService).reload();
  const session = await kap.createSession({ agentConfig: { model: 'old' } });
  await kap.prompt(session.id, 'history without a default model', { model: 'old' });
  await kap.waitIdle(session.id);

  await kap.writeConfig({ ...baseConfig, defaultModel: undefined });
  modelFrames.length = 0;
  await kap.restart();
  expect(JSON.stringify(await kap.turns(session.id))).toContain('history without a default model');
  const resumed = await resumeSessionById(kap.server.core.accessor, session.id);
  const main = await ensureMainAgent(resumed!);
  expect(readAgentState(main, false).model).toBeUndefined();
  expect(readAgentState(main, false).thinking).toBeUndefined();
  expect(main.accessor.get(IAgentLoopService).getModel()).toBe('old');

  const channel = await kap.connect();
  await channel.subscribe(session.id);
  await vi.waitFor(() => {
    expect(modelFrames.filter((frame) => frame['type'] === 'notice')).toHaveLength(1);
  });
  expect(modelFrames.filter((frame) => frame['type'] === 'notice')).toContainEqual(
    expect.objectContaining({ level: 'warning', code: 'model.not_configured', title: 'old' }),
  );
  expect(modelFrames.findIndex((frame) => frame['type'] === 'turns')).toBeLessThan(
    modelFrames.findIndex((frame) => frame['type'] === 'notice'),
  );
  await channel.close();
});

kapTest('reports the outcome of the last turn in the session frame that archives a session', { timeout: 30_000 }, async ({ kap, model }) => {
  const { id } = await kap.createSession();
  model.script(say('Done.'));
  await kap.prompt(id, 'Hello.');
  await kap.waitIdle(id);
  const socket = await kap.connect();

  await kap.rest.post(`/api/v1/sessions/${id}:archive`, {});

  const archived = await socket.waitFor((frame) => frame.type === 'session' && frame['change'] === 'archived');
  expect(archived['session']).toMatchObject({ id, archived: true, activity: 'idle', last_prompt: 'Hello.', last_turn_outcome: 'completed' });
});

interface VanishingDirectory {
  readonly dir: string;
  readonly sessionId: string;
  readonly remove: () => unknown;
  readonly bringBack: () => unknown;
}

async function sessionInWorktree(kap: KapHarness): Promise<VanishingDirectory> {
  const { main, worktree } = await createGitWorktree({
    main: join(kap.home.workspace, 'app'),
    worktree: join(kap.home.workspace, 'app-fix'),
  });
  return {
    dir: worktree,
    sessionId: (await kap.createSession({ cwd: worktree })).id,
    remove: () => git(main, 'worktree', 'remove', '--force', worktree),
    bringBack: () => git(main, 'worktree', 'add', '-q', worktree, 'fix'),
  };
}

async function sessionInManagedFolder(kap: KapHarness): Promise<VanishingDirectory> {
  const dir = join(kap.home.workspace, 'notes');
  await mkdir(dir);
  const project = await kap.rest.post<{ readonly id: string }>('/api/v1/workspaces', { root: dir });
  return {
    dir,
    sessionId: (await kap.rest.post<{ readonly id: string }>('/api/v1/sessions', { workspace_id: project.id })).id,
    remove: () => rm(dir, { recursive: true }),
    bringBack: () => mkdir(dir),
  };
}

const vanishingDirectories = [
  ['a removed worktree', sessionInWorktree],
  ['a deleted folder of a managed project', sessionInManagedFolder],
] as const;

kapTest.for(vanishingDirectories)('opens, renames, restores and forks a session of %s', { timeout: 30_000 }, async ([, start], { kap, model }) => {
  const { dir, sessionId, remove } = await start(kap);
  model.script(say('Written before.'));
  await kap.prompt(sessionId, 'Hello.');
  await kap.waitIdle(sessionId);
  await remove();
  await kap.restart();

  const socket = await kap.connect();
  await socket.subscribe(sessionId);
  expect(socket.turns(sessionId)).toHaveLength(1);
  expect(await kap.turns(sessionId)).toHaveLength(1);
  const path = `/api/v1/sessions/${sessionId}`;
  expect((await kap.rest.get<{ skills: unknown[] }>(`${path}/skills`)).skills).not.toEqual([]);
  expect(await kap.rest.get(`${path}/environment`)).toMatchObject({ environment_id: 'local' });
  await expect(kap.rest.post(`${path}/fs:list`, { path: '.' })).rejects.toMatchObject({ code: 40409 });
  await kap.rest.post(`${path}/profile`, { title: 'Renamed' });
  expect(await kap.session(sessionId)).toMatchObject({ title: 'Renamed', cwd: dir });
  const fork = await kap.fork(sessionId);
  expect(fork.cwd).toBe(dir);
  expect(await kap.turns(fork.id)).toHaveLength(1);
  await kap.rest.post(`${path}:archive`, {});
  expect(await kap.rest.post(`${path}:restore`, {})).toMatchObject({ id: sessionId, archived: false });
  await kap.rest.post(`${path}:delete`, {});
  await expect(kap.session(sessionId)).rejects.toMatchObject({ code: 40401 });
});

kapTest.for(vanishingDirectories)('answers a prompt in a session of %s and works there again once the directory is back', { timeout: 30_000 }, async ([, start], { kap, model }) => {
  const { dir, sessionId, remove, bringBack } = await start(kap);
  await closeSessionById(kap.server.core.accessor, sessionId);
  await remove();
  const run = async (command: string) => {
    const request = model.requests('main').length;
    model.script(bash(command), say('Done.'));
    await kap.prompt(sessionId, 'Where are you?', { permissionMode: 'yolo' });
    await kap.waitIdle(sessionId);
    return model.request(request + 1).view.messages.findLast((message) => message.role === 'tool')?.text.replace(/^Wall time: \d+\.\d{3} seconds\n/, '');
  };

  expect(await run('pwd')).toContain(`cwd ${dir} does not exist`);
  await bringBack();
  expect(await run('pwd -P')).toBe(`${bashPathOf(await realpath(dir))}\n`);
});

kapTest('answers 40401 for a session whose managed project was deleted and creates no project in its place', { timeout: 30_000 }, async ({ kap, model }) => {
  const dir = join(kap.home.workspace, 'notes');
  await mkdir(dir);
  const project = await kap.rest.post<{ readonly id: string }>('/api/v1/workspaces', { root: dir });
  const { id } = await kap.rest.post<{ readonly id: string }>('/api/v1/sessions', { workspace_id: project.id });
  model.script(say('Written before.'));
  await kap.prompt(id, 'Hello.');
  await kap.waitIdle(id);
  await kap.rest.delete(`/api/v1/workspaces/${project.id}`);
  await kap.restart();

  const socket = await kap.connect();
  const path = `/api/v1/sessions/${id}`;
  const gone = { code: 40401 };
  await expect(socket.subscribe(id)).rejects.toMatchObject({ response: gone });
  await expect(kap.turns(id)).rejects.toMatchObject(gone);
  await expect(kap.prompt(id, 'Again.')).rejects.toMatchObject(gone);
  await expect(kap.rest.post(`${path}/profile`, { title: 'Renamed' })).rejects.toMatchObject(gone);
  await expect(kap.rest.get(`${path}/environment`)).rejects.toMatchObject(gone);
  await expect(kap.rest.get(`${path}/skills`)).rejects.toMatchObject(gone);
  await expect(kap.rest.post(`${path}/fs:list`, { path: '.' })).rejects.toMatchObject(gone);
  for (const action of ['fork', 'reload', 'restore', 'delete']) {
    await expect(kap.rest.post(`${path}:${action}`, {}), action).rejects.toMatchObject(gone);
  }
  expect(await kap.rest.get('/api/v1/workspaces')).toMatchObject({ items: [] });
});

import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  IAgentActivityView,
  IAgentGoalService,
  IAgentLifecycleService,
  IAgentRPCService,
  IAgentShellCommandService,
  IAppendLogStore,
  IEventService,
  IPluginService,
  ISessionIndex,
  ISessionLifecycleService,
  ISessionMetadata,
  IWorkspaceRegistry,
} from '@moonshot-ai/agent-core-v2';
import type { ServiceIdentifier } from '@moonshot-ai/agent-core-v2';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { type RunningServer, startServer } from '../src/start';
import { authHeaders } from './helpers/auth';

interface Envelope<T> {
  code: number;
  msg: string;
  data: T;
  request_id: string;
  details?: { path: string; message: string }[];
}

interface SessionMetaWire {
  id: string;
  title?: string;
  lastPrompt?: string;
  createdAt: number;
  updatedAt: number;
  archived: boolean;
}

interface GoalSnapshotWire {
  goalId: string;
  objective: string;
  completionCriterion?: string;
  status: 'active' | 'paused' | 'blocked' | 'complete';
  turnsUsed: number;
  tokensUsed: number;
  wallClockMs: number;
  budget: unknown;
  terminalReason?: string;
}

interface GoalToolResultWire {
  goal: GoalSnapshotWire | null;
}

// Build an `/api/v1/debug` path from a Service token (channel = decorator id) + method
// name — exactly how the typed client composes URLs, so the test never hardcodes
// a channel name that could drift from the token.
function rpc(
  scope: 'core' | 'session' | 'agent',
  service: ServiceIdentifier<unknown>,
  method: string,
  ids: { sid?: string; aid?: string } = {},
): string {
  if (scope === 'core') return `/api/v1/debug/${String(service)}/${method}`;
  if (scope === 'session') return `/api/v1/debug/session/${ids.sid}/${String(service)}/${method}`;
  return `/api/v1/debug/session/${ids.sid}/agent/${ids.aid}/${String(service)}/${method}`;
}

describe('server-v2 /api/v1/debug RPC', () => {
  let server: RunningServer | undefined;
  let home: string | undefined;
  let base: string;

  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), 'kimi-server-v2-rpc-'));
    server = await startServer({ host: '127.0.0.1', port: 0, homeDir: home, logLevel: 'silent', debugEndpoints: true });
    base = `http://127.0.0.1:${server.port}`;
  });

  afterEach(async () => {
    if (server !== undefined) {
      await server.close();
      server = undefined;
    }
    if (home !== undefined) {
      await rm(home, { recursive: true, force: true, maxRetries: 3, retryDelay: 25 } as never);
      home = undefined;
    }
  });

  async function call<T>(
    method: 'GET' | 'POST',
    path: string,
    arg?: unknown,
    token?: string,
  ): Promise<{ status: number; body: Envelope<T> }> {
    const headers: Record<string, string> = {};
    let url = `${base}${path}`;
    const init: { method: string; headers: Record<string, string>; body?: string } = {
      method,
      headers,
    };
    if (method === 'GET') {
      if (arg !== undefined) url += `?arg=${encodeURIComponent(JSON.stringify(arg))}`;
    } else if (arg !== undefined) {
      headers['content-type'] = 'application/json';
      init.body = JSON.stringify(arg);
    }
    // Default to the persistent bearer token — the debug RPC surface is gated by the
    // same credential as every other route.
    const credential = token ?? (server as RunningServer).authTokenService.getToken();
    headers['authorization'] = `Bearer ${credential}`;
    const res = await fetch(url, init);
    return { status: res.status, body: (await res.json()) as Envelope<T> };
  }

  async function createSession(cwd: string): Promise<string> {
    const res = await fetch(`${base}/api/v1/sessions`, {
      method: 'POST',
      headers: authHeaders(server as RunningServer, { 'content-type': 'application/json' }),
      body: JSON.stringify({ metadata: { cwd } }),
    } as never);
    const body = (await res.json()) as Envelope<{ id: string }>;
    expect(body.code).toBe(0);
    return body.data.id;
  }

  // The main agent scope is not created automatically on session creation
  // (server-v2 gap G10); create it here so the agent-scope dispatch resolves.
  async function createMainAgent(sessionId: string): Promise<void> {
    const session = server!.core.accessor.get(ISessionLifecycleService).get(sessionId);
    if (session === undefined) throw new Error(`session ${sessionId} not found`);
    await session.accessor.get(IAgentLifecycleService).create({ agentId: 'main' });
  }

  async function createSubagent(sessionId: string, agentId: string): Promise<void> {
    const session = server!.core.accessor.get(ISessionLifecycleService).get(sessionId);
    if (session === undefined) throw new Error(`session ${sessionId} not found`);
    await session.accessor.get(IAgentLifecycleService).create({ agentId });
  }

  // --- Core scope -----------------------------------------------------------

  it('describes all channels via GET /api/v1/debug/channels', async () => {
    const { status, body } = await call<
      readonly {
        name: string;
        scope: 'app' | 'session' | 'agent';
        methods: readonly {
          name: string;
          kind: 'method' | 'property';
          arity: number;
          params: string;
        }[];
      }[]
    >('GET', '/api/v1/debug/channels');
    expect(status).toBe(200);
    expect(body.code).toBe(0);

    const byName = new Map(body.data.map((c) => [c.name, c]));
    expect(byName.get('sessionIndex')?.scope).toBe('app');
    expect(byName.get('sessionMetadata')?.scope).toBe('session');
    expect(byName.get('agentRPCService')?.scope).toBe('agent');

    const meta = byName.get('sessionMetadata');
    expect(meta?.methods.map((m) => m.name)).toEqual(
      expect.arrayContaining(['read', 'setTitle', 'setArchived']),
    );
    expect(meta?.methods.find((m) => m.name === 'read')).toMatchObject({
      kind: 'method',
      arity: 0,
      params: '',
    });
    // Parameter names come from the declaration source (types are erased).
    expect(meta?.methods.find((m) => m.name === 'setTitle')).toMatchObject({
      arity: 1,
      params: 'title',
    });
    // Framework plumbing stays out of the listing.
    expect(meta?.methods.map((m) => m.name)).not.toContain('dispose');
  });

  it('lists sessions via GET', async () => {
    const { body } = await call<{ items: unknown[]; has_more: boolean }>(
      'GET',
      rpc('core', ISessionIndex, 'list'),
      {},
    );
    expect(body.code).toBe(0);
    expect(Array.isArray(body.data.items)).toBe(true);
  });

  it('creates a workspace and reads it back', async () => {
    const cwd = home as string;
    const created = await call<{ id: string; root: string }>(
      'POST',
      rpc('core', IWorkspaceRegistry, 'createOrTouch'),
      cwd,
    );
    expect(created.body.code).toBe(0);
    expect(created.body.data.root).toBe(cwd);

    const got = await call<{ id: string; root: string }>(
      'GET',
      rpc('core', IWorkspaceRegistry, 'get'),
      created.body.data.id,
    );
    expect(got.body.code).toBe(0);
    expect(got.body.data.root).toBe(cwd);
  });

  it('rejects createOrTouch for a missing root directory (40409)', async () => {
    const missing = join(home as string, 'never-created');
    const { body } = await call<null>(
      'POST',
      rpc('core', IWorkspaceRegistry, 'createOrTouch'),
      missing,
    );
    expect(body.code).toBe(40409);
  });

  it('renames a workspace via update', async () => {
    const cwd = home as string;
    const created = await call<{ id: string; name: string }>(
      'POST',
      rpc('core', IWorkspaceRegistry, 'createOrTouch'),
      cwd,
    );
    const id = created.body.data.id;

    const updated = await call<{ id: string; name: string }>(
      'POST',
      rpc('core', IWorkspaceRegistry, 'update'),
      [id, { name: 'renamed' }],
    );
    expect(updated.body.code).toBe(0);
    expect(updated.body.data.name).toBe('renamed');

    const got = await call<{ id: string; name: string }>(
      'GET',
      rpc('core', IWorkspaceRegistry, 'get'),
      id,
    );
    expect(got.body.data.name).toBe('renamed');
  });

  it('counts active sessions', async () => {
    const cwd = home as string;
    const created = await call<{ id: string }>('POST', rpc('core', IWorkspaceRegistry, 'createOrTouch'), cwd);
    await createSession(cwd);
    const { body } = await call<number>(
      'POST',
      rpc('core', ISessionIndex, 'countActive'),
      [[created.body.data.id]],
    );
    expect(body.code).toBe(0);
    expect(body.data).toBeGreaterThanOrEqual(1);
  });

  // --- Session scope --------------------------------------------------------

  it('reads and updates session metadata', async () => {
    const id = await createSession(home as string);

    const read = await call<SessionMetaWire>('POST', rpc('session', ISessionMetadata, 'read', { sid: id }));
    expect(read.body.code).toBe(0);
    expect(read.body.data.id).toBe(id);

    const set = await call<null>('POST', rpc('session', ISessionMetadata, 'setTitle', { sid: id }), 'renamed');
    expect(set.body.code).toBe(0);

    const read2 = await call<SessionMetaWire>('POST', rpc('session', ISessionMetadata, 'read', { sid: id }));
    expect(read2.body.data.title).toBe('renamed');
  });

  it('reads agent activity state', async () => {
    const id = await createSession(home as string);
    await createMainAgent(id);
    const { body } = await call<{ lifecycle: string }>(
      'POST',
      rpc('agent', IAgentActivityView, 'state', { sid: id, aid: 'main' }),
    );
    expect(body.code).toBe(0);
    expect(body.data.lifecycle).toBe('ready');
  });

  it('archives a session', async () => {
    const id = await createSession(home as string);
    const { body } = await call<null>('POST', rpc('session', ISessionLifecycleService, 'archive', { sid: id }), id);
    expect(body.code).toBe(0);
  });

  // --- Agent scope ----------------------------------------------------------

  it('submits a prompt and returns the turn id', async () => {
    const id = await createSession(home as string);
    await createMainAgent(id);

    const { body } = await call<{ turn_id: number }>(
      'POST',
      rpc('agent', IAgentRPCService, 'prompt', { sid: id, aid: 'main' }),
      { input: [{ type: 'text', text: 'hello' }] },
    );
    expect(body.code).toBe(0);
    expect(body.data.turn_id).toBe(0);
  });

  it('rejects disabledTools before bind without mutating prompt metadata', async () => {
    const id = await createSession(home as string);
    await createMainAgent(id);

    const { body } = await call<null>(
      'POST',
      rpc('agent', IAgentRPCService, 'prompt', { sid: id, aid: 'main' }),
      {
        input: [{ type: 'text', text: 'must not become metadata' }],
        disabledTools: ['Bash'],
      },
    );
    expect(body.code).toBe(40001);

    const metadata = await call<SessionMetaWire>(
      'POST',
      rpc('session', ISessionMetadata, 'read', { sid: id }),
    );
    expect(metadata.body.data.title).toBeUndefined();
    expect(metadata.body.data.lastPrompt).toBeUndefined();
  });

  it('derives the session title and lastPrompt from the first prompt', async () => {
    const id = await createSession(home as string);
    await createMainAgent(id);

    const events: { type: string; payload: unknown }[] = [];
    const sub = (server as RunningServer).core.accessor
      .get(IEventService)
      .subscribe((event) => events.push(event));

    const { body } = await call<{ turn_id: number }>(
      'POST',
      rpc('agent', IAgentRPCService, 'prompt', { sid: id, aid: 'main' }),
      { input: [{ type: 'text', text: 'hello title' }] },
    );
    expect(body.code).toBe(0);
    sub.dispose();

    const meta = await call<SessionMetaWire>('POST', rpc('session', ISessionMetadata, 'read', { sid: id }));
    expect(meta.body.code).toBe(0);
    expect(meta.body.data.title).toBe('hello title');
    expect(meta.body.data.lastPrompt).toBe('hello title');

    const updated = events.find((e) => e.type === 'session.meta.updated');
    expect(updated).toBeDefined();
    const payload = updated?.payload as
      | { title?: string; patch?: { lastPrompt?: string } }
      | undefined;
    expect(payload?.title).toBe('hello title');
    expect(payload?.patch?.lastPrompt).toBe('hello title');
  });

  it('keeps a custom title and only refreshes lastPrompt on a later prompt', async () => {
    const id = await createSession(home as string);
    await createMainAgent(id);

    const renamed = await call<null>('POST', rpc('session', ISessionMetadata, 'setTitle', { sid: id }), 'keep-me');
    expect(renamed.body.code).toBe(0);

    const { body } = await call<{ turn_id: number }>(
      'POST',
      rpc('agent', IAgentRPCService, 'prompt', { sid: id, aid: 'main' }),
      { input: [{ type: 'text', text: 'should not become the title' }] },
    );
    expect(body.code).toBe(0);

    const meta = await call<SessionMetaWire>('POST', rpc('session', ISessionMetadata, 'read', { sid: id }));
    expect(meta.body.code).toBe(0);
    expect(meta.body.data.title).toBe('keep-me');
    expect(meta.body.data.lastPrompt).toBe('should not become the title');
  });

  it('runs a shell command through the shell command service', async () => {
    const id = await createSession(home as string);
    await createMainAgent(id);

    const { body } = await call<{ stdout: string; stderr: string; isError?: boolean }>(
      'POST',
      rpc('agent', IAgentShellCommandService, 'run', { sid: id, aid: 'main' }),
      { command: 'printf hello' },
    );
    expect(body.code).toBe(0);
    expect(body.data.stdout).toBe('hello');
    expect(body.data.stderr).toBe('');
    expect(body.data.isError).not.toBe(true);
  });

  it('controls goals through RPC', async () => {
    const id = await createSession(home as string);
    await createMainAgent(id);

    const created = await call<GoalSnapshotWire>(
      'POST',
      rpc('agent', IAgentGoalService, 'createGoal', { sid: id, aid: 'main' }),
      { objective: 'finish the migration' },
    );
    expect(created.body.code).toBe(0);
    expect(created.body.data).toMatchObject({
      objective: 'finish the migration',
      status: 'active',
    });

    const read = await call<GoalToolResultWire>(
      'GET',
      rpc('agent', IAgentGoalService, 'getGoal', { sid: id, aid: 'main' }),
    );
    expect(read.body.code).toBe(0);
    expect(read.body.data.goal).toMatchObject({
      objective: 'finish the migration',
      status: 'active',
    });

    const paused = await call<GoalSnapshotWire>(
      'POST',
      rpc('agent', IAgentGoalService, 'pauseGoal', { sid: id, aid: 'main' }),
      {},
    );
    expect(paused.body.data.status).toBe('paused');

    const resumed = await call<GoalSnapshotWire>(
      'POST',
      rpc('agent', IAgentGoalService, 'resumeGoal', { sid: id, aid: 'main' }),
      {},
    );
    expect(resumed.body.data.status).toBe('active');

    const cancelled = await call<GoalSnapshotWire>(
      'POST',
      rpc('agent', IAgentGoalService, 'cancelGoal', { sid: id, aid: 'main' }),
      {},
    );
    expect(cancelled.body.code).toBe(0);
    expect(cancelled.body.data.status).toBe('active');

    const afterCancel = await call<GoalToolResultWire>(
      'GET',
      rpc('agent', IAgentGoalService, 'getGoal', { sid: id, aid: 'main' }),
    );
    expect(afterCancel.body.data.goal).toBeNull();
  });

  it('maps goal errors through RPC envelopes', async () => {
    const id = await createSession(home as string);
    await createMainAgent(id);

    await call<GoalSnapshotWire>(
      'POST',
      rpc('agent', IAgentGoalService, 'createGoal', { sid: id, aid: 'main' }),
      { objective: 'first' },
    );
    const duplicate = await call<null>(
      'POST',
      rpc('agent', IAgentGoalService, 'createGoal', { sid: id, aid: 'main' }),
      { objective: 'second' },
    );
    expect(duplicate.body.code).toBe(40913);
  });

  it('rejects reflected goal helper access for subagents', async () => {
    const id = await createSession(home as string);
    await createSubagent(id, 'sub-1');

    const { body } = await call<null>(
      'POST',
      rpc('agent', IAgentGoalService, 'clearInternal', { sid: id, aid: 'sub-1' }),
      'user',
    );

    expect(body.code).toBe(40920);
    expect(body.msg).toBe('Goals are only supported by the main agent');
  });

  it('lists and installs plugins through RPC', async () => {
    const pluginRoot = await mkdtemp(join(tmpdir(), 'server-v2-plugin-source-'));
    try {
      await writeFile(join(pluginRoot, 'deploy.md'), '---\ndescription: Deploy\n---\n\nDeploy body', 'utf8');
      await writeFile(
        join(pluginRoot, 'kimi.plugin.json'),
        JSON.stringify({ name: 'rpc-plugin', commands: ['./deploy.md'] }),
        'utf8',
      );

      const installed = await call<{ id: string }>('POST', rpc('core', IPluginService, 'installPlugin'), { source: pluginRoot });
      expect(installed.body.code).toBe(0);
      expect(installed.body.data.id).toBe('rpc-plugin');

      const listed = await call<readonly { id: string; state: string }[]>('GET', rpc('core', IPluginService, 'listPlugins'));
      expect(listed.body.code).toBe(0);
      expect(listed.body.data).toEqual([
        expect.objectContaining({ id: 'rpc-plugin', state: 'ok' }),
      ]);

      const info = await call<{ id: string }>('POST', rpc('core', IPluginService, 'getPluginInfo'), { id: 'rpc-plugin' });
      expect(info.body.code).toBe(0);
      expect(info.body.data.id).toBe('rpc-plugin');

      const commands = await call<readonly { pluginId: string; name: string }[]>(
        'GET',
        rpc('core', IPluginService, 'listPluginCommands'),
      );
      expect(commands.body.code).toBe(0);
      expect(commands.body.data).toEqual([
        expect.objectContaining({ pluginId: 'rpc-plugin', name: 'deploy' }),
      ]);

      const sessionId = await createSession(home as string);
      await createMainAgent(sessionId);
      const activated = await call<null>(
        'POST',
        rpc('agent', IAgentRPCService, 'activatePluginCommand', { sid: sessionId, aid: 'main' }),
        { pluginId: 'rpc-plugin', commandName: 'deploy', args: 'prod' },
      );
      expect(activated.body.code).toBe(0);
    } finally {
      await rm(pluginRoot, { recursive: true, force: true });
    }
  });

  it('returns 40401 when the agent does not exist', async () => {
    const id = await createSession(home as string);
    const { body } = await call<null>(
      'POST',
      rpc('agent', IAgentRPCService, 'prompt', { sid: id, aid: 'does-not-exist' }),
      { input: [{ type: 'text', text: 'hello' }] },
    );
    expect(body.code).toBe(40401);
    // A missing agent must not be reported as a missing session — the message
    // names the agent (parity with v1's `agent.not_found`).
    expect(body.msg).toBe(`agent does-not-exist not found in session ${id}`);
  });

  // --- cross-scope channel routing -----------------------------------------

  it('routes core / session / agent scopes by channel name', async () => {
    const cwd = home as string;
    await createSession(cwd);

    const listed = await call<{ items: { id: string }[] }>('POST', rpc('core', ISessionIndex, 'list'), {});
    expect(listed.body.code).toBe(0);
    expect(listed.body.data.items.length).toBeGreaterThanOrEqual(1);

    const id = listed.body.data.items[0]!.id;
    const read = await call<SessionMetaWire>('POST', rpc('session', ISessionMetadata, 'read', { sid: id }));
    expect(read.body.code).toBe(0);
    expect(read.body.data.id).toBe(id);
  });

  // --- NFR ------------------------------------------------------------------

  it('rejects unknown method (40001)', async () => {
    const { body } = await call<null>('POST', rpc('core', ISessionIndex, 'nope'));
    expect(body.code).toBe(40001);
  });

  it('rejects unknown service (40001)', async () => {
    const { body } = await call<null>('POST', '/api/v1/debug/does-not-exist/list');
    expect(body.code).toBe(40001);
  });

  it('does not serve a missing method segment', async () => {
    const { status, body } = await call<null>('POST', '/api/v1/debug/sessionIndex');
    expect(status === 404 || body.code !== 0).toBe(true);
  });

  it('rejects unknown session (40401)', async () => {
    const { body } = await call<null>('POST', rpc('session', ISessionMetadata, 'read', { sid: 'nope' }));
    expect(body.code).toBe(40401);
  });

  it('rejects oversized body', async () => {
    // Fastify's default bodyLimit is 1MB; a larger body is rejected. Fastify's
    // body-parser throws a 413 which our global error handler currently wraps
    // as `50001` (HTTP 200) — either way the request is rejected, not served.
    // A valid token is sent so the request reaches the body parser (the auth
    // hook would short-circuit with 401 before reading the body otherwise).
    const huge = 'x'.repeat(2 * 1024 * 1024);
    const token = (server as RunningServer).authTokenService.getToken();
    let rejected = false;
    let code: number | undefined;
    try {
      const res = await fetch(`${base}${rpc('core', ISessionIndex, 'list')}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
        body: JSON.stringify({ big: huge }),
      });
      const body = (await res.json()) as Envelope<null>;
      rejected = res.status === 413 || body.code !== 0;
      code = body.code;
    } catch {
      rejected = true;
    }
    expect(rejected).toBe(true);
    expect(code).not.toBe(0);
  });

  it('surfaces the originating stack trace on error', async () => {
    const { body } = await call<null>('POST', rpc('session', ISessionMetadata, 'read', { sid: 'nope' }));
    // Contract: error envelopes carry the thrown error's stack so operators can
    // locate the source (the 40401 below originates in `dispatch`).
    const json = JSON.stringify(body);
    expect(json).toContain('"stack"');
    expect(json).toContain('dispatch');
  });
});

describe('server-v2 /api/v1/debug RPC auth', () => {
  let server: RunningServer | undefined;
  let home: string | undefined;
  let base: string;
  const token = 'test-secret-token';

  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), 'kimi-server-v2-rpc-auth-'));
    server = await startServer({
      host: '127.0.0.1',
      port: 0,
      homeDir: home,
      logLevel: 'silent',
      rpcToken: token, debugEndpoints: true,
    });
    base = `http://127.0.0.1:${server.port}`;
  });

  afterEach(async () => {
    if (server !== undefined) {
      await server.close();
      server = undefined;
    }
    if (home !== undefined) {
      await rm(home, { recursive: true, force: true, maxRetries: 3, retryDelay: 25 } as never);
      home = undefined;
    }
  });

  it('rejects calls without a token (40101)', async () => {
    const res = await fetch(`${base}${rpc('core', ISessionIndex, 'list')}`, { method: 'POST' });
    expect(res.status).toBe(401);
    const body = (await res.json()) as Envelope<null>;
    expect(body.code).toBe(40101);
  });

  it('accepts calls with the correct rpcToken', async () => {
    const res = await fetch(`${base}${rpc('core', ISessionIndex, 'list')}`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({}),
    });
    const body = (await res.json()) as Envelope<{ items: unknown[] }>;
    expect(body.code).toBe(0);
  });

  it('accepts the persistent token on /api/v1/debug', async () => {
    const persistent = (server as RunningServer).authTokenService.getToken();
    const res = await fetch(`${base}${rpc('core', ISessionIndex, 'list')}`, {
      method: 'POST',
      headers: { authorization: `Bearer ${persistent}`, 'content-type': 'application/json' },
      body: JSON.stringify({}),
    });
    const body = (await res.json()) as Envelope<{ items: unknown[] }>;
    expect(body.code).toBe(0);
  });

  it('rejects a wrong token (40101)', async () => {
    const res = await fetch(`${base}${rpc('core', ISessionIndex, 'list')}`, {
      method: 'POST',
      headers: { authorization: 'Bearer wrong' },
    });
    expect(res.status).toBe(401);
    const body = (await res.json()) as Envelope<null>;
    expect(body.code).toBe(40101);
  });
});

describe('server-v2 /api/v1/debug RPC (dev-only, whitelist-free)', () => {
  let server: RunningServer | undefined;
  let home: string | undefined;
  let base: string;

  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), 'kimi-server-v2-debug-rpc-'));
    server = await startServer({
      host: '127.0.0.1',
      port: 0,
      homeDir: home,
      logLevel: 'silent',
      debugEndpoints: true,
    });
    base = `http://127.0.0.1:${server.port}`;
  });

  afterEach(async () => {
    if (server !== undefined) {
      await server.close();
      server = undefined;
    }
    if (home !== undefined) {
      await rm(home, { recursive: true, force: true, maxRetries: 3, retryDelay: 25 } as never);
      home = undefined;
    }
  });

  async function call<T>(
    method: 'GET' | 'POST',
    path: string,
    arg?: unknown,
  ): Promise<{ status: number; body: Envelope<T> }> {
    const headers: Record<string, string> = {
      authorization: `Bearer ${(server as RunningServer).authTokenService.getToken()}`,
    };
    const init: { method: string; headers: Record<string, string>; body?: string } = {
      method,
      headers,
    };
    if (arg !== undefined) {
      headers['content-type'] = 'application/json';
      init.body = JSON.stringify(arg);
    }
    const res = await fetch(`${base}${path}`, init);
    return { status: res.status, body: (await res.json()) as Envelope<T> };
  }

  it('describes every scoped Service via GET /api/v1/debug/channels', async () => {
    const { status, body } = await call<readonly { name: string; scope: string }[]>(
      'GET',
      '/api/v1/debug/channels',
    );
    expect(status).toBe(200);
    expect(body.code).toBe(0);
    // The debug surface spans the whole
    // scoped DI registry (App + Session + Agent).
    expect(body.data.length).toBeGreaterThan(50);
    const names = body.data.map((c) => c.name);
    // Internal Services are included...
    expect(names).toContain(String(IAppendLogStore));
    // ...alongside the regular ones.
    expect(names).toContain(String(ISessionIndex));
  });

  it('calls a non-whitelisted Service method', async () => {
    const { status, body } = await call(
      'POST',
      `/api/v1/debug/${String(IAppendLogStore)}/flush`,
      [],
    );
    expect(status).toBe(200);
    expect(body.code).toBe(0);
  });

  it('also reaches whitelisted Services by the same wire names', async () => {
    const { body } = await call<{ items: unknown[] }>(
      'POST',
      `/api/v1/debug/${String(ISessionIndex)}/list`,
      [{ limit: 1 }],
    );
    expect(body.code).toBe(0);
    expect(Array.isArray(body.data.items)).toBe(true);
  });

  it('rejects an unknown service with 40001', async () => {
    const { body } = await call('POST', '/api/v1/debug/noSuchService/whatever', []);
    expect(body.code).toBe(40001);
  });

  it('is gated by the same bearer auth as the rest of /api/*', async () => {
    const res = await fetch(`${base}/api/v1/debug/channels`);
    expect(res.status).toBe(401);
  });
});

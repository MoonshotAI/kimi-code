import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { createServer as createHttpServer } from 'node:http';
import { execFile } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

import { describe, expect, it, vi, afterEach } from 'vitest';
import { WebSocket, type RawData } from 'ws';

import { FileTokenStorage } from '@moonshot-ai/kimi-code-oauth';

import {
  ConfigRef,
  createConfig,
  createFeature,
  createMemoryMediaStore,
  createMemoryMediaUploadCache,
  createUserEntry,
  createUserMessage,
  MAIN_AGENT_ID,
  memorySessionSpace,
  createHarness,
  providerCatalog,
  undo as builtinUndo,
  UNKNOWN_CAPABILITY,
  useAgent,
  useAgentTools,
  useProvider,
  type AgentHandle,
  type AppHandle,
  type CatalogModelDefinition,
  type ConfigPersist,
  type FeatureSpec,
  type LlmModel,
  type LlmRequester,
  type Provider,
  type SessionHandle,
  type SessionSpace,
  type ToolDefinition,
  type ToolResult,
} from '@moonshot-ai/agent-core';

import { createHttp, HttpRef, useHttpRoute, type CreateHttpOptions } from '#/feature-http/index';
import { createBtw } from '#/features/btw/index';
import { createCapabilities, type CapabilityEntry } from '#/features/capabilities/index';
import { createCompaction } from '#/features/compaction/index';
import { createFileHistory } from '#/features/fileHistory/index';
import { createFiles } from '#/features/files/index';
import { createGoal, GoalRef } from '#/features/goal/index';
import { createKimi } from '#/features/kimi/index';
import { createMedia } from '#/features/media/index';
import { createSessionIndex } from '#/features/sessionIndex/index';
import {
  interaction,
  InteractionRef,
  INTERACTION_TAG_AGENT_ID,
  INTERACTION_TAG_SESSION_ID,
  INTERACTION_TAG_TOOL_CALL_ID,
  INTERACTION_TAG_TURN_ID,
} from '#/features/interaction/index';
import { createMcp, McpRef } from '#/features/mcp/index';
import { createNodeOsHost, type OsHost, type OsProcess } from '#/features/os/host/index';
import { createPermission, PermissionRef } from '#/features/permission/index';
import { createPlan, PlanRef } from '#/features/plan/index';
import { createPlugin } from '#/features/plugin/index';
import { createSkill } from '#/features/skill/index';
import { createTask } from '#/features/task/index';
import { tokenCounting } from '#/features/tokenCounting/index';
import { usage } from '#/features/usage/index';
import { createWorkspaces, WorkspaceRef } from '#/features/workspaces/index';

const model: LlmModel = { provider: 'test', model: 'test-model', capability: UNKNOWN_CAPABILITY };

const mcpFixturePath = fileURLToPath(new URL('./features/fixtures/fake-mcp-server.mjs', import.meta.url));

const execFileAsync = promisify(execFile);

async function git(cwd: string, ...args: string[]): Promise<string> {
  const { stdout } = await execFileAsync('git', args, { cwd });
  return stdout;
}

type ScriptStep = { text: string } | { toolCall: { name: string; arguments: string } };

let queue: ScriptStep[] = [];
let callSeq = 0;

function createMockRequester(): LlmRequester {
  return {
    generate: async (_config, _content, { onEvent }) => {
      const out = queue.shift() ?? { text: 'done' };
      if ('toolCall' in out) {
        onEvent?.({
          type: 'llm.streaming.part',
          part: {
            type: 'function',
            id: `call-${(callSeq += 1)}`,
            name: out.toolCall.name,
            arguments: out.toolCall.arguments,
          },
        });
      } else {
        onEvent?.({ type: 'llm.streaming.part', part: { type: 'text', text: out.text } });
      }
      onEvent?.({
        type: 'llm.streaming.usage',
        usage: { inputOther: 10, output: 5, inputCacheRead: 0, inputCacheCreation: 0 },
      });
      onEvent?.({ type: 'llm.done' });
    },
  };
}

function bindTestLlm(requester: LlmRequester): FeatureSpec {
  return createFeature('test-llm', {
    agent() {
      const agent = useAgent();
      agent.setConfig({ model });
      agent.setRequester(requester);
    },
  });
}

interface BgHandle {
  readonly signal: AbortSignal;
  settle(text: string): void;
  fail(error: unknown): void;
}

function bindTestBgTool(bg: Map<string, BgHandle>): FeatureSpec {
  const tool: ToolDefinition = {
    name: 'TestBg',
    description: 'test background tool',
    parameters: {
      type: 'object',
      properties: { description: { type: 'string' } },
      additionalProperties: false,
    },
    execute: ({ toolCall, signal, detach }) => {
      detach?.(`bg ack ${toolCall.id}`);
      return new Promise<ToolResult>((resolve, reject) => {
        signal.addEventListener('abort', () => {
          reject(new Error('test bg aborted'));
        });
        bg.set(toolCall.id, {
          signal,
          settle: (text) => {
            resolve({ content: [{ type: 'text', text }] });
          },
          fail: (error) => {
            reject(error);
          },
        });
      });
    },
  };
  return createFeature('test-bg', {
    agent() {
      useAgentTools(tool);
    },
  });
}

const apps: AppHandle[] = [];
const tempDirs: string[] = [];

afterEach(async () => {
  queue = [];
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  await Promise.all(apps.splice(0).map((app) => app.disposeAsync()));
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

interface HttpEnv {
  readonly app: AppHandle;
  readonly origin: string;
  readonly space: SessionSpace;
}

async function mountHttp(features: readonly FeatureSpec[], options: CreateHttpOptions = {}): Promise<HttpEnv> {
  const space = memorySessionSpace();
  const app = createHarness({ space, features: [...features, createHttp(options)] });
  apps.push(app);
  await app.ready();
  const origin = app.resolve(HttpRef).origin;
  if (origin === undefined) throw new Error('http origin unavailable');
  return { app, origin, space };
}

async function tempDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

function fakePersist(initial?: string): { saved: string[]; persist: ConfigPersist } {
  const saved: string[] = [];
  let text = initial;
  return {
    saved,
    persist: {
      load: () => Promise.resolve(text),
      save: (value) => {
        saved.push(value);
        text = value;
        return Promise.resolve();
      },
    },
  };
}

async function openMain(env: HttpEnv, sessionId: string): Promise<SessionHandle> {
  const session = await env.app.open({ sessionId });
  await session.create({ agentId: MAIN_AGENT_ID, systemPrompt: 'test' });
  return session;
}

function runTurn(agent: AgentHandle, text = 'go'): Promise<void> {
  const done = new Promise<void>((resolve) => {
    agent.on('turn.done', () => {
      resolve();
    });
  });
  agent.submit(createUserMessage(text));
  return done;
}

const get = (env: HttpEnv, path: string): Promise<Response> =>
  fetch(`${env.origin}/api/v1${path}`);

const post = (env: HttpEnv, path: string, body?: unknown): Promise<Response> =>
  fetch(`${env.origin}/api/v1${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

const put = (env: HttpEnv, path: string, body?: unknown): Promise<Response> =>
  fetch(`${env.origin}/api/v1${path}`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

const del = (env: HttpEnv, path: string): Promise<Response> =>
  fetch(`${env.origin}/api/v1${path}`, { method: 'DELETE' });

const CATALOG_TOML = `
default_model = "acme/m1"

[providers.acme]
type = "openai"
api_key = "sk-acme"
base_url = "https://api.example.com"

[models."acme/m1"]
provider = "acme"
model = "m1"
max_context_size = 4096
`;

function stubProvider(id: string): Provider {
  return {
    id,
    requesters: {
      openai: {
        generate: async (_config, _content, { onEvent }) => {
          onEvent?.({ type: 'llm.streaming.part', part: { type: 'text', text: 'ok' } });
          onEvent?.({ type: 'llm.done' });
        },
      },
    },
    listModels: () => Promise.resolve([]),
    resolveModel: () => {
      throw new Error('unused');
    },
  };
}

const m1Def: CatalogModelDefinition = {
  provider: 'test',
  model: 'm1',
  capability: { ...UNKNOWN_CAPABILITY, thinking: true, tool_use: true },
  maxContextSize: 4096,
  supportEfforts: ['low', 'high'],
  defaultEffort: 'low',
};

function bindTestProvider(): FeatureSpec {
  return createFeature('test-provider', {
    app() {
      useProvider({
        provider: stubProvider('test'),
        info: { type: 'openai', apiKey: 'sk-test', baseUrl: 'https://test.example.com' },
        models: [m1Def],
      });
    },
  });
}

describe('feature-http facade routes', () => {
  it('serves the health check', async () => {
    const env = await mountHttp([]);
    const response = await get(env, '/healthz');
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ code: 0, msg: 'success', data: { ok: true } });
  });

  it('archives live and cold sessions and projects archived fields', async () => {
    const env = await mountHttp([bindTestLlm(createMockRequester())]);
    await openMain(env, 'ses_live');
    await env.space.create('ses_cold', { title: 'Cold' });

    const archived = await post(env, '/sessions/ses_live:archive');
    expect(archived.status).toBe(200);
    expect(await archived.json()).toMatchObject({ code: 0, data: { archived: true } });

    const patched = await fetch(`${env.origin}/api/v1/sessions/ses_live`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ workspace_id: 'ws_patch' }),
    });
    expect(patched.status).toBe(200);
    expect((await patched.json()).data).toMatchObject({ workspace_id: 'ws_patch' });

    const view = await get(env, '/sessions/ses_live');
    const viewBody = await view.json();
    expect(viewBody.data.archived).toBe(true);
    expect(viewBody.data.workspace_id).toBe('ws_patch');
    expect(Number.isNaN(Date.parse(viewBody.data.archived_at))).toBe(false);

    const cold = await post(env, '/sessions/ses_cold:archive');
    expect(cold.status).toBe(200);
    expect(await cold.json()).toMatchObject({ data: { archived: true } });

    const missing = await post(env, '/sessions/ses_unknown:archive');
    expect(missing.status).toBe(200);
    expect(await missing.json()).toMatchObject({ code: 40401 });
  });

  it('lists sessions with kap pagination, filters and has_more', async () => {
    const env = await mountHttp([bindTestLlm(createMockRequester())]);
    const seed = async (
      id: string,
      updatedAt: string,
      metadata?: Record<string, unknown>,
    ): Promise<void> => {
      await env.space.create(id, { createdAt: updatedAt, updatedAt, metadata });
    };
    await seed('ses_a', '2026-01-01T00:00:00.000Z', { workspaceId: 'ws_1' });
    await seed('ses_b', '2026-01-03T00:00:00.000Z', { workspaceId: 'ws_2' });
    await seed('ses_c', '2026-01-02T00:00:00.000Z', {
      archived: true,
      archived_at: '2026-01-02T01:00:00.000Z',
    });
    const ids = (body: { data: { items: { id: string }[] } }): string[] =>
      body.data.items.map((item) => item.id);

    const all = await (await get(env, '/sessions')).json();
    expect(ids(all)).toEqual(['ses_b', 'ses_a']);
    expect(all.data.has_more).toBe(false);

    const paged = await (await get(env, '/sessions?include_archive=true&page_size=2')).json();
    expect(ids(paged)).toEqual(['ses_b', 'ses_c']);
    expect(paged.data.has_more).toBe(true);

    const before = await (
      await get(env, '/sessions?include_archive=true&page_size=2&before_id=ses_c')
    ).json();
    expect(ids(before)).toEqual(['ses_a']);
    expect(before.data.has_more).toBe(false);

    const after = await (
      await get(env, '/sessions?include_archive=true&page_size=1&after_id=ses_a')
    ).json();
    expect(ids(after)).toEqual(['ses_b']);
    expect(after.data.has_more).toBe(true);

    const unknownCursor = await (await get(env, '/sessions?before_id=ses_ghost')).json();
    expect(unknownCursor.data).toMatchObject({ items: [], has_more: false });

    const archived = await (await get(env, '/sessions?archived_only=true')).json();
    expect(ids(archived)).toEqual(['ses_c']);
    expect(archived.data.has_more).toBe(false);

    const workspace = await (await get(env, '/sessions?include_archive=true&workspace_id=ws_1')).json();
    expect(ids(workspace)).toEqual(['ses_a']);

    const busyOnly = await (await get(env, '/sessions?busy=true')).json();
    expect(busyOnly.data.items).toEqual([]);
    const idleOnly = await (await get(env, '/sessions?busy=false')).json();
    expect(ids(idleOnly)).toEqual(['ses_b', 'ses_a']);

    const mutual = await get(env, '/sessions?before_id=ses_a&after_id=ses_b');
    expect(await mutual.json()).toMatchObject({
      code: 40001,
      msg: 'before_id and after_id are mutually exclusive',
    });
    const archivedConflict = await get(env, '/sessions?archived_only=true&include_archive=true');
    expect(await archivedConflict.json()).toMatchObject({
      code: 40001,
      msg: 'archived_only and include_archive are mutually exclusive',
    });
    for (const bad of ['page_size=0', 'page_size=101', 'page_size=abc']) {
      const invalid = await get(env, `/sessions?${bad}`);
      expect(await invalid.json()).toMatchObject({ code: 40001 });
    }

    const session = await openMain(env, 'ses_live_empty');
    const withEmpty = await (await get(env, '/sessions?exclude_empty=true')).json();
    expect(ids(withEmpty)).toEqual(['ses_b', 'ses_a']);
    const withoutFilter = await (await get(env, '/sessions')).json();
    expect(ids(withoutFilter)).toEqual(['ses_live_empty', 'ses_b', 'ses_a']);
    queue = [{ text: 'hi' }];
    await runTurn(session.get(MAIN_AGENT_ID) as AgentHandle);
    const filled = await (await get(env, '/sessions?exclude_empty=true')).json();
    expect(ids(filled)).toEqual(['ses_live_empty', 'ses_b', 'ses_a']);
  });

  it('projects the kap session view fields for live and cold sessions', async () => {
    const env = await mountHttp([
      interaction,
      tokenCounting,
      usage,
      bindTestLlm(createMockRequester()),
    ]);
    const session = await openMain(env, 'ses_view');
    queue = [{ text: 'hello' }];
    await runTurn(session.get(MAIN_AGENT_ID) as AgentHandle);

    const live = await (await get(env, '/sessions/ses_view')).json();
    expect(live.data).toMatchObject({
      id: 'ses_view',
      title: '',
      busy: false,
      main_turn_active: false,
      pending_interaction: 'none',
      agent_config: { model: 'test-model' },
      permission_rules: [],
      agent_ids: [MAIN_AGENT_ID],
    });
    expect(Number.isNaN(Date.parse(live.data.created_at))).toBe(false);
    expect(Number.isNaN(Date.parse(live.data.updated_at))).toBe(false);
    expect(live.data.message_count).toBeGreaterThan(0);
    expect(live.data.usage).toMatchObject({
      input_tokens: 10,
      output_tokens: 5,
      cache_read_tokens: 0,
      cache_creation_tokens: 0,
      turn_count: 1,
    });

    session.resolve(InteractionRef).enqueue({
      kind: 'approval',
      payload: { toolCallId: 'call-1', toolName: 'Bash', action: 'Approve Bash', display: {} },
      tags: { [INTERACTION_TAG_SESSION_ID]: 'ses_view', [INTERACTION_TAG_AGENT_ID]: MAIN_AGENT_ID },
    });
    const pending = await (await get(env, '/sessions/ses_view')).json();
    expect(pending.data.pending_interaction).toBe('approval');

    await env.space.create('ses_cold_view', { title: 'Cold' });
    const cold = await (await get(env, '/sessions/ses_cold_view')).json();
    expect(cold.data).toMatchObject({
      id: 'ses_cold_view',
      title: 'Cold',
      busy: false,
      main_turn_active: false,
      pending_interaction: 'none',
      agent_config: { model: '' },
      usage: {
        input_tokens: 0,
        output_tokens: 0,
        cache_read_tokens: 0,
        cache_creation_tokens: 0,
        total_cost_usd: 0,
        context_tokens: 0,
        context_limit: 0,
        turn_count: 0,
      },
      message_count: 0,
      agent_ids: [],
    });
    expect(cold.data.created_at).toBe(cold.data.updated_at);
  });

  it('creates sessions with a full agent_config and applies it to the main agent', async () => {
    const env = await mountHttp([
      interaction,
      createConfig({ persist: fakePersist().persist }),
      providerCatalog,
      bindTestProvider(),
      createPermission(),
      createPlan(),
      bindTestLlm(createMockRequester()),
    ]);

    const created = await post(env, '/sessions', {
      session_id: 'ses_cfg',
      title: 'Configured',
      metadata: { cwd: '/project' },
      agent_config: {
        model: 'test/m1',
        thinking: 'high',
        permission_mode: 'yolo',
        plan_mode: true,
        system_prompt: 'ignored',
        tools: ['Bash'],
        mcp_servers: ['fs'],
        swarm_mode: false,
      },
    });
    expect(created.status).toBe(200);
    const body = await created.json();
    expect(body.data).toMatchObject({
      id: 'ses_cfg',
      title: 'Configured',
      agent_config: { model: 'test/m1' },
      agent_ids: [MAIN_AGENT_ID],
    });
    const main = env.app.get('ses_cfg')?.get(MAIN_AGENT_ID);
    expect(main?.resolve(PermissionRef)?.mode()).toBe('yolo');
    await expect(main?.resolve(PlanRef)?.status()).resolves.not.toBeNull();
    const record = await env.space.get('ses_cfg');
    expect(record?.metadata?.['defaultModel']).toBe('test/m1');
    expect(record?.metadata?.['defaultThinking']).toBe('high');

    const unknownModel = await post(env, '/sessions', {
      session_id: 'ses_bad_model',
      agent_config: { model: 'ghost/nope' },
    });
    expect(await unknownModel.json()).toMatchObject({ code: 40413 });

    const invalidMode = await post(env, '/sessions', {
      session_id: 'ses_bad_mode',
      agent_config: { permission_mode: 'bogus' },
    });
    expect(await invalidMode.json()).toMatchObject({ code: 40001 });

    const malformed = await post(env, '/sessions', { session_id: 'ses_bad_cfg', agent_config: 'nope' });
    expect(await malformed.json()).toMatchObject({ code: 40001 });

    const plain = await post(env, '/sessions', { session_id: 'ses_plain' });
    expect((await plain.json()).data).toMatchObject({
      id: 'ses_plain',
      agent_ids: [],
      agent_config: { model: '' },
    });
  });

  it('reads and writes the kap session profile surface', async () => {
    const env = await mountHttp([
      interaction,
      usage,
      createConfig({ persist: fakePersist().persist }),
      providerCatalog,
      bindTestProvider(),
      createPermission(),
      createPlan(),
      createGoal(),
      bindTestLlm(createMockRequester()),
    ]);
    await env.space.create('ses_prof', { title: 'Original', metadata: { cwd: '/project' } });

    const renamed = await post(env, '/sessions/ses_prof/profile', {
      title: 'Renamed',
      metadata: { cwd: '/p2', extra: 1 },
    });
    expect((await renamed.json()).data).toMatchObject({
      id: 'ses_prof',
      title: 'Renamed',
      metadata: { cwd: '/p2', extra: 1 },
      agent_ids: [],
    });

    const configured = await post(env, '/sessions/ses_prof/profile', {
      agent_config: { model: 'test/m1', permission_mode: 'auto', plan_mode: true },
    });
    expect((await configured.json()).data).toMatchObject({
      title: 'Renamed',
      agent_config: { model: 'test/m1' },
      agent_ids: [MAIN_AGENT_ID],
    });
    const main = env.app.get('ses_prof')?.get(MAIN_AGENT_ID);
    expect(main?.resolve(PermissionRef)?.mode()).toBe('auto');
    await expect(main?.resolve(PlanRef)?.status()).resolves.not.toBeNull();

    const listed = ((await (await get(env, '/models')).json()).data.items as { model: string }[])
      .map((item) => item.model);
    expect(listed).toContain('test/m1');
    for (const model of listed) {
      const switched = await post(env, '/sessions/ses_prof/profile', { agent_config: { model } });
      expect(switched.status).toBe(200);
    }
    await post(env, '/sessions/ses_prof/profile', { agent_config: { model: 'test/m1' } });

    const planOff = await post(env, '/sessions/ses_prof/profile', {
      agent_config: { plan_mode: false },
    });
    expect(planOff.status).toBe(200);
    await expect(main?.resolve(PlanRef)?.status()).resolves.toBeNull();

    const goal = await post(env, '/sessions/ses_prof/profile', {
      agent_config: { goal_objective: 'finish the migration' },
    });
    expect(goal.status).toBe(200);
    expect(main?.resolve(GoalRef)?.getGoal().goal).not.toBeNull();

    const duplicateGoal = await post(env, '/sessions/ses_prof/profile', {
      agent_config: { goal_objective: 'again' },
    });
    expect(await duplicateGoal.json()).toMatchObject({ code: 40913 });

    const cancelled = await post(env, '/sessions/ses_prof/profile', {
      agent_config: { goal_control: 'cancel' },
    });
    expect(cancelled.status).toBe(200);
    expect(main?.resolve(GoalRef)?.getGoal().goal).toBeNull();

    const got = await get(env, '/sessions/ses_prof/profile');
    expect((await got.json()).data).toMatchObject({
      id: 'ses_prof',
      title: 'Renamed',
      agent_config: { model: 'test/m1' },
    });

    const missing = await post(env, '/sessions/ses_ghost/profile', { title: 'x' });
    expect(await missing.json()).toMatchObject({ code: 40401 });
    const emptyTitle = await post(env, '/sessions/ses_prof/profile', { title: '' });
    expect(await emptyTitle.json()).toMatchObject({ code: 40001 });
    const unknownModel = await post(env, '/sessions/ses_prof/profile', {
      agent_config: { model: 'ghost/nope' },
    });
    expect(await unknownModel.json()).toMatchObject({ code: 40413 });
  });

  it('serves session warnings projected from config diagnostics', async () => {
    const broken = await mountHttp([
      createConfig({ persist: fakePersist('[unclosed').persist, env: {} }),
      bindTestLlm(createMockRequester()),
    ]);
    await broken.space.create('ses_warn');

    const errored = await get(broken, '/sessions/ses_warn/warnings');
    expect(errored.status).toBe(200);
    const erroredBody = await errored.json();
    expect(erroredBody).toMatchObject({ code: 0, msg: 'success' });
    expect(erroredBody.data.warnings).toEqual([
      {
        code: 'config-diagnostic',
        message: expect.stringContaining('Failed to load config'),
        severity: 'error',
      },
    ]);

    const catalog = await mountHttp([
      createConfig({
        persist: fakePersist(`${CATALOG_TOML}\n[models.broken]\nprovider = "acme"\n`).persist,
        env: {},
      }),
      providerCatalog,
      bindTestLlm(createMockRequester()),
    ]);
    await catalog.space.create('ses_malformed');
    const warned = await get(catalog, '/sessions/ses_malformed/warnings');
    expect((await warned.json()).data.warnings).toEqual(
      expect.arrayContaining([
        {
          code: 'config-diagnostic',
          message: expect.stringContaining("[models] entry 'broken' is missing the 'model' field"),
          severity: 'warning',
        },
      ]),
    );

    const healthy = await mountHttp([
      createConfig({ persist: fakePersist(CATALOG_TOML).persist, env: {} }),
      providerCatalog,
      bindTestLlm(createMockRequester()),
    ]);
    await healthy.space.create('ses_ok');
    const empty = await get(healthy, '/sessions/ses_ok/warnings');
    expect((await empty.json()).data).toEqual({ warnings: [] });

    const missing = await get(healthy, '/sessions/ses_ghost/warnings');
    expect(await missing.json()).toMatchObject({ code: 40401 });

    const bare = await mountHttp([bindTestLlm(createMockRequester())]);
    await bare.space.create('ses_bare');
    const unavailable = await get(bare, '/sessions/ses_bare/warnings');
    expect(await unavailable.json()).toMatchObject({ code: 40941 });
  });

  it('compacts a session and reports 40910 when compaction is unavailable', async () => {
    const env = await mountHttp([
      createCompaction({
        summarize: async () => ({ text: 'summary', attempts: 1, droppedCount: 0 }),
        budget: { maxContextTokens: () => 128_000, triggerRatio: 0.92 },
      }),
      bindTestLlm(createMockRequester()),
    ]);
    const session = await openMain(env, 'ses_compact');
    queue = [{ text: 'hello' }];
    await runTurn(session.get(MAIN_AGENT_ID) as AgentHandle);

    const compacted = await post(env, '/sessions/ses_compact:compact', { instruction: '  ' });
    expect(compacted.status).toBe(200);
    expect(await compacted.json()).toMatchObject({ code: 0, data: {} });

    const invalid = await post(env, '/sessions/ses_compact:compact', { instruction: 42 });
    expect(invalid.status).toBe(200);
    expect(await invalid.json()).toMatchObject({ code: 40001 });

    const bare = await mountHttp([bindTestLlm(createMockRequester())]);
    await openMain(bare, 'ses_bare');
    const unavailable = await post(bare, '/sessions/ses_bare:compact', {});
    expect(unavailable.status).toBe(200);
    expect(await unavailable.json()).toMatchObject({ code: 40910 });

    const missing = await post(env, '/sessions/ses_unknown:compact', {});
    expect(missing.status).toBe(200);
    expect(await missing.json()).toMatchObject({ code: 40401 });
  });

  it('undoes turns, projects messages and status, and reports undo guard errors', async () => {
    const env = await mountHttp([builtinUndo, bindTestLlm(createMockRequester())]);
    const session = await openMain(env, 'ses_undo');
    const agent = session.get(MAIN_AGENT_ID) as AgentHandle;
    queue = [{ text: 'first' }];
    await runTurn(agent, 'turn one');
    queue = [{ text: 'second' }];
    await runTurn(agent, 'turn two');

    const undone = await post(env, '/sessions/ses_undo:undo', { count: 1 });
    expect(undone.status).toBe(200);
    const body = await undone.json();
    expect(body.data.status.busy).toBe(false);
    expect(body.data.messages.has_more).toBe(false);
    expect(body.data.messages.items).toHaveLength(2);
    expect(body.data.messages.items[0]).toMatchObject({
      session_id: 'ses_undo',
      role: 'assistant',
      content: [{ type: 'text', text: 'first' }],
    });
    expect(typeof body.data.messages.items[0].id).toBe('string');
    expect(typeof body.data.messages.items[0].created_at).toBe('string');

    const invalid = await post(env, '/sessions/ses_undo:undo', { count: 0 });
    expect(invalid.status).toBe(200);
    expect(await invalid.json()).toMatchObject({ code: 40001 });

    const bare = await mountHttp([builtinUndo, bindTestLlm(createMockRequester())]);
    await openMain(bare, 'ses_empty_undo');
    const empty = await post(bare, '/sessions/ses_empty_undo:undo', { count: 1 });
    expect(empty.status).toBe(200);
    expect(await empty.json()).toMatchObject({
      code: 40911,
      msg: 'Nothing to undo: no user message to undo',
      data: null,
    });

    const noFeature = await mountHttp([]);
    await noFeature.app.open({ sessionId: 'ses_no_undo' });
    await noFeature.app
      .get('ses_no_undo')
      ?.create({ agentId: MAIN_AGENT_ID, systemPrompt: 'test' });
    const unavailable = await post(noFeature, '/sessions/ses_no_undo:undo', {});
    expect(unavailable.status).toBe(200);
    expect(await unavailable.json()).toMatchObject({ code: 40911 });
  });

  it('starts a btw side session and reports 40931 when btw is unavailable', async () => {
    const env = await mountHttp([createBtw(), bindTestLlm(createMockRequester())]);
    await openMain(env, 'ses_btw');

    const started = await post(env, '/sessions/ses_btw:btw');
    expect(started.status).toBe(200);
    const body = await started.json();
    expect(body.data.agent_id).toMatch(/^btw-/);

    const bare = await mountHttp([bindTestLlm(createMockRequester())]);
    await openMain(bare, 'ses_no_btw');
    const unavailable = await post(bare, '/sessions/ses_no_btw:btw');
    expect(unavailable.status).toBe(200);
    expect(await unavailable.json()).toMatchObject({ code: 40931 });

    const missing = await post(env, '/sessions/ses_unknown:btw');
    expect(missing.status).toBe(200);
    expect(await missing.json()).toMatchObject({ code: 40401 });
  });

  it('serves session status derived from the agent snapshot and pending interactions', async () => {
    const env = await mountHttp([interaction, bindTestLlm(createMockRequester())]);
    const session = await openMain(env, 'ses_status');

    const idle = await get(env, '/sessions/ses_status/status');
    expect(idle.status).toBe(200);
    expect(await idle.json()).toMatchObject({
      code: 0,
      data: {
        busy: false,
        model: 'test-model',
        thinking_level: 'off',
        permission: 'manual',
        plan_mode: false,
        tower_mode: false,
        context_tokens: 0,
        pending_interaction: 'none',
      },
    });

    session.resolve(InteractionRef).enqueue({
      kind: 'approval',
      payload: { toolCallId: 'call-1', toolName: 'Bash', action: 'Approve Bash', display: {} },
      tags: { [INTERACTION_TAG_SESSION_ID]: 'ses_status', [INTERACTION_TAG_AGENT_ID]: MAIN_AGENT_ID },
    });
    const pending = await get(env, '/sessions/ses_status/status');
    expect((await pending.json()).data.pending_interaction).toBe('approval');

    await env.app.open({ sessionId: 'ses_no_agents' });
    const noAgent = await get(env, '/sessions/ses_no_agents/status');
    expect(noAgent.status).toBe(200);
    expect(await noAgent.json()).toMatchObject({ code: 40421 });

    const missing = await get(env, '/sessions/ses_unknown/status');
    expect(missing.status).toBe(200);
    expect(await missing.json()).toMatchObject({ code: 40401 });
  });

  it('serves the session goal and reports 40935 when the goal feature is absent', async () => {
    const env = await mountHttp([interaction, createGoal(), bindTestLlm(createMockRequester())]);
    const session = await openMain(env, 'ses_goal');

    const none = await get(env, '/sessions/ses_goal/goal');
    expect(none.status).toBe(200);
    expect((await none.json()).data).toBeNull();

    const agent = session.get(MAIN_AGENT_ID) as AgentHandle;
    await agent.resolve(GoalRef).createGoal({ objective: 'ship it' });
    const active = await get(env, '/sessions/ses_goal/goal');
    const body = await active.json();
    expect(body.data).toMatchObject({
      objective: 'ship it',
      status: 'active',
      turnsUsed: 0,
      tokensUsed: 0,
      budget: { overBudget: false },
    });
    expect(typeof body.data.goalId).toBe('string');

    const bare = await mountHttp([bindTestLlm(createMockRequester())]);
    await openMain(bare, 'ses_no_goal');
    const unavailable = await get(bare, '/sessions/ses_no_goal/goal');
    expect(unavailable.status).toBe(200);
    expect(await unavailable.json()).toMatchObject({ code: 40935 });

    const missing = await get(env, '/sessions/ses_unknown/goal');
    expect(missing.status).toBe(200);
    expect(await missing.json()).toMatchObject({ code: 40401 });
  });

  it('lists session skills and reports 40934 when the catalog is absent', async () => {
    const env = await mountHttp([createSkill({ workDir: '/' }), bindTestLlm(createMockRequester())]);
    await openMain(env, 'ses_skills');

    const listed = await get(env, '/sessions/ses_skills/skills');
    expect(listed.status).toBe(200);
    const body = await listed.json();
    expect(Array.isArray(body.data.skills)).toBe(true);
    const writeGoal = body.data.skills.find((skill: { name?: string }) => skill.name === 'write-goal');
    expect(writeGoal).toMatchObject({ name: 'write-goal', source: 'builtin' });
    expect(typeof writeGoal.description).toBe('string');
    expect(typeof writeGoal.path).toBe('string');

    const bare = await mountHttp([bindTestLlm(createMockRequester())]);
    await openMain(bare, 'ses_no_skills');
    const unavailable = await get(bare, '/sessions/ses_no_skills/skills');
    expect(unavailable.status).toBe(200);
    expect(await unavailable.json()).toMatchObject({ code: 40934 });

    const missing = await get(env, '/sessions/ses_unknown/skills');
    expect(missing.status).toBe(200);
    expect(await missing.json()).toMatchObject({ code: 40401 });
  });

  it('lists, reads and stops session tasks', async () => {
    const bg = new Map<string, BgHandle>();
    const env = await mountHttp([createTask(), bindTestLlm(createMockRequester()), bindTestBgTool(bg)]);
    const session = await openMain(env, 'ses_tasks');
    const agent = session.get(MAIN_AGENT_ID) as AgentHandle;
    queue = [
      { toolCall: { name: 'TestBg', arguments: JSON.stringify({ description: 'test task' }) } },
      { text: 'done' },
    ];
    await runTurn(agent);
    const taskId = [...bg.keys()].at(-1) as string;

    const listed = await get(env, '/sessions/ses_tasks/tasks');
    expect(listed.status).toBe(200);
    const listBody = await listed.json();
    expect(listBody.data.items).toHaveLength(1);
    expect(listBody.data.items[0]).toMatchObject({
      id: taskId,
      session_id: 'ses_tasks',
      kind: 'tool',
      description: 'test task',
      status: 'running',
      run_in_background: true,
    });
    expect(Number.isNaN(Date.parse(listBody.data.items[0].created_at))).toBe(false);

    const filtered = await get(env, '/sessions/ses_tasks/tasks?status=completed');
    expect((await filtered.json()).data.items).toHaveLength(0);
    const badFilter = await get(env, '/sessions/ses_tasks/tasks?status=bogus');
    expect(badFilter.status).toBe(200);

    const detached = await post(env, `/sessions/ses_tasks/tasks/${taskId}:detach`);
    expect(detached.status).toBe(200);
    expect(await detached.json()).toMatchObject({
      code: 0,
      data: { detached: false, status: 'running' },
    });
    const detachMissing = await post(env, '/sessions/ses_tasks/tasks/task_unknown:detach');
    expect(detachMissing.status).toBe(200);
    expect(await detachMissing.json()).toMatchObject({ code: 40406 });
    const detachBadAction = await post(env, `/sessions/ses_tasks/tasks/${taskId}:cancel`);
    expect(detachBadAction.status).toBe(200);
    expect(await detachBadAction.json()).toMatchObject({
      code: 40001,
      msg: `unsupported action: ${taskId}:cancel`,
    });

    const abortNotified = new Promise<void>((resolve) => {
      agent.on('turn.done', () => {
        resolve();
      });
    });
    const stopped = await post(env, `/sessions/ses_tasks/tasks/${taskId}:stop`);
    expect(stopped.status).toBe(200);
    expect(await stopped.json()).toMatchObject({ code: 0, data: { cancelled: true } });
    await abortNotified;

    const view = await get(env, `/sessions/ses_tasks/tasks/${taskId}`);
    expect((await view.json()).data).toMatchObject({ id: taskId, status: 'cancelled' });

    const detachCancelled = await post(env, `/sessions/ses_tasks/tasks/${taskId}:detach`);
    expect(detachCancelled.status).toBe(200);
    expect(await detachCancelled.json()).toMatchObject({
      code: 0,
      data: { detached: false, status: 'cancelled' },
    });

    const again = await post(env, `/sessions/ses_tasks/tasks/${taskId}:stop`);
    expect(again.status).toBe(200);
    expect(await again.json()).toMatchObject({
      code: 40904,
      data: { cancelled: false },
      details: { current_status: 'cancelled' },
    });

    const missingTask = await get(env, '/sessions/ses_tasks/tasks/task_unknown');
    expect(missingTask.status).toBe(200);
    expect(await missingTask.json()).toMatchObject({ code: 40406 });

    queue = [
      { toolCall: { name: 'TestBg', arguments: JSON.stringify({ description: 'output task' }) } },
      { text: 'done' },
    ];
    await runTurn(agent);
    const outputTaskId = [...bg.keys()].at(-1) as string;
    const settled = new Promise<void>((resolve) => {
      agent.on('turn.done', () => {
        resolve();
      });
    });
    bg.get(outputTaskId)?.settle('bg output text');
    await settled;
    await vi.waitFor(async () => {
      const probe = await get(env, `/sessions/ses_tasks/tasks/${outputTaskId}?with_output=true`);
      expect((await probe.json()).data.status).toBe('completed');
    });
    const withOutput = await get(env, `/sessions/ses_tasks/tasks/${outputTaskId}?with_output=true`);
    expect((await withOutput.json()).data).toMatchObject({
      status: 'completed',
      output_preview: 'bg output text',
      output_bytes: Buffer.byteLength('bg output text', 'utf-8'),
    });

    const bare = await mountHttp([bindTestLlm(createMockRequester())]);
    await openMain(bare, 'ses_no_tasks');
    const unavailable = await get(bare, '/sessions/ses_no_tasks/tasks');
    expect(unavailable.status).toBe(200);
    expect(await unavailable.json()).toMatchObject({ code: 40933 });

    const missing = await get(env, '/sessions/ses_unknown/tasks');
    expect(missing.status).toBe(200);
    expect(await missing.json()).toMatchObject({ code: 40401 });
  });

  it('serves file history changes and content, and reports 40949 when file history is absent', async () => {
    const workDir = await tempDir('kimi-http-file-history-');
    await writeFile(join(workDir, 'a.txt'), 'one\ntwo\n');
    const editTool: ToolDefinition = {
      name: 'Edit',
      description: 'test edit tool',
      parameters: {
        type: 'object',
        properties: {
          file_path: { type: 'string' },
          old_string: { type: 'string' },
          new_string: { type: 'string' },
        },
        additionalProperties: false,
      },
      execute: async ({ toolCall }) => {
        const args = JSON.parse(toolCall.arguments ?? '{}') as {
          file_path: string;
          old_string: string;
          new_string: string;
        };
        const target = join(workDir, args.file_path);
        const before = await readFile(target, 'utf8');
        await writeFile(target, before.replace(args.old_string, args.new_string));
        return { content: [{ type: 'text', text: 'edited' }] };
      },
    };
    const env = await mountHttp([
      createFileHistory({ workDir, fs: createNodeOsHost().fs }),
      bindTestLlm(createMockRequester()),
      createFeature('test-edit', {
        agent() {
          useAgentTools(editTool);
        },
      }),
    ]);
    const session = await openMain(env, 'ses_fh');
    const agent = session.get(MAIN_AGENT_ID) as AgentHandle;
    queue = [
      {
        toolCall: {
          name: 'Edit',
          arguments: JSON.stringify({ file_path: 'a.txt', old_string: 'two', new_string: 'TWO\nthree' }),
        },
      },
      { text: 'done' },
    ];
    await runTurn(agent);

    const changes = await get(env, '/sessions/ses_fh/file-history/changes?turn_id=0');
    expect(changes.status).toBe(200);
    expect(await changes.json()).toMatchObject({
      code: 0,
      data: {
        recorded: true,
        changes: [{ path: 'a.txt', status: 'modified', additions: 2, deletions: 1 }],
      },
    });

    const content = await get(env, '/sessions/ses_fh/file-history/content?turn_id=0&path=a.txt');
    expect((await content.json()).data.content).toMatchObject({ content: 'one\ntwo\n' });
    const endContent = await get(env, '/sessions/ses_fh/file-history/content?turn_id=0&path=a.txt&phase=end');
    expect((await endContent.json()).data.content).toMatchObject({ content: 'one\nTWO\nthree\n' });

    const unrecorded = await get(env, '/sessions/ses_fh/file-history/changes?turn_id=99');
    expect(await unrecorded.json()).toMatchObject({ data: { recorded: false, changes: [] } });
    const missingContent = await get(env, '/sessions/ses_fh/file-history/content?turn_id=99&path=a.txt');
    expect((await missingContent.json()).data).toEqual({ content: null });

    const badTurn = await get(env, '/sessions/ses_fh/file-history/changes?turn_id=abc');
    expect(badTurn.status).toBe(200);

    const bare = await mountHttp([bindTestLlm(createMockRequester())]);
    await openMain(bare, 'ses_no_fh');
    const unavailable = await get(bare, '/sessions/ses_no_fh/file-history/changes?turn_id=0');
    expect(unavailable.status).toBe(200);
    expect(await unavailable.json()).toMatchObject({ code: 40949 });

    const missing = await get(env, '/sessions/ses_unknown/file-history/changes?turn_id=0');
    expect(missing.status).toBe(200);
    expect(await missing.json()).toMatchObject({ code: 40401 });
  });

  it('lists and resolves approvals with the kap-server wire shape', async () => {
    const env = await mountHttp([interaction, bindTestLlm(createMockRequester())]);
    const session = await openMain(env, 'ses_approvals');
    const interactions = session.resolve(InteractionRef);
    const item = interactions.enqueue({
      kind: 'approval',
      payload: {
        toolCallId: 'call-1',
        toolName: 'Bash',
        action: 'Approve Bash',
        display: { kind: 'generic', summary: 'Approve Bash' },
      },
      tags: {
        [INTERACTION_TAG_SESSION_ID]: 'ses_approvals',
        [INTERACTION_TAG_AGENT_ID]: MAIN_AGENT_ID,
        [INTERACTION_TAG_TOOL_CALL_ID]: 'call-1',
      },
    });
    const waiter = interactions.wait(item.id);

    const listed = await get(env, '/sessions/ses_approvals/approvals');
    expect(listed.status).toBe(200);
    const listBody = await listed.json();
    expect(listBody.data.items).toHaveLength(1);
    expect(listBody.data.items[0]).toMatchObject({
      approval_id: item.id,
      session_id: 'ses_approvals',
      tool_call_id: 'call-1',
      tool_name: 'Bash',
      action: 'Approve Bash',
      tool_input_display: { kind: 'generic', summary: 'Approve Bash' },
    });
    expect(Number.isNaN(Date.parse(listBody.data.items[0].created_at))).toBe(false);
    expect(Number.isNaN(Date.parse(listBody.data.items[0].expires_at))).toBe(false);

    const invalid = await post(env, `/sessions/ses_approvals/approvals/${item.id}`, { decision: 'maybe' });
    expect(invalid.status).toBe(200);
    expect(await invalid.json()).toMatchObject({ code: 40001 });

    const resolved = await post(env, `/sessions/ses_approvals/approvals/${item.id}`, {
      decision: 'approved',
      scope: 'session',
      feedback: 'looks fine',
      selected_label: 'Allow',
    });
    expect(resolved.status).toBe(200);
    const resolvedBody = await resolved.json();
    expect(resolvedBody.data.resolved).toBe(true);
    expect(Number.isNaN(Date.parse(resolvedBody.data.resolved_at))).toBe(false);
    await expect(waiter).resolves.toEqual({
      decision: 'approved',
      scope: 'session',
      feedback: 'looks fine',
      selectedLabel: 'Allow',
    });

    const duplicate = await post(env, `/sessions/ses_approvals/approvals/${item.id}`, { decision: 'approved' });
    expect(duplicate.status).toBe(200);
    expect(await duplicate.json()).toMatchObject({ code: 40902, data: { resolved: false } });

    const unknown = await post(env, '/sessions/ses_approvals/approvals/approval_unknown', { decision: 'approved' });
    expect(unknown.status).toBe(200);
    expect(await unknown.json()).toMatchObject({ code: 40404 });

    const bare = await mountHttp([bindTestLlm(createMockRequester())]);
    await openMain(bare, 'ses_no_interaction');
    const unavailable = await get(bare, '/sessions/ses_no_interaction/approvals');
    expect(unavailable.status).toBe(200);
    expect(await unavailable.json()).toMatchObject({ code: 40932 });

    const missing = await get(env, '/sessions/ses_unknown/approvals');
    expect(missing.status).toBe(200);
    expect(await missing.json()).toMatchObject({ code: 40401 });
  });

  it('lists, resolves and dismisses questions with colon-containing ids', async () => {
    const env = await mountHttp([interaction, bindTestLlm(createMockRequester())]);
    const session = await openMain(env, 'ses_questions');
    const interactions = session.resolve(InteractionRef);
    const payload = {
      questions: [
        {
          question: 'Pick one',
          header: 'Choice',
          options: [
            { label: 'A', description: 'alpha' },
            { label: 'B', description: '' },
          ],
          multi_select: false,
        },
      ],
    };
    const item = interactions.enqueue({
      kind: 'question',
      payload,
      tags: {
        [INTERACTION_TAG_SESSION_ID]: 'ses_questions',
        [INTERACTION_TAG_AGENT_ID]: MAIN_AGENT_ID,
        [INTERACTION_TAG_TOOL_CALL_ID]: 'call-q1',
      },
    });
    expect(item.id).toContain(':');
    const waiter = interactions.wait(item.id);

    const listed = await get(env, '/sessions/ses_questions/questions');
    expect(listed.status).toBe(200);
    const listBody = await listed.json();
    expect(listBody.data.items).toHaveLength(1);
    expect(listBody.data.items[0]).toMatchObject({
      question_id: item.id,
      session_id: 'ses_questions',
      tool_call_id: 'call-q1',
      questions: [
        {
          id: 'q_0',
          question: 'Pick one',
          header: 'Choice',
          options: [
            { id: 'opt_0_0', label: 'A', description: 'alpha' },
            { id: 'opt_0_1', label: 'B' },
          ],
          allow_other: true,
        },
      ],
    });

    const resolved = await post(env, `/sessions/ses_questions/questions/${item.id}`, {
      answers: { q_0: { kind: 'single', option_id: 'opt_0_0' } },
      method: 'enter',
    });
    expect(resolved.status).toBe(200);
    expect((await resolved.json()).data.resolved).toBe(true);
    await expect(waiter).resolves.toEqual({ answers: { 'Pick one': 'A' }, method: 'enter' });

    const second = interactions.enqueue({ kind: 'question', payload, tags: { [INTERACTION_TAG_SESSION_ID]: 'ses_questions' } });
    const dismissedWaiter = interactions.wait(second.id);
    const dismissed = await post(env, `/sessions/ses_questions/questions/${second.id}:dismiss`);
    expect(dismissed.status).toBe(200);
    const dismissedBody = await dismissed.json();
    expect(dismissedBody.code).toBe(40909);
    expect(dismissedBody.data.dismissed).toBe(true);
    expect(Number.isNaN(Date.parse(dismissedBody.data.dismissed_at))).toBe(false);
    await expect(dismissedWaiter).resolves.toBeNull();

    const unknown = await post(env, '/sessions/ses_questions/questions/question_unknown', {
      answers: {},
    });
    expect(unknown.status).toBe(200);
    expect(await unknown.json()).toMatchObject({ code: 40405 });

    const third = interactions.enqueue({ kind: 'question', payload, tags: { [INTERACTION_TAG_SESSION_ID]: 'ses_questions' } });
    const badAnswers = await post(env, `/sessions/ses_questions/questions/${third.id}`, {
      answers: { q_0: { kind: 'single' } },
    });
    expect(badAnswers.status).toBe(200);
    interactions.respond(third.id, null);

    const missing = await get(env, '/sessions/ses_unknown/questions');
    expect(missing.status).toBe(200);
    expect(await missing.json()).toMatchObject({ code: 40401 });
  });
});

describe('feature-http v2 session routes', () => {
  const getV2 = (env: HttpEnv, path: string): Promise<Response> =>
    fetch(`${env.origin}/api/v2${path}`);

  const postV2 = (env: HttpEnv, path: string, body?: unknown): Promise<Response> =>
    fetch(`${env.origin}/api/v2${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });

  interface V2SeedEnv {
    readonly env: HttpEnv;
    tick(ms: number): number;
  }

  async function mountV2(features: readonly FeatureSpec[] = []): Promise<V2SeedEnv> {
    let now = 10_000;
    const env = await mountHttp([
      bindTestLlm(createMockRequester()),
      createSessionIndex({ dbPath: ':memory:', now: () => now }),
      ...features,
    ]);
    return {
      env,
      tick(ms: number): number {
        now = ms;
        return now;
      },
    };
  }

  it('serves the flat session list with kap wire shape, filters and sorts', async () => {
    const bg = new Map<string, BgHandle>();
    const { env, tick } = await mountV2([bindTestBgTool(bg)]);

    const a = await openMain(env, 'ses_a');
    tick(11_000);
    queue = [
      { toolCall: { name: 'TestBg', arguments: JSON.stringify({ description: 'a bg' }) } },
      { text: 'done' },
    ];
    await runTurn(a.get(MAIN_AGENT_ID) as AgentHandle, 'first task');
    expect(bg.size).toBe(1);

    tick(12_000);
    await env.app.open({ sessionId: 'ses_b', title: 'b title', metadata: { workspaceId: 'wa' } });
    await env.app.close('ses_b');

    tick(14_000);
    const c = await env.app.open({ sessionId: 'ses_c', title: 'c title', metadata: { workspaceId: 'wb' } });
    tick(15_000);
    c.node.fire({
      type: 'message.appended',
      agentId: MAIN_AGENT_ID,
      message: createUserEntry({ role: 'user', content: [{ type: 'text', text: 'fix bug' }] }),
    });
    await env.app.close('ses_c');
    tick(16_000);
    await env.app.updateSession('ses_c', {
      metadata: { archived: true, archived_at: '2026-04-01T00:00:00.000Z' },
    });

    tick(17_000);
    const d = await env.app.open({ sessionId: 'ses_d' });
    tick(18_000);
    d.node.fire({
      type: 'session.meta_updated',
      meta: { lastTurn: { turnId: 1, outcome: 'failed' } },
    });
    await env.app.close('ses_d');

    tick(19_000);
    await env.app.updateSession('ses_b', { title: 'b renamed' });

    const ids = (body: { data: { items: { id: string }[] } }): string[] =>
      body.data.items.map((item) => item.id);

    const base = await (await getV2(env, '/sessions')).json();
    expect(ids(base)).toEqual(['ses_b', 'ses_d', 'ses_a']);
    expect(base.data.total).toBe(3);
    expect(base.data.has_more).toBe(false);
    expect(base.data.next_page_token).toBeNull();
    const liveA = base.data.items.find((item: { id: string }) => item.id === 'ses_a');
    expect(liveA).toMatchObject({
      id: 'ses_a',
      workspace: { id: '', cwd: null },
      meta: {
        title: null,
        last_prompt: 'first task',
        created_at: 10_000,
        archived: false,
        archived_at: null,
      },
      activity: { status: 'running', model: 'test-model' },
    });
    const coldB = base.data.items.find((item: { id: string }) => item.id === 'ses_b');
    expect(coldB).toMatchObject({
      workspace: { id: 'wa', cwd: null },
      meta: { title: 'b renamed', last_prompt: null, updated_at: 19_000 },
      activity: { status: 'idle', model: null },
    });

    const all = await (await getV2(env, '/sessions?meta.archived=all')).json();
    expect(ids(all)).toEqual(['ses_b', 'ses_d', 'ses_c', 'ses_a']);
    expect(all.data.total).toBe(4);
    const archivedC = all.data.items.find((item: { id: string }) => item.id === 'ses_c');
    expect(archivedC.meta).toMatchObject({
      archived: true,
      archived_at: Date.parse('2026-04-01T00:00:00.000Z'),
    });

    const archivedOnly = await (await getV2(env, '/sessions?meta.archived=true')).json();
    expect(ids(archivedOnly)).toEqual(['ses_c']);

    const running = await (await getV2(env, '/sessions?activity.status=running')).json();
    expect(ids(running)).toEqual(['ses_a']);
    const failed = await (await getV2(env, '/sessions?activity.status=failed')).json();
    expect(ids(failed)).toEqual(['ses_d']);
    const idle = await (await getV2(env, '/sessions?activity.status=idle&meta.archived=all')).json();
    expect(ids(idle)).toEqual(['ses_b', 'ses_c']);
    const none = await (await getV2(env, '/sessions?activity.status=approval&activity.status=question')).json();
    expect(none.data.items).toEqual([]);

    const withPrompt = await (await getV2(env, '/sessions?meta.has_prompt=true&meta.archived=all')).json();
    expect(ids(withPrompt)).toEqual(['ses_c', 'ses_a']);
    const noPrompt = await (await getV2(env, '/sessions?meta.has_prompt=false&meta.archived=all')).json();
    expect(ids(noPrompt)).toEqual(['ses_b', 'ses_d']);

    const waOnly = await (await getV2(env, '/sessions?workspace.id=wa&meta.archived=all')).json();
    expect(ids(waOnly)).toEqual(['ses_b']);
    const multi = await (
      await getV2(env, '/sessions?workspace.id=wa&workspace.id=wb&meta.archived=all')
    ).json();
    expect(ids(multi)).toEqual(['ses_b', 'ses_c']);

    const after = await (await getV2(env, '/sessions?meta.archived=all&meta.updated_after=16000')).json();
    expect(ids(after)).toEqual(['ses_b', 'ses_d', 'ses_c']);
    const bounded = await (
      await getV2(env, '/sessions?meta.archived=all&meta.updated_after=11000&meta.updated_before=16000')
    ).json();
    expect(ids(bounded)).toEqual(['ses_c', 'ses_a']);

    const asc = await (await getV2(env, '/sessions?meta.archived=all&sort=meta.updated_at_asc')).json();
    expect(ids(asc)).toEqual(['ses_a', 'ses_c', 'ses_d', 'ses_b']);
    const created = await (await getV2(env, '/sessions?meta.archived=all&sort=meta.created_at_desc')).json();
    expect(ids(created)).toEqual(['ses_d', 'ses_c', 'ses_b', 'ses_a']);
  });

  it('paginates with the fingerprint-bound page_token, page mode and the ids projection', async () => {
    const { env, tick } = await mountV2();
    for (const [index, id] of ['s1', 's2', 's3', 's4', 's5'].entries()) {
      tick(20_000 + index * 1_000);
      await env.app.open({ sessionId: id, title: id });
      await env.app.close(id);
    }

    const page1 = await (await getV2(env, '/sessions?page_size=2')).json();
    const idsOf = (body: { data: { items: { id: string }[] } }): string[] =>
      body.data.items.map((item) => item.id);
    expect(idsOf(page1)).toEqual(['s5', 's4']);
    expect(page1.data).toMatchObject({ total: 5, has_more: true });
    expect(page1.data.next_page_token).not.toBeNull();

    const page2 = await (
      await getV2(env, `/sessions?page_size=2&page_token=${encodeURIComponent(page1.data.next_page_token)}`)
    ).json();
    expect(idsOf(page2)).toEqual(['s3', 's2']);
    expect(page2.data).toMatchObject({ total: 5, has_more: true });

    const page3 = await (
      await getV2(env, `/sessions?page_size=2&page_token=${encodeURIComponent(page2.data.next_page_token)}`)
    ).json();
    expect(idsOf(page3)).toEqual(['s1']);
    expect(page3.data).toMatchObject({ total: 5, has_more: false, next_page_token: null });

    const drifted = await getV2(
      env,
      `/sessions?page_size=3&page_token=${encodeURIComponent(page1.data.next_page_token)}`,
    );
    expect(await drifted.json()).toMatchObject({ code: 40922 });
    const garbage = await getV2(env, '/sessions?page_token=not-a-token');
    expect(await garbage.json()).toMatchObject({ code: 40922 });

    const offset = await (await getV2(env, '/sessions?page_size=2&page=2')).json();
    expect(idsOf(offset)).toEqual(['s3', 's2']);
    expect(offset.data).toMatchObject({ total: 5, has_more: true, next_page_token: null });

    const projection = await (
      await getV2(env, '/sessions?fields=id,archived&page_size=5000&meta.archived=all')
    ).json();
    expect(projection.data.items).toEqual([
      { id: 's5', archived: false },
      { id: 's4', archived: false },
      { id: 's3', archived: false },
      { id: 's2', archived: false },
      { id: 's1', archived: false },
    ]);
    expect(projection.data.items[0]).not.toHaveProperty('meta');

    const git = await (await getV2(env, '/sessions?include=git&page_size=1')).json();
    expect(git.data.items[0].git).toEqual({ branch: null, pull_request: null });

    const caps = await getV2(env, '/sessions?page_size=101');
    expect(await caps.json()).toMatchObject({
      code: 40001,
      msg: 'page_size: page_size must be at most 100 without the ids projection',
    });
    const mutual = await getV2(env, `/sessions?page=1&page_token=${encodeURIComponent(page1.data.next_page_token)}`);
    expect(await mutual.json()).toMatchObject({ code: 40001, msg: 'page: page and page_token are mutually exclusive' });
    const badStatus = await getV2(env, '/sessions?activity.status=bogus');
    expect(await badStatus.json()).toMatchObject({ code: 40001 });
    const badDomain = await getV2(env, '/sessions?include=foo');
    expect(await badDomain.json()).toMatchObject({ code: 40001, msg: "include: unknown domain 'foo'" });
    const gitProjection = await getV2(env, '/sessions?include=git&fields=id,archived');
    expect(await gitProjection.json()).toMatchObject({
      code: 40001,
      msg: 'include: include=git is not available with the ids projection',
    });
    const badFields = await getV2(env, '/sessions?fields=id,title');
    expect(await badFields.json()).toMatchObject({ code: 40001, msg: "fields: unknown field 'title'" });
    const groupSizeOutOfView = await getV2(env, '/sessions?group.page_size=3');
    const groupSizeBody = await groupSizeOutOfView.json();
    expect(groupSizeBody).toMatchObject({ code: 40001, msg: "group.page_size: group.page_size requires view='by_workspace'" });
    expect(Array.isArray(groupSizeBody.details)).toBe(true);
  });

  it('projects the git domain for sessions inside a repository over include=git', async () => {
    const root = await tempDir('v2-git-repo-');
    await git(root, 'init', '-b', 'main');
    await git(root, 'config', 'user.email', 'v2-test@example.com');
    await git(root, 'config', 'user.name', 'V2 Test');
    await git(root, 'config', 'commit.gpgsign', 'false');
    await writeFile(join(root, 'a.txt'), 'a\n', 'utf8');
    await git(root, 'add', 'a.txt');
    await git(root, 'commit', '-m', 'init');
    const { env } = await mountV2([
      createWorkspaces({ homeDir: await tempDir('v2-git-home-'), host: createNodeOsHost() }),
    ]);
    await env.app.open({ sessionId: 'ses_repo', metadata: { cwd: root } });
    await env.app.open({ sessionId: 'ses_plain' });

    const body = await (await getV2(env, '/sessions?include=git')).json();
    const byId = new Map<string, { branch: string | null; pull_request: unknown }>(
      (body.data.items as { id: string; git: { branch: string | null; pull_request: unknown } }[]).map(
        (item) => [item.id, item.git],
      ),
    );
    expect(byId.get('ses_repo')).toEqual({ branch: 'main', pull_request: null });
    expect(byId.get('ses_plain')).toEqual({ branch: null, pull_request: null });

    const grouped = await (await getV2(env, '/sessions?include=git&view=by_workspace')).json();
    const flat = (grouped.data.groups as { sessions: { id: string; git: unknown }[] }[]).flatMap(
      (group) => group.sessions,
    );
    expect(flat.find((item) => item.id === 'ses_repo')?.git).toEqual({
      branch: 'main',
      pull_request: null,
    });
  });

  it('groups sessions by workspace with per-group totals and group pagination', async () => {
    const home = await tempDir('v2-groups-');
    const { env, tick } = await mountV2([createWorkspaces({ homeDir: home })]);
    const workspaces = env.app.resolve(WorkspaceRef);
    if (workspaces === undefined) throw new Error('workspaces feature missing');
    const wa = await workspaces.createOrTouch('/work/wa');

    tick(21_000);
    await env.app.open({ sessionId: 'g_a2', title: 'a2', metadata: { workspaceId: wa.id, cwd: '/work/wa/sub' } });
    await env.app.close('g_a2');
    tick(22_000);
    await env.app.open({ sessionId: 'g_a1', title: 'a1', metadata: { workspaceId: wa.id } });
    await env.app.close('g_a1');
    tick(23_000);
    await env.app.open({ sessionId: 'g_raw', title: 'raw', metadata: { workspaceId: 'ws-unregistered' } });
    await env.app.close('g_raw');
    tick(24_000);
    await env.app.open({ sessionId: 'g_free', title: 'free' });
    await env.app.close('g_free');

    const grouped = await (
      await getV2(env, '/sessions?view=by_workspace&group.page_size=1')
    ).json();
    expect(grouped.data.total).toBe(3);
    expect(grouped.data.has_more).toBe(false);
    const byId = new Map(
      grouped.data.groups.map((group: { workspace: { id: string } }) => [group.workspace.id, group]),
    );
    const groupWa = byId.get(wa.id) as { workspace: { cwd: string }; sessions: { id: string; workspace: { cwd: string } }[]; total: number };
    expect(groupWa.workspace.cwd).toBe('/work/wa');
    expect(groupWa.total).toBe(2);
    expect(groupWa.sessions.map((session) => session.id)).toEqual(['g_a1']);
    expect(groupWa.sessions[0]?.workspace).toEqual({ id: wa.id, cwd: '/work/wa' });
    const groupRaw = byId.get('ws-unregistered') as { workspace: { cwd: string | null }; total: number };
    expect(groupRaw.workspace.cwd).toBeNull();
    expect(groupRaw.total).toBe(1);
    const groupFree = byId.get('') as { total: number };
    expect(groupFree.total).toBe(1);

    const flat = await (await getV2(env, `/sessions?workspace.id=${encodeURIComponent(wa.id)}`)).json();
    const itemA2 = flat.data.items.find((item: { id: string }) => item.id === 'g_a2');
    expect(itemA2.workspace).toEqual({ id: wa.id, cwd: '/work/wa/sub' });

    const walk = async (token: string | null): Promise<{ ids: string[]; next: string | null }> => {
      const query = token === null ? '' : `&page_token=${encodeURIComponent(token)}`;
      const body = await (
        await getV2(env, `/sessions?view=by_workspace&page_size=2${query}`)
      ).json();
      return {
        ids: body.data.groups.map((group: { workspace: { id: string } }) => group.workspace.id),
        next: body.data.next_page_token,
      };
    };
    const first = await walk(null);
    expect(first.ids).toEqual(['', 'ws-unregistered']);
    expect(first.next).not.toBeNull();
    const second = await walk(first.next);
    expect(second.ids).toEqual([wa.id]);
    expect(second.next).toBeNull();
  });

  it('batch archives and restores sessions with kap per-item semantics', async () => {
    const { env } = await mountV2();
    await openMain(env, 'ses_live');
    await env.app.open({ sessionId: 'ses_cold', title: 'cold' });
    await env.app.close('ses_cold');

    const archived = await (
      await postV2(env, '/sessions:archive', { ids: ['ses_live', 'ses_cold', 'ses_missing', 'ses_cold'] })
    ).json();
    expect(archived.data.succeeded).toBe(2);
    expect(archived.data.failed).toBe(1);
    expect(archived.data.results).toHaveLength(3);
    expect(archived.data.results[0]).toEqual({ id: 'ses_live', ok: true });
    expect(archived.data.results[1]).toEqual({ id: 'ses_cold', ok: true });
    expect(archived.data.results[2]).toEqual({
      id: 'ses_missing',
      ok: false,
      error: { code: 40401, message: 'session ses_missing does not exist' },
    });
    expect(env.app.get('ses_live')).toBeUndefined();
    expect((await env.space.get('ses_live'))?.metadata?.['archived']).toBe(true);
    expect((await env.space.get('ses_cold'))?.metadata?.['archived']).toBe(true);

    const listedArchived = await (await getV2(env, '/sessions?meta.archived=true')).json();
    expect(listedArchived.data.items.map((item: { id: string }) => item.id)).toEqual(
      expect.arrayContaining(['ses_live', 'ses_cold']),
    );

    const restored = await (await postV2(env, '/sessions:restore', { ids: ['ses_cold'] })).json();
    expect(restored.data).toMatchObject({ succeeded: 1, failed: 0 });
    expect((await env.space.get('ses_cold'))?.metadata?.['archived']).toBe(false);
    const listedDefault = await (await getV2(env, '/sessions')).json();
    expect(listedDefault.data.items.map((item: { id: string }) => item.id)).toEqual(['ses_cold']);
    expect(listedDefault.data.items[0].meta.archived_at).toBeNull();

    await openMain(env, 'ses_stay');
    await postV2(env, '/sessions:archive', { ids: ['ses_stay'] });
    const revived = await env.app.open({ sessionId: 'ses_stay' });
    const restoredLive = await (await postV2(env, '/sessions:restore', { ids: ['ses_stay'] })).json();
    expect(restoredLive.data).toMatchObject({ succeeded: 1, failed: 0 });
    expect(env.app.get('ses_stay')).toBe(revived);
    expect((await env.space.get('ses_stay'))?.metadata?.['archived']).toBe(false);

    const empty = await postV2(env, '/sessions:archive', { ids: [] });
    expect(await empty.json()).toMatchObject({ code: 40001 });
    const blank = await postV2(env, '/sessions:archive', { ids: [''] });
    expect(await blank.json()).toMatchObject({ code: 40001 });
    const missingIds = await postV2(env, '/sessions:archive', {});
    expect(await missingIds.json()).toMatchObject({ code: 40001 });
    const tooMany = await postV2(env, '/sessions:archive', {
      ids: Array.from({ length: 5001 }, (_, index) => `s${index}`),
    });
    expect(await tooMany.json()).toMatchObject({
      code: 40001,
      msg: 'ids: ids must contain at most 5000 unique entries',
    });
  });

  it('reports 40952 when the session index feature is absent', async () => {
    const env = await mountHttp([bindTestLlm(createMockRequester())]);
    const response = await getV2(env, '/sessions');
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ code: 40952 });
  });
});

describe('feature-http kap-server aligned routes', () => {
  it('activates a skill and maps skill errors', async () => {
    const env = await mountHttp([createSkill({ workDir: '/' }), bindTestLlm(createMockRequester())]);
    const session = await openMain(env, 'ses_skill_activate');
    const agent = session.get(MAIN_AGENT_ID) as AgentHandle;

    const done = new Promise<void>((resolve) => {
      agent.on('turn.done', () => {
        resolve();
      });
    });
    const activated = await post(env, '/sessions/ses_skill_activate/skills/write-goal:activate', {
      args: 'ship the feature',
    });
    expect(activated.status).toBe(200);
    expect(await activated.json()).toMatchObject({
      code: 0,
      data: { activated: true, skill_name: 'write-goal' },
    });
    await done;

    const notFound = await post(env, '/sessions/ses_skill_activate/skills/ghost-skill:activate', {});
    expect(notFound.status).toBe(200);
    expect(await notFound.json()).toMatchObject({ code: 40415 });

    const unsupported = await post(env, '/sessions/ses_skill_activate/skills/write-goal:bogus', {});
    expect(unsupported.status).toBe(200);
    expect(await unsupported.json()).toMatchObject({ code: 40001 });

    const missing = await post(env, '/sessions/ses_ghost/skills/write-goal:activate', {});
    expect(missing.status).toBe(200);
    expect(await missing.json()).toMatchObject({ code: 40401 });

    const bare = await mountHttp([bindTestLlm(createMockRequester())]);
    await openMain(bare, 'ses_no_skill');
    const unavailable = await post(bare, '/sessions/ses_no_skill/skills/write-goal:activate', {});
    expect(unavailable.status).toBe(200);
    expect(await unavailable.json()).toMatchObject({ code: 40940 });
  });

  it('serves server metadata with the configured version', async () => {
    const env = await mountHttp([], { version: '1.2.3' });
    const response = await get(env, '/meta');
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.data).toMatchObject({
      server_version: '1.2.3',
      capabilities: {
        websocket: true,
        file_upload: false,
        fs_query: false,
        mcp: false,
        tasks: false,
        terminal: false,
      },
      dangerous_bypass_auth: false,
      open_in_apps: [],
    });
    expect(typeof body.data.server_id).toBe('string');
    expect(body.data.server_id.length).toBeGreaterThan(0);
    expect(Number.isNaN(Date.parse(body.data.started_at))).toBe(false);
    expect(
      (body.data.features as { name: string; state: string }[]).some(
        (feature) => feature.name === 'http' && feature.state === 'Active',
      ),
    ).toBe(true);

    const bare = await mountHttp([]);
    const fallback = await get(bare, '/meta');
    expect((await fallback.json()).data.server_version).toBe('0.0.0');
  });

  it('reports the installed feature set and configured open_in_apps in server metadata', async () => {
    const env = await mountHttp(
      [
        createTask(),
        createFiles({ dir: await tempDir('meta-files-') }),
        createWorkspaces({ homeDir: await tempDir('meta-ws-home-'), host: createNodeOsHost() }),
      ],
      { openInApps: ['finder', 'vscode'] },
    );
    const body = await (await get(env, '/meta')).json();
    expect(body.data.capabilities).toEqual({
      websocket: true,
      file_upload: true,
      fs_query: true,
      mcp: false,
      tasks: true,
      terminal: false,
    });
    expect(body.data.open_in_apps).toEqual(['finder', 'vscode']);

    const detected = await mountHttp([], { openInApps: async () => ['terminal'] });
    const getterBody = await (await get(detected, '/meta')).json();
    expect(getterBody.data.open_in_apps).toEqual(['terminal']);
  });

  it('manages providers and models over the catalog routes', async () => {
    const file = fakePersist(CATALOG_TOML);
    const env = await mountHttp([
      createConfig({ persist: file.persist }),
      providerCatalog,
      bindTestLlm(createMockRequester()),
    ]);

    const listed = await get(env, '/providers');
    expect(listed.status).toBe(200);
    const listBody = await listed.json();
    expect(listBody.data.items).toHaveLength(1);
    expect(listBody.data.items[0]).toMatchObject({
      id: 'acme',
      type: 'openai',
      base_url: 'https://api.example.com',
      default_model: 'acme/m1',
      has_api_key: true,
      status: 'connected',
      models: ['acme/m1'],
    });

    const single = await get(env, '/providers/acme');
    expect(single.status).toBe(200);
    expect((await single.json()).data).toMatchObject({ id: 'acme', api_key: 'sk-acme' });

    const missing = await get(env, '/providers/ghost');
    expect(missing.status).toBe(200);
    expect(await missing.json()).toMatchObject({ code: 40412 });

    const created = await post(env, '/providers', {
      id: 'beta',
      type: 'anthropic',
      api_key: 'sk-beta',
      base_url: 'https://beta.example.com',
      default_model: 'b1',
      models: [{ model: 'b1', max_context_size: 8192, capabilities: ['tool_use', 'thinking'] }],
    });
    expect(created.status).toBe(200);
    expect(await created.json()).toMatchObject({
      data: {
        id: 'beta',
        type: 'anthropic',
        base_url: 'https://beta.example.com',
        default_model: 'beta/b1',
        has_api_key: true,
        status: 'connected',
        models: ['beta/b1'],
      },
    });
    const config = env.app.resolve(ConfigRef);
    await vi.waitFor(() => {
      const providers = config.get('providers') as Record<string, { apiKey?: string }>;
      expect(providers['beta']?.apiKey).toBe('sk-beta');
    });
    expect(file.saved.join('\n')).toContain('beta');

    const duplicate = await post(env, '/providers', {
      id: 'beta',
      type: 'openai',
      models: [{ model: 'x', max_context_size: 1 }],
    });
    expect(duplicate.status).toBe(200);
    expect(await duplicate.json()).toMatchObject({ code: 40921 });

    const models = await get(env, '/models');
    const modelIds = ((await models.json()).data.items as { provider: string; model: string }[]).map(
      (item) => item.model,
    );
    expect(modelIds).toEqual(expect.arrayContaining(['acme/m1', 'beta/b1']));

    const replaced = await put(env, '/providers/acme', {
      type: 'openai',
      base_url: 'https://acme2.example.com',
      models: [{ model: 'm2', max_context_size: 2048 }],
    });
    expect(replaced.status).toBe(200);
    expect((await replaced.json()).data.provider).toMatchObject({
      id: 'acme',
      base_url: 'https://acme2.example.com',
      has_api_key: true,
      models: ['acme/m2'],
    });
    const afterReplace = await get(env, '/models');
    const afterIds = ((await afterReplace.json()).data.items as { provider: string; model: string }[])
      .filter((item) => item.provider === 'acme')
      .map((item) => item.model);
    expect(afterIds).toEqual(['acme/m2']);

    const deleted = await del(env, '/providers/acme');
    expect(deleted.status).toBe(204);
    await vi.waitFor(async () => {
      const gone = await get(env, '/providers/acme');
      expect(gone.status).toBe(200);
    });

    const deleteMissing = await del(env, '/providers/acme');
    expect(deleteMissing.status).toBe(200);

    const invalid = await post(env, '/providers', { id: 'bad id!', type: 'openai', models: [] });
    expect(invalid.status).toBe(200);
  });

  it('sets the default model and refreshes providers', async () => {
    const file = fakePersist();
    const env = await mountHttp([
      createConfig({ persist: file.persist }),
      providerCatalog,
      bindTestProvider(),
      bindTestLlm(createMockRequester()),
    ]);

    let settled: Response | undefined;
    await vi.waitFor(async () => {
      settled = await post(env, '/models/test%2Fm1:set_default');
      expect(settled.status).toBe(200);
    });
    const body = await (settled as Response).json();
    expect(body.data).toMatchObject({
      default_model: 'test/m1',
      model: {
        provider: 'test',
        model: 'test/m1',
        display_name: 'm1',
        max_context_size: 4096,
        capabilities: ['thinking', 'tool_use'],
        support_efforts: ['low', 'high'],
        default_effort: 'low',
      },
    });
    expect(env.app.resolve(ConfigRef).get('defaultModel')).toBe('test/m1');

    const unknown = await post(env, '/models/ghost%2Fnope:set_default');
    expect(unknown.status).toBe(200);
    expect(await unknown.json()).toMatchObject({ code: 40413 });

    const unsupported = await post(env, '/models/test%2Fm1:bogus');
    expect(unsupported.status).toBe(200);

    const refreshedAll = await post(env, '/providers:refresh');
    expect(refreshedAll.status).toBe(200);
    expect(await refreshedAll.json()).toMatchObject({
      data: { changed: [], unchanged: ['test'], failed: [] },
    });

    const refreshed = await post(env, '/providers/test:refresh');
    expect(refreshed.status).toBe(200);
    expect(await refreshed.json()).toMatchObject({
      data: { changed: [], unchanged: ['test'], failed: [] },
    });

    const refreshMissing = await post(env, '/providers/ghost:refresh');
    expect(refreshMissing.status).toBe(200);
    expect(await refreshMissing.json()).toMatchObject({ code: 40412 });

    const refreshOauth = await post(env, '/providers:refresh_oauth');
    expect(refreshOauth.status).toBe(200);
    expect(await refreshOauth.json()).toMatchObject({ code: 40948 });

    const noConfig = await mountHttp([providerCatalog, bindTestLlm(createMockRequester())]);
    const configUnavailable = await get(noConfig, '/providers');
    expect(configUnavailable.status).toBe(200);
    expect(await configUnavailable.json()).toMatchObject({ code: 40941 });

    const noCatalog = await mountHttp([
      createConfig({ persist: fakePersist().persist }),
      bindTestLlm(createMockRequester()),
    ]);
    const catalogUnavailable = await get(noCatalog, '/providers');
    expect(catalogUnavailable.status).toBe(200);
    expect(await catalogUnavailable.json()).toMatchObject({ code: 40942 });
  });

  it('reads and patches the global config with redacted secrets', async () => {
    const file = fakePersist(CATALOG_TOML);
    const env = await mountHttp([
      createConfig({ persist: file.persist }),
      providerCatalog,
      bindTestLlm(createMockRequester()),
    ]);

    const read = await get(env, '/config');
    expect(read.status).toBe(200);
    const body = await read.json();
    expect(body.data.providers.acme).toEqual({
      type: 'openai',
      base_url: 'https://api.example.com',
      has_api_key: true,
    });
    expect(body.data.default_model).toBe('acme/m1');
    expect(body.data.models['acme/m1']).toMatchObject({
      provider: 'acme',
      model: 'm1',
      has_api_key: false,
    });

    const patched = await post(env, '/config', {
      default_model: 'acme/m2',
      thinking: { effort: 'high' },
    });
    expect(patched.status).toBe(200);
    const patchedBody = await patched.json();
    expect(patchedBody.data.default_model).toBe('acme/m2');
    expect(patchedBody.data.thinking).toMatchObject({ effort: 'high' });
    const config = env.app.resolve(ConfigRef);
    await vi.waitFor(() => {
      expect(config.get('defaultModel')).toBe('acme/m2');
    });

    const unknown = await post(env, '/config', { no_such_section: 1 });
    expect(unknown.status).toBe(200);
    expect((await unknown.json()).code).toBe(0);

    const bare = await mountHttp([bindTestLlm(createMockRequester())]);
    const unavailable = await get(bare, '/config');
    expect(unavailable.status).toBe(200);
    expect(await unavailable.json()).toMatchObject({ code: 40941 });
  });

  it('installs, lists, toggles and removes plugins and serves the marketplace', async () => {
    const home = await tempDir('plugin-home-');
    const env = await mountHttp([
      createPlugin({ homeDir: home, host: createNodeOsHost() }),
      bindTestLlm(createMockRequester()),
    ]);

    const updates = await post(env, '/plugins/check-updates');
    expect(updates.status).toBe(200);
    expect((await updates.json()).data.updates).toEqual([]);

    const empty = await get(env, '/plugins');
    expect((await empty.json()).data.plugins).toEqual([]);

    const root = await tempDir('plugin-local-one-');
    await writeFile(
      join(root, 'kimi.plugin.json'),
      JSON.stringify({ name: 'local-one', version: '1.0.0' }),
      'utf8',
    );
    const installed = await post(env, '/plugins', { source: root });
    expect(installed.status).toBe(200);
    expect((await installed.json()).data).toMatchObject({
      id: 'local-one',
      version: '1.0.0',
      enabled: true,
      source: 'local-path',
      state: 'ok',
    });

    const listed = await get(env, '/plugins');
    expect((await listed.json()).data.plugins).toHaveLength(1);

    const disabled = await post(env, '/plugins/local-one:disable');
    expect(disabled.status).toBe(200);
    expect((await disabled.json()).data).toEqual({ ok: true });
    const afterDisable = await get(env, '/plugins');
    expect((await afterDisable.json()).data.plugins[0].enabled).toBe(false);

    const enabled = await post(env, '/plugins/local-one:enable');
    expect(enabled.status).toBe(200);

    const missingPlugin = await post(env, '/plugins/ghost:enable');
    expect(missingPlugin.status).toBe(200);
    expect(await missingPlugin.json()).toMatchObject({ code: 40419 });

    const unsupported = await post(env, '/plugins/local-one:bogus');
    expect(unsupported.status).toBe(200);

    const dir = await tempDir('plugin-marketplace-');
    const catalogPath = join(dir, 'marketplace.json');
    await writeFile(
      catalogPath,
      JSON.stringify({
        plugins: [
          {
            id: 'demo-official',
            displayName: 'Demo Official',
            version: '1.0.0',
            source: 'https://example.com/demo.zip',
            tier: 'official',
            description: 'official demo',
          },
          { id: 'local-one', displayName: 'Local One', version: '2.0.0', source: 'https://example.com/local.zip' },
        ],
      }),
      'utf8',
    );
    vi.stubEnv('KIMI_CODE_PLUGIN_MARKETPLACE_URL', `file://${catalogPath}`);
    const marketplace = await get(env, '/plugins/marketplace');
    expect(marketplace.status).toBe(200);
    const entries = (await marketplace.json()).data.entries as {
      id: string;
      tier: string;
      installed?: { enabled: boolean; version?: string };
      updateAvailable?: boolean;
    }[];
    expect(entries).toHaveLength(2);
    expect(entries[0]).toMatchObject({ id: 'demo-official', tier: 'official' });
    expect(entries[0]?.installed).toBeUndefined();
    expect(entries[1]).toMatchObject({
      id: 'local-one',
      tier: 'third-party',
      installed: { enabled: true, version: '1.0.0' },
      updateAvailable: true,
    });

    const removed = await post(env, '/plugins/local-one:remove');
    expect(removed.status).toBe(200);
    const afterRemove = await get(env, '/plugins');
    expect((await afterRemove.json()).data.plugins).toEqual([]);

    const bare = await mountHttp([bindTestLlm(createMockRequester())]);
    const unavailable = await get(bare, '/plugins');
    expect(unavailable.status).toBe(200);
    expect(await unavailable.json()).toMatchObject({ code: 40943 });
  });

  it('serves the gui store in memory and persists it when guiStorePath is set', async () => {
    const env = await mountHttp([]);

    const missingKey = await get(env, '/gui/store/getItem');
    expect(missingKey.status).toBe(200);

    const set = await post(env, '/gui/store/setItem', { key: 'k1', value: 'v1' });
    expect(set.status).toBe(200);
    expect((await set.json()).data).toBeNull();

    const readBack = await get(env, '/gui/store/getItem?key=k1');
    expect((await readBack.json()).data).toEqual({ value: 'v1' });

    const length = await get(env, '/gui/store/length');
    expect((await length.json()).data).toEqual({ length: 1 });

    const removed = await post(env, '/gui/store/removeItem', { key: 'k1' });
    expect(removed.status).toBe(200);
    const afterRemove = await get(env, '/gui/store/getItem?key=k1');
    expect((await afterRemove.json()).data).toEqual({ value: null });

    await post(env, '/gui/store/setItem', { key: 'a', value: '1' });
    await post(env, '/gui/store/setItem', { key: 'b', value: '2' });
    const cleared = await post(env, '/gui/store/clear');
    expect(cleared.status).toBe(200);
    const afterClear = await get(env, '/gui/store/length');
    expect((await afterClear.json()).data).toEqual({ length: 0 });

    const badValue = await post(env, '/gui/store/setItem', { key: 'k' });
    expect(badValue.status).toBe(200);

    const dir = await tempDir('gui-store-');
    const filePath = join(dir, 'gui.json');
    const persisted = await mountHttp([], { guiStorePath: filePath });
    await post(persisted, '/gui/store/setItem', { key: 'pk', value: 'pv' });
    const onDisk = JSON.parse(await readFile(filePath, 'utf8')) as Record<string, string>;
    expect(onDisk['pk']).toBe('pv');

    const remounted = await mountHttp([], { guiStorePath: filePath });
    const reread = await get(remounted, '/gui/store/getItem?key=pk');
    expect((await reread.json()).data).toEqual({ value: 'pv' });
  });

  it('serves static web assets when webAssetsDir is set and stays off otherwise', async () => {
    const dir = await tempDir('web-assets-');
    await writeFile(join(dir, 'index.html'), '<html><body>hi</body></html>', 'utf8');
    await mkdir(join(dir, 'assets'), { recursive: true });
    await writeFile(join(dir, 'assets', 'app-abcdefgh.js'), 'console.log(1)', 'utf8');
    const env = await mountHttp([], { webAssetsDir: dir });

    const root = await fetch(`${env.origin}/`);
    expect(root.status).toBe(200);
    expect(root.headers.get('content-type')).toBe('text/html; charset=utf-8');
    expect(await root.text()).toContain('hi');

    const js = await fetch(`${env.origin}/assets/app-abcdefgh.js`);
    expect(js.status).toBe(200);
    expect(js.headers.get('content-type')).toBe('text/javascript; charset=utf-8');
    expect(js.headers.get('cache-control')).toBe('public, max-age=31536000, immutable');

    const spa = await fetch(`${env.origin}/sessions/123`);
    expect(spa.status).toBe(200);
    expect(await spa.text()).toContain('hi');

    const missing = await fetch(`${env.origin}/missing.png`);
    expect(missing.status).toBe(404);

    const reserved = await fetch(`${env.origin}/api/v1/nope`);
    expect(reserved.status).toBe(200);
    expect(await reserved.json()).toMatchObject({ code: 40422, data: null });

    const health = await fetch(`${env.origin}/api/v1/healthz`);
    expect(health.status).toBe(200);

    const bare = await mountHttp([]);
    const off = await fetch(`${bare.origin}/`);
    expect(off.status).toBe(200);
    expect(await off.json()).toMatchObject({ code: 40422, data: null });
  });

  it('answers unmatched routes and uncaught errors with the envelope', async () => {
    const boom = createFeature('test-boom', {
      app() {
        useHttpRoute({
          id: 'test.boom',
          method: 'GET',
          path: '/api/v1/boom',
          handler: () => {
            throw new Error('boom');
          },
        });
      },
    });
    const env = await mountHttp([boom]);

    const unknownGet = await fetch(`${env.origin}/api/v1/nope`, {
      headers: { 'x-request-id': 'req-42' },
    });
    expect(unknownGet.status).toBe(200);
    expect(await unknownGet.json()).toEqual({
      code: 40422,
      msg: 'route GET /api/v1/nope not found',
      data: null,
      request_id: 'req-42',
    });

    const unknownPost = await post(env, '/definitely/not/a/route', {});
    expect(unknownPost.status).toBe(200);
    expect(await unknownPost.json()).toMatchObject({ code: 40422, data: null });

    const thrown = await fetch(`${env.origin}/api/v1/boom`);
    expect(thrown.status).toBe(200);
    expect(thrown.headers.get('content-type')).toContain('application/json');
    expect(await thrown.json()).toMatchObject({ code: 50001, msg: 'boom', data: null });

    const malformed = await fetch(`${env.origin}/api/v1/sessions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{not json',
    });
    expect(malformed.status).toBe(200);
    expect(await malformed.json()).toMatchObject({ code: 50001, data: null });
  });

  it('answers cross-origin requests only for allowed origins', async () => {
    const env = await mountHttp([], { corsOrigins: ['app://renderer'] });

    const allowed = await fetch(`${env.origin}/api/v1/sessions`, {
      headers: { origin: 'app://renderer' },
    });
    expect(allowed.status).toBe(200);
    expect(allowed.headers.get('access-control-allow-origin')).toBe('app://renderer');
    expect(allowed.headers.get('vary')).toBe('Origin');

    const preflight = await fetch(`${env.origin}/api/v1/sessions`, {
      method: 'OPTIONS',
      headers: {
        origin: 'app://renderer',
        'access-control-request-method': 'POST',
        'access-control-request-headers': 'content-type, authorization',
      },
    });
    expect(preflight.status).toBe(204);
    expect(preflight.headers.get('access-control-allow-origin')).toBe('app://renderer');
    expect(preflight.headers.get('access-control-allow-headers')).toBe('content-type, authorization');

    const denied = await fetch(`${env.origin}/api/v1/sessions`, {
      headers: { origin: 'https://evil.example.com' },
    });
    expect(denied.status).toBe(200);
    expect(denied.headers.get('access-control-allow-origin')).toBeNull();

    const deniedPreflight = await fetch(`${env.origin}/api/v1/sessions`, {
      method: 'OPTIONS',
      headers: { origin: 'https://evil.example.com', 'access-control-request-method': 'POST' },
    });
    expect(deniedPreflight.status).toBe(204);
    expect(deniedPreflight.headers.get('access-control-allow-origin')).toBeNull();

    const loopback = await fetch(`${env.origin}/api/v1/sessions`, {
      headers: { origin: 'http://localhost:5174' },
    });
    expect(loopback.headers.get('access-control-allow-origin')).toBe('http://localhost:5174');

    const sameOrigin = await fetch(`${env.origin}/api/v1/sessions`);
    expect(sameOrigin.headers.get('access-control-allow-origin')).toBeNull();
  });

  it('shuts the server down after answering ok', async () => {
    const env = await mountHttp([]);
    const response = await post(env, '/shutdown');
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ code: 0, data: { ok: true } });
    await vi.waitFor(async () => {
      await expect(fetch(`${env.origin}/api/v1/healthz`)).rejects.toThrow();
    });
  });

  it('lists and restarts mcp servers and lists frozen spec tools', async () => {
    const homeDir = await tempDir('mcp-home-');
    const workDir = await tempDir('mcp-work-');
    const bg = new Map<string, BgHandle>();
    const env = await mountHttp([
      createMcp({
        workDir,
        home: homeDir,
        trusted: true,
        servers: {
          ghost: { transport: 'stdio', command: process.execPath, args: ['-e', 'process.exit(0)'] },
        },
      }),
      bindTestLlm(createMockRequester()),
      bindTestBgTool(bg),
    ]);
    await openMain(env, 'ses_tools');

    const servers = await get(env, '/mcp/servers');
    expect(servers.status).toBe(200);
    const serversBody = await servers.json();
    expect(serversBody.data).toHaveLength(1);
    expect(serversBody.data[0]).toMatchObject({
      name: 'ghost',
      source: 'global',
      origin: 'props',
      mutable: false,
      config: { transport: 'stdio', command: process.execPath, args: ['-e', 'process.exit(0)'] },
    });

    const restarted = await post(env, '/mcp/servers/ghost:restart');
    expect(restarted.status).toBe(200);
    expect(await restarted.json()).toMatchObject({ data: { restarting: true } });

    const missingServer = await post(env, '/mcp/servers/nope:restart');
    expect(missingServer.status).toBe(200);
    expect(await missingServer.json()).toMatchObject({ code: 40408 });

    const tools = await get(env, '/tools?session_id=ses_tools');
    expect(tools.status).toBe(200);
    const toolsBody = await tools.json();
    const testBg = (toolsBody.data.tools as { name: string }[]).find((tool) => tool.name === 'TestBg');
    expect(testBg).toMatchObject({
      name: 'TestBg',
      description: 'test background tool',
      input_schema: null,
      source: 'builtin',
      active: true,
    });

    const emptyTools = await get(env, '/tools?session_id=ses_ghost');
    expect((await emptyTools.json()).data.tools).toEqual([]);

    const bare = await mountHttp([bindTestLlm(createMockRequester())]);
    const unavailable = await get(bare, '/mcp/servers');
    expect(unavailable.status).toBe(200);
    expect(await unavailable.json()).toMatchObject({ code: 40944 });
  });

  it('manages mcp servers over the v2 management routes', async () => {
    const homeDir = await tempDir('mcp-mgmt-home-');
    const workDir = await tempDir('mcp-mgmt-work-');
    const env = await mountHttp([
      createMcp({ workDir, home: homeDir, host: createNodeOsHost(), trusted: true }),
      bindTestLlm(createMockRequester()),
    ]);

    const empty = await get(env, '/mcp/servers');
    expect(empty.status).toBe(200);
    expect((await empty.json()).data).toEqual([]);

    const created = await post(env, '/mcp/servers', {
      name: 'fake',
      transport: 'stdio',
      command: process.execPath,
      args: [mcpFixturePath],
    });
    expect(created.status).toBe(200);
    const createdBody = await created.json();
    expect(createdBody.data).toHaveLength(1);
    expect(createdBody.data[0]).toMatchObject({
      name: 'fake',
      source: 'global',
      origin: join(homeDir, 'mcp.json'),
      mutable: true,
      config: { transport: 'stdio', command: process.execPath, args: [mcpFixturePath] },
    });
    const onDisk = JSON.parse(await readFile(join(homeDir, 'mcp.json'), 'utf8')) as {
      mcpServers: Record<string, unknown>;
    };
    expect(Object.keys(onDisk.mcpServers)).toEqual(['fake']);
    expect(env.app.resolve(McpRef).list()).toMatchObject([
      { name: 'fake', status: 'connected', toolCount: 5 },
    ]);

    const duplicate = await post(env, '/mcp/servers', {
      name: 'fake',
      transport: 'stdio',
      command: process.execPath,
      args: [mcpFixturePath],
    });
    expect(duplicate.status).toBe(200);
    expect(await duplicate.json()).toMatchObject({ code: 40001 });

    const single = await get(env, '/mcp/servers/fake');
    expect(single.status).toBe(200);
    expect((await single.json()).data).toMatchObject({ name: 'fake', mutable: true });

    const missing = await get(env, '/mcp/servers/nope');
    expect(missing.status).toBe(200);
    expect(await missing.json()).toMatchObject({ code: 40408, msg: 'MCP server "nope" was not found' });

    const updated = await put(env, '/mcp/servers/fake', {
      transport: 'stdio',
      command: process.execPath,
      args: [mcpFixturePath],
      env: { FOO: 'bar' },
    });
    expect(updated.status).toBe(200);
    const updatedBody = await updated.json();
    expect(updatedBody.data[0].config.env).toEqual({ FOO: 'bar' });

    const removed = await del(env, '/mcp/servers/fake');
    expect(removed.status).toBe(200);
    expect((await removed.json()).data).toEqual([]);
    expect(env.app.resolve(McpRef).list()).toMatchObject([{ name: 'fake', status: 'removed' }]);

    const removedAgain = await del(env, '/mcp/servers/fake');
    expect(removedAgain.status).toBe(200);

    const invalid = await post(env, '/mcp/servers', { name: 'x', transport: 'bogus' });
    expect(invalid.status).toBe(200);
    expect(await invalid.json()).toMatchObject({ code: 40001 });

    const bare = await mountHttp([bindTestLlm(createMockRequester())]);
    const unavailableCreate = await post(bare, '/mcp/servers', {
      name: 'fake',
      transport: 'stdio',
      command: process.execPath,
      args: [mcpFixturePath],
    });
    expect(unavailableCreate.status).toBe(200);
    expect(await unavailableCreate.json()).toMatchObject({ code: 40944 });
    const unavailableStatuses = await get(bare, '/mcp/auth-statuses');
    expect(unavailableStatuses.status).toBe(200);
    expect(await unavailableStatuses.json()).toMatchObject({ code: 40944 });
  }, 30_000);

  it('tests and inspects mcp servers and reports auth statuses over the action routes', async () => {
    const homeDir = await tempDir('mcp-probe-home-');
    const workDir = await tempDir('mcp-probe-work-');
    const env = await mountHttp([
      createMcp({
        workDir,
        home: homeDir,
        host: createNodeOsHost(),
        servers: {
          fake: { transport: 'stdio', command: process.execPath, args: [mcpFixturePath] },
          web: { transport: 'http', url: 'http://127.0.0.1:1/mcp' },
        },
      }),
      bindTestLlm(createMockRequester()),
    ]);

    const tested = await post(env, '/mcp/servers:test', {
      server: { name: 'probe', transport: 'stdio', command: process.execPath, args: [mcpFixturePath] },
    });
    expect(tested.status).toBe(200);
    const testedBody = await tested.json();
    expect(testedBody.data.success).toBe(true);
    expect(testedBody.data.output).toContain('Connected to MCP server "probe".');
    expect(testedBody.data.output).toContain('Available tools: 5');
    expect(testedBody.data.output).toContain('- echo: Echo back the provided text.');

    const testedByName = await post(env, '/mcp/servers:test', { name: 'fake' });
    expect((await testedByName.json()).data.success).toBe(true);

    const testedMissing = await post(env, '/mcp/servers:test', { name: 'ghost' });
    expect(testedMissing.status).toBe(200);
    expect(await testedMissing.json()).toMatchObject({ code: 40408 });

    const testedBoth = await post(env, '/mcp/servers:test', {
      name: 'fake',
      server: { name: 'other', transport: 'stdio', command: process.execPath, args: [mcpFixturePath] },
    });
    expect(testedBoth.status).toBe(200);
    expect(await testedBoth.json()).toMatchObject({ code: 40001 });

    const inspected = await post(env, '/mcp/servers:inspect', {});
    expect(inspected.status).toBe(200);
    const inspections = (await inspected.json()).data as Record<string, unknown>[];
    expect(inspections).toHaveLength(2);
    const fake = inspections.find((inspection) => inspection['runtimeName'] === 'fake');
    expect(fake).toMatchObject({
      serverId: 'global:fake',
      locator: { source: 'global', name: 'fake' },
      origin: 'global',
      enabled: true,
      editable: false,
      authStatus: 'not-applicable',
    });
    expect(fake?.['checkedAt']).toBeUndefined();
    const web = inspections.find((inspection) => inspection['runtimeName'] === 'web');
    expect(web).toMatchObject({
      serverId: 'global:web',
      canonicalUrl: 'http://127.0.0.1:1/mcp',
      authStatus: 'unavailable',
    });
    expect(typeof web?.['checkedAt']).toBe('number');
    expect(typeof web?.['error']).toBe('string');

    const targeted = await post(env, '/mcp/servers:inspect', {
      targets: [{ source: 'global', name: 'ghost' }],
    });
    expect(targeted.status).toBe(200);
    expect(await targeted.json()).toMatchObject({ code: 40408 });

    const statuses = await get(env, '/mcp/auth-statuses');
    expect(statuses.status).toBe(200);
    expect((await statuses.json()).data).toEqual([
      { name: 'fake', authStatus: 'not-applicable' },
      { name: 'web', authStatus: 'not-applicable' },
    ]);

    const badVerify = await get(env, '/mcp/auth-statuses?verify=bogus');
    expect(badVerify.status).toBe(200);
    expect(await badVerify.json()).toMatchObject({ code: 40001 });

    const restarted = await post(env, '/mcp/servers/fake:restart');
    expect(restarted.status).toBe(200);
    expect(await restarted.json()).toMatchObject({ data: { restarting: true } });

    const unsupported = await post(env, '/mcp/servers/:bogus', {});
    expect(unsupported.status).toBe(200);
    expect(await unsupported.json()).toMatchObject({ code: 40001 });
  }, 30_000);

  it('runs the mcp oauth routes', async () => {
    const oauth = await startFakeMcpOAuthServer();
    try {
      const homeDir = await tempDir('mcp-oauth-home-');
      const workDir = await tempDir('mcp-oauth-work-');
      const env = await mountHttp([
        createMcp({
          workDir,
          home: homeDir,
          servers: {
            auth: { transport: 'http', url: `${oauth.url}/mcp` },
            fake: { transport: 'stdio', command: process.execPath, args: [mcpFixturePath] },
          },
        }),
        bindTestLlm(createMockRequester()),
      ]);

      const begin = await post(env, '/mcp/auth:begin', { source: 'global', name: 'auth' });
      expect(begin.status).toBe(200);
      const beginBody = await begin.json();
      expect(beginBody.data.status).toBe('authorization-required');
      expect(beginBody.data.authorizationUrl.startsWith(`${oauth.url}/authorize?`)).toBe(true);
      const flowId = beginBody.data.flowId as string;
      expect(flowId.length).toBeGreaterThan(0);

      const unknownComplete = await post(env, '/mcp/auth:complete', { flowId: 'unknown-flow' });
      expect(unknownComplete.status).toBe(200);
      expect(await unknownComplete.json()).toMatchObject({ code: 40001 });

      const timedOut = await post(env, '/mcp/auth:complete', { flowId, timeoutMs: 50 });
      expect(timedOut.status).toBe(200);
      expect(await timedOut.json()).toMatchObject({ code: 40929 });

      const beginAgain = await post(env, '/mcp/auth:begin', { source: 'global', name: 'auth' });
      const beginAgainBody = await beginAgain.json();
      expect(beginAgainBody.data.status).toBe('authorization-required');
      const cancelled = await post(env, '/mcp/auth:cancel', { flowId: beginAgainBody.data.flowId });
      expect(cancelled.status).toBe(200);
      expect((await cancelled.json()).data).toBeNull();
      const cancelUnknown = await post(env, '/mcp/auth:cancel', { flowId: 'unknown-flow' });
      expect(cancelUnknown.status).toBe(200);

      const reset = await post(env, '/mcp/auth:reset', { source: 'global', name: 'auth' });
      expect(reset.status).toBe(200);
      expect((await reset.json()).data).toBeNull();

      const stdioBegin = await post(env, '/mcp/auth:begin', { source: 'global', name: 'fake' });
      expect(stdioBegin.status).toBe(200);
      expect(await stdioBegin.json()).toMatchObject({ code: 40001 });

      const missingBegin = await post(env, '/mcp/auth:begin', { source: 'global', name: 'ghost' });
      expect(missingBegin.status).toBe(200);
      expect(await missingBegin.json()).toMatchObject({ code: 40408 });

      const badAction = await post(env, '/mcp/auth:bogus', {});
      expect(badAction.status).toBe(200);
      expect(await badAction.json()).toMatchObject({ code: 40001 });
    } finally {
      await oauth.close();
    }
  }, 30_000);
});

describe('feature-http workspaces routes', () => {
  it('registers, renames, trusts, adds dirs and deletes workspaces over the registry routes', async () => {
    const home = await tempDir('ws-http-home-');
    const root = await tempDir('ws-http-root-');
    const env = await mountHttp([createWorkspaces({ homeDir: home, host: createNodeOsHost() })]);

    const relative = await post(env, '/workspaces', { root: 'relative/path' });
    expect(relative.status).toBe(200);
    const relativeBody = await relative.json();
    expect(relativeBody.code).toBe(40001);
    expect(relativeBody.details).toEqual([{ path: 'root', message: 'root must be an absolute path' }]);

    const missingRoot = join(root, 'missing');
    const missing = await post(env, '/workspaces', { root: missingRoot });
    expect(missing.status).toBe(200);
    expect(await missing.json()).toMatchObject({
      code: 40409,
      msg: `root ${missingRoot} does not exist`,
    });

    const created = await post(env, '/workspaces', { root, name: 'HTTP Root' });
    expect(created.status).toBe(200);
    const createdBody = await created.json();
    const workspaceId = createdBody.data.id as string;
    expect(workspaceId).toMatch(/^wd_[a-z0-9._-]+_[0-9a-f]{12}$/);
    expect(createdBody.data).toMatchObject({ root, name: 'HTTP Root', session_count: 0 });
    expect(Number.isNaN(Date.parse(createdBody.data.created_at))).toBe(false);
    expect(Number.isNaN(Date.parse(createdBody.data.last_opened_at))).toBe(false);

    await env.app.open({ sessionId: 'ses_ws_http', metadata: { workspaceId } });
    const listed = await get(env, '/workspaces');
    const listBody = await listed.json();
    expect(listBody.data.items).toHaveLength(1);
    expect(listBody.data.items[0]).toMatchObject({ id: workspaceId, session_count: 1 });
    const boundView = await get(env, '/sessions/ses_ws_http');
    expect((await boundView.json()).data).toMatchObject({ workspace_id: workspaceId });

    const renamed = await fetch(`${env.origin}/api/v1/workspaces/${workspaceId}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'Renamed Root' }),
    });
    expect(renamed.status).toBe(200);
    expect((await renamed.json()).data).toMatchObject({ id: workspaceId, name: 'Renamed Root' });

    const invalidId = await fetch(`${env.origin}/api/v1/workspaces/not-an-id/trust`);
    expect(invalidId.status).toBe(200);

    const ghostId = 'wd_ghost_000000000000';
    const renameGhost = await fetch(`${env.origin}/api/v1/workspaces/${ghostId}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'x' }),
    });
    expect(renameGhost.status).toBe(200);
    expect(await renameGhost.json()).toMatchObject({
      code: 40410,
      msg: `workspace ${ghostId} does not exist`,
    });

    const trustBefore = await get(env, `/workspaces/${workspaceId}/trust`);
    expect((await trustBefore.json()).data).toEqual({ trusted: false });
    const trusted = await post(env, `/workspaces/${workspaceId}/trust`);
    expect((await trusted.json()).data).toEqual({ trusted: true });
    const trustAfter = await get(env, `/workspaces/${workspaceId}/trust`);
    expect((await trustAfter.json()).data).toEqual({ trusted: true });
    const untrusted = await post(env, `/workspaces/${workspaceId}/untrust`);
    expect((await untrusted.json()).data).toEqual({ trusted: false });

    const extra = await tempDir('ws-http-extra-');
    const added = await post(env, `/workspaces/${workspaceId}/add-dir`, { path: extra });
    expect(added.status).toBe(200);
    expect((await added.json()).data).toMatchObject({
      project_root: root,
      config_path: join(root, '.kimi-code', 'local.toml'),
      additional_dirs: [extra],
      persisted: true,
    });
    expect(await readFile(join(root, '.kimi-code', 'local.toml'), 'utf8')).toContain(extra);

    const addMissing = await post(env, `/workspaces/${workspaceId}/add-dir`, {
      path: join(root, 'ghost'),
    });
    expect(addMissing.status).toBe(200);
    const addGhost = await post(env, `/workspaces/${ghostId}/add-dir`, { path: extra });
    expect(addGhost.status).toBe(200);
    expect(await addGhost.json()).toMatchObject({ code: 40410 });

    const deleted = await del(env, `/workspaces/${workspaceId}`);
    expect(deleted.status).toBe(200);
    expect(await deleted.json()).toMatchObject({ data: { deleted: true } });
    expect(((await (await get(env, '/workspaces')).json()).data.items)).toEqual([]);
    const deleteAgain = await del(env, `/workspaces/${workspaceId}`);
    expect(deleteAgain.status).toBe(200);
    expect(await deleteAgain.json()).toMatchObject({ code: 40410 });
  });

  it('serves workspace fs browse, home, content and mkdir routes', async () => {
    const root = await tempDir('ws-http-fs-');
    await mkdir(join(root, 'docs'));
    await writeFile(join(root, 'docs', 'note.txt'), 'note body\n', 'utf8');
    const env = await mountHttp([
      createWorkspaces({ homeDir: await tempDir('ws-http-home-'), host: createNodeOsHost() }),
    ]);

    const home = await get(env, '/fs:home');
    expect(home.status).toBe(200);
    const homeBody = await home.json();
    expect(typeof homeBody.data.home).toBe('string');
    expect(homeBody.data.recent_roots).toEqual([]);

    const realRoot = await realpath(root);
    const browse = await get(env, `/fs:browse?path=${encodeURIComponent(root)}`);
    expect(browse.status).toBe(200);
    const browseBody = await browse.json();
    expect(browseBody.data.path).toBe(realRoot);
    expect(browseBody.data.entries).toEqual([
      { name: 'docs', path: join(realRoot, 'docs'), is_dir: true },
    ]);

    const relativeBrowse = await get(env, '/fs:browse?path=relative%2Fpath');
    expect(relativeBrowse.status).toBe(200);
    expect(await relativeBrowse.json()).toMatchObject({ code: 40001 });

    const filePath = join(root, 'docs', 'note.txt');
    const content = await get(env, `/fs:content?path=${encodeURIComponent(filePath)}`);
    expect(content.status).toBe(200);
    expect(await content.text()).toBe('note body\n');
    const etag = content.headers.get('etag');
    expect(typeof etag).toBe('string');
    expect(content.headers.get('content-type')).toContain('text/plain');
    expect(content.headers.get('content-length')).toBe('10');

    const cached = await fetch(
      `${env.origin}/api/v1/fs:content?path=${encodeURIComponent(filePath)}`,
      { headers: { 'if-none-match': etag as string } },
    );
    expect(cached.status).toBe(304);

    const ranged = await fetch(
      `${env.origin}/api/v1/fs:content?path=${encodeURIComponent(filePath)}`,
      { headers: { range: 'bytes=0-3' } },
    );
    expect(ranged.status).toBe(206);
    expect(ranged.headers.get('content-range')).toBe('bytes 0-3/10');
    expect(await ranged.text()).toBe('note');

    const dirContent = await get(env, `/fs:content?path=${encodeURIComponent(join(root, 'docs'))}`);
    expect(dirContent.status).toBe(200);
    expect(await dirContent.json()).toMatchObject({
      code: 40906,
      msg: `path is a directory: ${join(root, 'docs')}`,
    });

    const missingContent = await get(
      env,
      `/fs:content?path=${encodeURIComponent(join(root, 'missing.txt'))}`,
    );
    expect(missingContent.status).toBe(200);
    expect(await missingContent.json()).toMatchObject({ code: 40409 });

    const relativeContent = await get(env, '/fs:content?path=relative%2Ffile.txt');
    expect(relativeContent.status).toBe(200);

    const made = await post(env, '/fs:mkdir', { path: join(root, 'newdir') });
    expect(made.status).toBe(200);
    expect(await made.json()).toMatchObject({ data: { path: join(root, 'newdir') } });

    const duplicate = await post(env, '/fs:mkdir', { path: join(root, 'newdir') });
    expect(duplicate.status).toBe(200);
    expect(await duplicate.json()).toMatchObject({
      code: 40919,
      msg: `path already exists: ${join(root, 'newdir')}`,
    });

    const missingParent = await post(env, '/fs:mkdir', { path: join(root, 'ghost', 'child') });
    expect(missingParent.status).toBe(200);
    expect(await missingParent.json()).toMatchObject({
      code: 40409,
      msg: `parent path not found: ${join(root, 'ghost', 'child')}`,
    });

    const relativeMkdir = await post(env, '/fs:mkdir', { path: 'relative' });
    expect(relativeMkdir.status).toBe(200);
  });

  it('serves session fs actions, workspace search and suggest, root suggest and downloads', async () => {
    const root = await tempDir('ws-http-sesfs-');
    await mkdir(join(root, 'docs'));
    await writeFile(join(root, 'docs', 'note.txt'), 'note body\n', 'utf8');
    await writeFile(join(root, 'top.ts'), 'const top = 1;\n', 'utf8');
    const env = await mountHttp([
      createWorkspaces({ homeDir: await tempDir('ws-http-home-'), host: createNodeOsHost() }),
    ]);
    await env.app.open({ sessionId: 'ses_fs', metadata: { cwd: root } });

    const listed = await post(env, '/sessions/ses_fs/fs:list', {});
    expect(listed.status).toBe(200);
    const listBody = await listed.json();
    expect(
      (listBody.data.items as { path: string; kind: string }[]).map(
        (entry) => `${entry.kind}:${entry.path}`,
      ),
    ).toEqual(['directory:docs', 'file:top.ts']);
    expect(listBody.data.truncated).toBe(false);

    const read = await post(env, '/sessions/ses_fs/fs:read', { path: 'docs/note.txt' });
    expect(read.status).toBe(200);
    expect((await read.json()).data).toMatchObject({
      path: 'docs/note.txt',
      content: 'note body\n',
      encoding: 'utf-8',
      truncated: false,
    });

    const stat = await post(env, '/sessions/ses_fs/fs:stat', { path: 'top.ts' });
    expect((await stat.json()).data).toMatchObject({
      path: 'top.ts',
      kind: 'file',
      mime: 'text/typescript',
    });

    const made = await post(env, '/sessions/ses_fs/fs:mkdir', { path: 'newdir' });
    expect((await made.json()).data).toMatchObject({ path: 'newdir', kind: 'directory' });

    const searched = await post(env, '/sessions/ses_fs/fs:search', { query: 'note' });
    const searchedBody = await searched.json();
    expect(searchedBody.data.items).toHaveLength(1);
    expect(searchedBody.data.items[0]).toMatchObject({ path: 'docs/note.txt', kind: 'file' });

    const grepped = await post(env, '/sessions/ses_fs/fs:grep', { pattern: 'note' });
    const greppedBody = await grepped.json();
    expect(greppedBody.data.files[0]).toMatchObject({ path: 'docs/note.txt' });

    const escaped = await post(env, '/sessions/ses_fs/fs:read', { path: '../secret.txt' });
    expect(escaped.status).toBe(200);
    expect(await escaped.json()).toMatchObject({ code: 41304 });

    const noGit = await post(env, '/sessions/ses_fs/fs:git_status', {});
    expect(noGit.status).toBe(200);
    expect(await noGit.json()).toMatchObject({ code: 40908 });
    const noGitDiff = await post(env, '/sessions/ses_fs/fs:diff', { path: 'docs/note.txt' });
    expect(noGitDiff.status).toBe(200);
    expect(await noGitDiff.json()).toMatchObject({ code: 40908 });
    const badTail = await post(env, '/sessions/ses_fs/other', {});
    expect(badTail.status).toBe(200);
    expect(await badTail.json()).toMatchObject({ code: 40001, msg: 'unsupported action: other' });
    const invalidBody = await post(env, '/sessions/ses_fs/fs:read', { path: 42 });
    expect(invalidBody.status).toBe(200);
    expect((await invalidBody.json()).code).toBe(40001);

    const missingSession = await post(env, '/sessions/ses_ghost/fs:list', {});
    expect(missingSession.status).toBe(200);
    expect(await missingSession.json()).toMatchObject({ code: 40401 });

    await env.app.open({ sessionId: 'ses_unbound' });
    const unbound = await post(env, '/sessions/ses_unbound/fs:list', {});
    expect(unbound.status).toBe(200);
    expect(await unbound.json()).toMatchObject({
      code: 40410,
      msg: 'session ses_unbound has no workspace bound',
    });

    const face = env.app.resolve(WorkspaceRef);
    const ws = await face.createOrTouch(root);
    await env.app.open({ sessionId: 'ses_bound', metadata: { workspaceId: ws.id } });
    const boundList = await post(env, '/sessions/ses_bound/fs:list', {});
    expect(boundList.status).toBe(200);

    const fallback = await post(env, `/sessions/${ws.id}/fs:search`, { query: 'note' });
    expect(fallback.status).toBe(200);
    expect(((await fallback.json()).data.items[0]).path).toBe('docs/note.txt');

    const byId = await post(env, '/workspace/fs:search', { workspace: ws.id, query: 'note' });
    expect((await byId.json()).data.items[0]).toMatchObject({ path: 'docs/note.txt' });

    const otherRoot = await tempDir('ws-http-other-');
    await writeFile(join(otherRoot, 'other.txt'), 'other\n', 'utf8');
    const byRoot = await post(env, '/workspace/fs:search', { workspace: otherRoot, query: 'other' });
    expect(byRoot.status).toBe(200);
    expect(((await byRoot.json()).data.items[0]).path).toBe('other.txt');
    expect(face.findByRoot(otherRoot)).toBeDefined();

    const unknownWorkspace = await post(env, '/workspace/fs:search', {
      workspace: 'wd_ghost_000000000000',
      query: 'x',
    });
    expect(unknownWorkspace.status).toBe(200);
    expect(await unknownWorkspace.json()).toMatchObject({
      code: 40410,
      msg: 'workspace wd_ghost_000000000000 does not exist',
    });

    const suggested = await post(env, '/workspace/fs:suggest', { workspace: ws.id, query: 'note' });
    expect(((await suggested.json()).data.items[0]).path).toBe('docs/note.txt');

    const rootSuggest = await post(env, '/fs:suggest', { roots: [root], query: 'note' });
    expect(((await rootSuggest.json()).data.items[0]).path).toBe('docs/note.txt');
    const badRoot = await post(env, '/fs:suggest', { roots: ['relative'], query: 'x' });
    expect(badRoot.status).toBe(200);
    expect(await badRoot.json()).toMatchObject({
      code: 40001,
      msg: 'root must be an absolute path: relative',
    });
    const missingRoot = await post(env, '/fs:suggest', { roots: [join(root, 'ghost')], query: 'x' });
    expect(missingRoot.status).toBe(200);
    expect(await missingRoot.json()).toMatchObject({
      code: 40409,
      msg: `root not found: ${join(root, 'ghost')}`,
    });

    const download = await fetch(`${env.origin}/api/v1/sessions/ses_fs/fs/docs/note.txt:download`);
    expect(download.status).toBe(200);
    expect(download.headers.get('content-disposition')).toBe('attachment; filename="note.txt"');
    expect(download.headers.get('content-length')).toBe('10');
    expect(await download.text()).toBe('note body\n');

    const downloadMissing = await fetch(`${env.origin}/api/v1/sessions/ses_fs/fs/ghost.txt:download`);
    expect(downloadMissing.status).toBe(200);
    expect(await downloadMissing.json()).toMatchObject({ code: 40409 });

    const downloadEscape = await fetch(
      `${env.origin}/api/v1/sessions/ses_fs/fs/docs/%2E%2E%2Fsecret.txt:download`,
    );
    expect(downloadEscape.status).toBe(200);
    expect(await downloadEscape.json()).toMatchObject({ code: 41304 });

    const downloadBadAction = await fetch(`${env.origin}/api/v1/sessions/ses_fs/fs/docs/note.txt`);
    expect(downloadBadAction.status).toBe(200);

    const downloadNoSession = await fetch(`${env.origin}/api/v1/sessions/ses_ghost/fs/a.txt:download`);
    expect(downloadNoSession.status).toBe(200);
    expect(await downloadNoSession.json()).toMatchObject({ code: 40401 });
  });

  it('serves fs git_status and diff over the session fs action route', async () => {
    const root = await tempDir('ws-http-git-');
    await git(root, 'init', '-b', 'main');
    await git(root, 'config', 'user.email', 'fs-test@example.com');
    await git(root, 'config', 'user.name', 'FS Test');
    await git(root, 'config', 'commit.gpgsign', 'false');
    await writeFile(join(root, 'tracked.txt'), 'one\ntwo\n', 'utf8');
    await git(root, 'add', 'tracked.txt');
    await git(root, 'commit', '-m', 'init');
    await writeFile(join(root, 'tracked.txt'), 'one\ntwo\nthree\n', 'utf8');
    await writeFile(join(root, 'untracked.txt'), 'new\n', 'utf8');
    const env = await mountHttp([
      createWorkspaces({ homeDir: await tempDir('ws-http-home-'), host: createNodeOsHost() }),
    ]);
    await env.app.open({ sessionId: 'ses_git', metadata: { cwd: root } });

    const status = await post(env, '/sessions/ses_git/fs:git_status', {});
    expect(status.status).toBe(200);
    const statusBody = await status.json();
    expect(statusBody.data).toMatchObject({
      branch: 'main',
      ahead: 0,
      behind: 0,
      entries: { 'tracked.txt': 'modified', 'untracked.txt': 'untracked' },
      pullRequest: null,
    });
    expect(statusBody.data.additions).toBe(1);
    expect(statusBody.data.deletions).toBe(0);

    const filtered = await post(env, '/sessions/ses_git/fs:git_status', { paths: ['tracked.txt'] });
    expect((await filtered.json()).data.entries).toEqual({ 'tracked.txt': 'modified' });
    const escaped = await post(env, '/sessions/ses_git/fs:git_status', { paths: ['../x.txt'] });
    expect((await escaped.json()).code).toBe(41304);

    const diff = await post(env, '/sessions/ses_git/fs:diff', { path: 'tracked.txt' });
    const diffBody = await diff.json();
    expect(diffBody.data).toMatchObject({ path: 'tracked.txt', truncated: false });
    expect(diffBody.data.diff).toContain('+three');

    const untrackedDiff = await post(env, '/sessions/ses_git/fs:diff', { path: 'untracked.txt' });
    const untrackedBody = await untrackedDiff.json();
    expect(untrackedBody.data).toMatchObject({ path: 'untracked.txt', truncated: false });
    expect(untrackedBody.data.diff).toContain('new file mode');

    const missingDiff = await post(env, '/sessions/ses_git/fs:diff', { path: 'ghost.txt' });
    expect(missingDiff.status).toBe(200);
    expect((await missingDiff.json()).code).toBe(40409);
  });

  it('serves fs open, open-in and reveal through the os host launch port', async () => {
    vi.stubEnv('KIMI_CODE_EDITOR', '');
    vi.stubEnv('VISUAL', '');
    vi.stubEnv('EDITOR', '');
    const root = await tempDir('ws-http-launch-');
    await mkdir(join(root, 'docs'));
    await writeFile(join(root, 'docs', 'note.txt'), 'note body\n', 'utf8');
    const home = await tempDir('ws-http-home-');
    const node = createNodeOsHost();
    const spawns: { command: string; args: readonly string[]; shell?: boolean }[] = [];
    const host: OsHost = {
      ...node,
      process: {
        spawn: async (command, args = [], options = {}) => {
          spawns.push({ command, args, shell: options.shell });
          const proc: OsProcess = {
            pid: 4242,
            exitCode: 0,
            stdin: { write: () => {}, end: () => {} },
            stdout: (async function* () {})(),
            stderr: (async function* () {})(),
            wait: async () => 0,
            kill: async () => {},
            dispose: () => {},
          };
          return await Promise.resolve(proc);
        },
      },
      environment: {
        osKind: 'macOS',
        osArch: 'arm64',
        osVersion: '1',
        shellName: 'sh',
        shellPath: '/bin/sh',
        pathClass: 'posix',
        homeDir: home,
        ready: Promise.resolve(),
      },
    };
    const env = await mountHttp([createWorkspaces({ homeDir: home, host })]);
    await env.app.open({ sessionId: 'ses_launch', metadata: { cwd: root } });

    const opened = await post(env, '/sessions/ses_launch/fs:open', { path: 'docs/note.txt' });
    expect(opened.status).toBe(200);
    expect(await opened.json()).toMatchObject({ code: 0, data: { opened: true } });
    expect(spawns.at(-1)).toMatchObject({
      command: 'open',
      args: [join(root, 'docs', 'note.txt')],
    });

    vi.stubEnv('KIMI_CODE_EDITOR', 'code');
    const openedAtLine = await post(env, '/sessions/ses_launch/fs:open', {
      path: 'docs/note.txt',
      line: 3,
    });
    expect((await openedAtLine.json()).data).toMatchObject({ opened: true });
    expect(spawns.at(-1)).toMatchObject({
      command: `code '${join(root, 'docs', 'note.txt')}:3'`,
      shell: true,
    });
    vi.stubEnv('KIMI_CODE_EDITOR', '');

    const revealed = await post(env, '/sessions/ses_launch/fs:reveal', { path: 'docs/note.txt' });
    expect((await revealed.json()).data).toMatchObject({ revealed: true });
    expect(spawns.at(-1)).toMatchObject({
      command: 'open',
      args: ['-R', join(root, 'docs', 'note.txt')],
    });

    const openedIn = await post(env, '/sessions/ses_launch/fs:open-in', {
      app_id: 'iterm',
      path: 'docs',
    });
    expect((await openedIn.json()).data).toMatchObject({ opened: true });
    expect(spawns.at(-1)).toMatchObject({
      command: 'open',
      args: ['-a', 'iTerm', join(root, 'docs')],
    });

    const badApp = await post(env, '/sessions/ses_launch/fs:open-in', {
      app_id: 'ghost',
      path: 'docs',
    });
    expect((await badApp.json()).code).toBe(40001);
    const missingPath = await post(env, '/sessions/ses_launch/fs:open', { path: 'ghost.txt' });
    expect((await missingPath.json()).code).toBe(40409);
    const escapedOpen = await post(env, '/sessions/ses_launch/fs:reveal', { path: '../secret.txt' });
    expect((await escapedOpen.json()).code).toBe(41304);

    const hostless = await mountHttp([createWorkspaces({ homeDir: await tempDir('ws-http-mem-') })]);
    await hostless.app.open({ sessionId: 'ses_no_host', metadata: { cwd: root } });
    const unavailable = await post(hostless, '/sessions/ses_no_host/fs:open', {
      path: 'docs/note.txt',
    });
    expect(unavailable.status).toBe(200);
    expect(await unavailable.json()).toMatchObject({ code: 40946 });
  });

  it('reports 40945 when workspaces is absent and 40946 when the fs capability is missing', async () => {
    const bare = await mountHttp([]);
    const unavailable = await get(bare, '/workspaces');
    expect(unavailable.status).toBe(200);
    expect(await unavailable.json()).toMatchObject({ code: 40945 });
    const bareAction = await post(bare, '/sessions/ses_x/fs:list', {});
    expect(bareAction.status).toBe(200);
    expect(await bareAction.json()).toMatchObject({ code: 40945 });
    const bareSuggest = await post(bare, '/fs:suggest', { roots: ['/'], query: 'x' });
    expect(bareSuggest.status).toBe(200);
    const bareWorkspaceSearch = await post(bare, '/workspace/fs:search', {
      workspace: '/tmp',
      query: 'x',
    });
    expect(bareWorkspaceSearch.status).toBe(200);
    const bareDownload = await fetch(`${bare.origin}/api/v1/sessions/ses_x/fs/a.txt:download`);
    expect(bareDownload.status).toBe(200);

    const memoryOnly = await mountHttp([
      createWorkspaces({ homeDir: await tempDir('ws-http-mem-') }),
    ]);
    const listed = await get(memoryOnly, '/workspaces');
    expect(listed.status).toBe(200);
    expect((await listed.json()).data.items).toEqual([]);

    const root = await tempDir('ws-http-nohost-');
    const created = await post(memoryOnly, '/workspaces', { root });
    expect(created.status).toBe(200);
    const workspaceId = (await created.json()).data.id as string;
    const trust = await post(memoryOnly, `/workspaces/${workspaceId}/trust`, {});
    expect(trust.status).toBe(200);

    const browseNoHost = await get(memoryOnly, '/fs:browse');
    expect(browseNoHost.status).toBe(200);
    expect(await browseNoHost.json()).toMatchObject({ code: 40946 });
    const mkdirNoHost = await post(memoryOnly, '/fs:mkdir', { path: join(root, 'x') });
    expect(mkdirNoHost.status).toBe(200);
    const sessionFsNoHost = await post(memoryOnly, '/sessions/ses_x/fs:list', {});
    expect(sessionFsNoHost.status).toBe(200);
    expect(await sessionFsNoHost.json()).toMatchObject({ code: 40946 });
    const suggestNoHost = await post(memoryOnly, '/fs:suggest', { roots: [root], query: 'x' });
    expect(suggestNoHost.status).toBe(200);
    const addDirNoHost = await post(memoryOnly, `/workspaces/${workspaceId}/add-dir`, { path: root });
    expect(addDirNoHost.status).toBe(200);
    expect(await addDirNoHost.json()).toMatchObject({ code: 40946 });
  });
});

async function startFakeMcpOAuthServer(): Promise<{ url: string; close: () => Promise<void> }> {
  let base = '';
  const server = createHttpServer((req, res) => {
    const path = req.url ?? '/';
    if (path.startsWith('/.well-known/oauth-protected-resource')) {
      res.writeHead(404).end();
      return;
    }
    if (path.startsWith('/.well-known/oauth-authorization-server')) {
      res.writeHead(200, { 'content-type': 'application/json' }).end(
        JSON.stringify({
          issuer: base,
          authorization_endpoint: `${base}/authorize`,
          token_endpoint: `${base}/token`,
          registration_endpoint: `${base}/register`,
          response_types_supported: ['code'],
          grant_types_supported: ['authorization_code', 'refresh_token'],
          code_challenge_methods_supported: ['S256'],
        }),
      );
      return;
    }
    if (path === '/register' && req.method === 'POST') {
      const chunks: Buffer[] = [];
      req.on('data', (chunk: Buffer) => chunks.push(chunk));
      req.on('end', () => {
        const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>;
        res.writeHead(201, { 'content-type': 'application/json' }).end(
          JSON.stringify({ ...body, client_id: 'fake-client-id', client_id_issued_at: 1700000000 }),
        );
      });
      return;
    }
    res.writeHead(401, { 'content-type': 'application/json' }).end(JSON.stringify({ error: 'unauthorized' }));
  });
  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('no address');
  base = `http://127.0.0.1:${address.port}`;
  return {
    url: base,
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
      }),
  };
}

type WsFrame = Record<string, unknown>;

interface WsTestClient {
  readonly frames: WsFrame[];
  readonly closed: Promise<{ code: number; reason: string }>;
  send(frame: unknown): void;
  next(match: (frame: WsFrame) => boolean): Promise<WsFrame>;
  close(): Promise<void>;
}

async function connectWsPath(env: HttpEnv, path: string): Promise<WsTestClient> {
  const socket = new WebSocket(`${env.origin.replace(/^http/, 'ws')}${path}`);
  const frames: WsFrame[] = [];
  const waiters: { match: (frame: WsFrame) => boolean; resolve: (frame: WsFrame) => void }[] = [];
  let resolveClosed: (event: { code: number; reason: string }) => void = () => {};
  const closed = new Promise<{ code: number; reason: string }>((resolve) => {
    resolveClosed = resolve;
  });
  socket.on('message', (data: RawData) => {
    const frame = JSON.parse(data.toString()) as WsFrame;
    frames.push(frame);
    for (const waiter of [...waiters]) {
      if (!waiter.match(frame)) continue;
      waiters.splice(waiters.indexOf(waiter), 1);
      waiter.resolve(frame);
    }
  });
  socket.once('close', (code: number, reason: Buffer) => {
    resolveClosed({ code, reason: reason.toString() });
  });
  await new Promise<void>((resolve, reject) => {
    socket.once('open', () => resolve());
    socket.once('error', reject);
  });
  return {
    frames,
    closed,
    send: (frame) => socket.send(JSON.stringify(frame)),
    next: (match) =>
      new Promise<WsFrame>((resolve) => {
        const existing = frames.find(match);
        if (existing !== undefined) {
          resolve(existing);
          return;
        }
        waiters.push({ match, resolve });
      }),
    close: () =>
      new Promise<void>((resolve) => {
        if (socket.readyState === WebSocket.CLOSED) {
          resolve();
          return;
        }
        socket.once('close', () => resolve());
        socket.close();
      }),
  };
}

async function connectWs(env: HttpEnv): Promise<WsTestClient> {
  return connectWsPath(env, '/api/v2/ws');
}

async function connectWsV1(env: HttpEnv): Promise<WsTestClient> {
  return connectWsPath(env, '/api/v1/ws');
}

describe('feature-http capabilities routes', () => {
  async function waitCapabilityIdle(env: HttpEnv, id: string): Promise<void> {
    for (let i = 0; i < 100; i += 1) {
      const response = await get(env, `/capabilities/${id}`);
      const body = (await response.json()) as { data: { install: { running: boolean } } };
      if (body.data.install.running !== true) return;
      await new Promise((resolve) => {
        setTimeout(resolve, 10);
      });
    }
    throw new Error('capability install never settled');
  }

  it('lists, gets and installs capabilities and maps capability errors', async () => {
    let release: (() => void) | undefined;
    let gateInstall = false;
    const entries: CapabilityEntry[] = [
      {
        id: 'kimi-cu',
        pluginId: 'kimi-cu',
        displayName: 'Kimi Computer Use',
        description: 'cu',
        supported: true,
        detect: () =>
          Promise.resolve({ version: '1.0.0', steps: [{ id: 'plugin', state: 'ok' }] }),
        install: (report) => {
          report('plugin');
          if (!gateInstall) return Promise.resolve(undefined);
          return new Promise<string | undefined>((resolve) => {
            release = () => {
              resolve(undefined);
            };
          });
        },
      },
      {
        id: 'kimi-webbridge',
        displayName: 'Kimi Browser Extension',
        description: 'wb',
        supported: false,
        detect: () => Promise.resolve({ steps: [] }),
        install: () => Promise.resolve(undefined),
      },
    ];
    const env = await mountHttp([
      createCapabilities({ homeDir: '/kimi-home', host: createNodeOsHost(), entries }),
    ]);

    const list = await get(env, '/capabilities');
    expect(list.status).toBe(200);
    const listBody = await list.json();
    expect(listBody.data.capabilities).toHaveLength(2);
    expect(listBody.data.capabilities[0]).toMatchObject({
      id: 'kimi-cu',
      pluginId: 'kimi-cu',
      displayName: 'Kimi Computer Use',
      supported: true,
      state: 'ready',
      version: '1.0.0',
      install: { running: false },
    });
    expect(listBody.data.capabilities[1]).toMatchObject({
      id: 'kimi-webbridge',
      supported: false,
      state: 'unsupported',
      steps: [],
    });

    const got = await get(env, '/capabilities/kimi-cu');
    expect(got.status).toBe(200);
    expect(await got.json()).toMatchObject({ code: 0, data: { id: 'kimi-cu', state: 'ready' } });

    const first = await post(env, '/capabilities/kimi-cu:install');
    expect(first.status).toBe(200);
    expect((await first.json()).data.install.running).toBe(true);
    await waitCapabilityIdle(env, 'kimi-cu');

    gateInstall = true;
    const gated = await post(env, '/capabilities/kimi-cu:install');
    expect((await gated.json()).data.install).toMatchObject({ running: true, step: 'plugin' });
    const inProgress = await post(env, '/capabilities/kimi-cu:install');
    expect(inProgress.status).toBe(200);
    expect(await inProgress.json()).toMatchObject({ code: 40924 });
    release?.();
    await waitCapabilityIdle(env, 'kimi-cu');

    const unsupported = await post(env, '/capabilities/kimi-webbridge:install');
    expect(unsupported.status).toBe(200);
    expect(await unsupported.json()).toMatchObject({ code: 40925 });

    const missingGet = await get(env, '/capabilities/nope');
    expect(missingGet.status).toBe(200);
    expect(await missingGet.json()).toMatchObject({ code: 40418 });
    const missingInstall = await post(env, '/capabilities/nope:install');
    expect(missingInstall.status).toBe(200);
    expect(await missingInstall.json()).toMatchObject({ code: 40418 });

    const badAction = await post(env, '/capabilities/kimi-cu:reinstall');
    expect(badAction.status).toBe(200);
    expect(await badAction.json()).toMatchObject({
      code: 40001,
      msg: 'unsupported action: kimi-cu:reinstall',
    });
    const bare = await post(env, '/capabilities/kimi-cu');
    expect(bare.status).toBe(200);
    expect(await bare.json()).toMatchObject({ code: 40001, msg: 'unsupported action: kimi-cu' });
  });

  it('reports 40947 when the capabilities feature is absent', async () => {
    const env = await mountHttp([]);
    const list = await get(env, '/capabilities');
    expect(list.status).toBe(200);
    expect(await list.json()).toMatchObject({ code: 40947 });

    const got = await get(env, '/capabilities/kimi-cu');
    expect(got.status).toBe(200);
    expect(await got.json()).toMatchObject({ code: 40947 });

    const install = await post(env, '/capabilities/kimi-cu:install');
    expect(install.status).toBe(200);
    expect(await install.json()).toMatchObject({ code: 40947 });
  });
});

describe('feature-http ws endpoint', () => {
  it('forwards whitelisted session events to subscribers', async () => {
    const env = await mountHttp([bindTestLlm(createMockRequester())]);
    const session = await openMain(env, 'ses_ws');
    const agent = session.get(MAIN_AGENT_ID) as AgentHandle;
    const client = await connectWs(env);
    client.send({ type: 'subscribe', session_id: 'ses_ws' });
    expect(await client.next((frame) => frame['type'] === 'subscribed')).toMatchObject({
      session_id: 'ses_ws',
    });

    queue = [{ text: 'hello ws' }];
    await runTurn(agent);

    const started = await client.next((frame) => frame['event_type'] === 'turn.started');
    expect(started).toMatchObject({ type: 'event', session_id: 'ses_ws', agent_id: MAIN_AGENT_ID });
    const appended = await client.next((frame) => frame['event_type'] === 'message.appended');
    expect(appended).toMatchObject({ type: 'event', session_id: 'ses_ws', agent_id: MAIN_AGENT_ID });
    const ended = await client.next((frame) => frame['event_type'] === 'turn.ended');
    expect(ended).toMatchObject({
      type: 'event',
      session_id: 'ses_ws',
      agent_id: MAIN_AGENT_ID,
      payload: { outcome: 'done' },
    });
    await client.close();
  });

  it('drops non-whitelisted events', async () => {
    const env = await mountHttp([bindTestLlm(createMockRequester())]);
    const session = await openMain(env, 'ses_ws_filter');
    const client = await connectWs(env);
    client.send({ type: 'subscribe', session_id: 'ses_ws_filter' });
    await client.next((frame) => frame['type'] === 'subscribed');

    await session.create({ agentId: 'sub', systemPrompt: 'test' });
    client.send({ type: 'unsubscribe', session_id: 'ses_ws_filter' });
    await client.next((frame) => frame['type'] === 'unsubscribed');

    const opened = await client.next((frame) => frame['event_type'] === 'agent.opened');
    expect(opened).toMatchObject({ session_id: 'ses_ws_filter', agent_id: 'sub' });
    const forwarded = client.frames
      .filter((frame) => frame['type'] === 'event')
      .map((frame) => frame['event_type']);
    expect(forwarded).toEqual(['agent.created', 'agent.opened']);
    await client.close();
  });

  it('stops forwarding after unsubscribe', async () => {
    const env = await mountHttp([bindTestLlm(createMockRequester())]);
    const session = await openMain(env, 'ses_ws_unsub');
    const client = await connectWs(env);
    client.send({ type: 'subscribe', session_id: 'ses_ws_unsub' });
    await client.next((frame) => frame['type'] === 'subscribed');
    client.send({ type: 'unsubscribe', session_id: 'ses_ws_unsub' });
    await client.next((frame) => frame['type'] === 'unsubscribed');

    await session.create({ agentId: 'sub', systemPrompt: 'test' });
    client.send({ type: 'subscribe', session_id: 'ses_ghost' });
    await client.next((frame) => frame['type'] === 'error');

    expect(client.frames.some((frame) => frame['type'] === 'event')).toBe(false);
    await client.close();
  });

  it('answers an error frame when subscribing to an unknown session', async () => {
    const env = await mountHttp([]);
    const client = await connectWs(env);
    client.send({ type: 'subscribe', session_id: 'ses_ghost' });
    const error = await client.next((frame) => frame['type'] === 'error');
    expect(error).toMatchObject({ code: 40401 });
    expect(typeof error['msg']).toBe('string');
    await client.close();
  });

  it('lists live connections and removes them after the socket closes', async () => {
    const env = await mountHttp([bindTestLlm(createMockRequester())]);
    await openMain(env, 'ses_ws_conn');
    const client = await connectWs(env);
    client.send({ type: 'subscribe', session_id: 'ses_ws_conn' });
    await client.next((frame) => frame['type'] === 'subscribed');

    const listed = await get(env, '/connections');
    expect(listed.status).toBe(200);
    const body = await listed.json();
    expect(body.data.items).toHaveLength(1);
    expect(body.data.items[0]).toMatchObject({ subscriptions: ['ses_ws_conn'] });
    expect(typeof body.data.items[0].id).toBe('string');
    expect(Number.isNaN(Date.parse(body.data.items[0].connected_at))).toBe(false);

    await client.close();
    await vi.waitFor(async () => {
      const after = await get(env, '/connections');
      expect((await after.json()).data.items).toEqual([]);
    });
  });

  it('forwards turn-grade agent events with agent_id', async () => {
    const bg = new Map<string, BgHandle>();
    const env = await mountHttp([bindTestLlm(createMockRequester()), bindTestBgTool(bg)]);
    const session = await openMain(env, 'ses_ws_turn');
    const agent = session.get(MAIN_AGENT_ID) as AgentHandle;
    const client = await connectWs(env);
    client.send({ type: 'subscribe', session_id: 'ses_ws_turn', agents: { [MAIN_AGENT_ID]: 'turn' } });
    expect(await client.next((frame) => frame['type'] === 'subscribed')).toMatchObject({
      session_id: 'ses_ws_turn',
    });

    queue = [
      { toolCall: { name: 'TestBg', arguments: JSON.stringify({ description: 'ws turn task' }) } },
      { text: 'done' },
    ];
    await runTurn(agent);
    const taskId = [...bg.keys()].at(-1) as string;

    const detached = await client.next((frame) => frame['event_type'] === 'tool.detached');
    expect(detached).toMatchObject({ type: 'event', session_id: 'ses_ws_turn', agent_id: MAIN_AGENT_ID });
    expect((detached['payload'] as Record<string, unknown>)['toolCallId']).toBe(taskId);
    const turnDone = await client.next((frame) => frame['event_type'] === 'turn.done');
    expect(turnDone).toMatchObject({
      type: 'event',
      session_id: 'ses_ws_turn',
      agent_id: MAIN_AGENT_ID,
      payload: { outcome: { type: 'done' } },
    });

    bg.get(taskId)?.settle('ws bg output');
    const toolDone = await client.next((frame) => frame['event_type'] === 'tool.done');
    expect(toolDone).toMatchObject({ type: 'event', session_id: 'ses_ws_turn', agent_id: MAIN_AGENT_ID });
    expect((toolDone['payload'] as Record<string, unknown>)['toolCallId']).toBe(taskId);
    const streamed = client.frames.filter((frame) => frame['event_type'] === 'llm.streaming.part');
    expect(streamed).toEqual([]);
    await client.close();
  });

  it('forwards llm.streaming.part only for the delta grade', async () => {
    const env = await mountHttp([bindTestLlm(createMockRequester())]);
    const session = await openMain(env, 'ses_ws_delta');
    const agent = session.get(MAIN_AGENT_ID) as AgentHandle;
    const client = await connectWs(env);
    client.send({ type: 'subscribe', session_id: 'ses_ws_delta', agents: { [MAIN_AGENT_ID]: 'delta' } });
    await client.next((frame) => frame['type'] === 'subscribed');

    queue = [{ text: 'delta text' }];
    await runTurn(agent);

    const part = await client.next((frame) => frame['event_type'] === 'llm.streaming.part');
    expect(part).toMatchObject({
      type: 'event',
      session_id: 'ses_ws_delta',
      agent_id: MAIN_AGENT_ID,
      payload: { part: { type: 'text', text: 'delta text' } },
    });
    await client.close();
  });

  it('delivers turn.started exactly once for a graded agent', async () => {
    const env = await mountHttp([bindTestLlm(createMockRequester())]);
    const session = await openMain(env, 'ses_ws_dedup');
    const agent = session.get(MAIN_AGENT_ID) as AgentHandle;
    const client = await connectWs(env);
    client.send({ type: 'subscribe', session_id: 'ses_ws_dedup', agents: { [MAIN_AGENT_ID]: 'turn' } });
    await client.next((frame) => frame['type'] === 'subscribed');

    queue = [{ text: 'dedup' }];
    await runTurn(agent);
    await client.next((frame) => frame['event_type'] === 'turn.done');

    const started = client.frames.filter((frame) => frame['event_type'] === 'turn.started');
    expect(started).toHaveLength(1);
    expect(started[0]).toMatchObject({ session_id: 'ses_ws_dedup', agent_id: MAIN_AGENT_ID });
    await client.close();
  });

  it('replaces agent grades on re-subscribe and lists them in the registry', async () => {
    const env = await mountHttp([bindTestLlm(createMockRequester())]);
    const session = await openMain(env, 'ses_ws_replace');
    const agent = session.get(MAIN_AGENT_ID) as AgentHandle;
    await session.create({ agentId: 'sub', systemPrompt: 'test' });
    const client = await connectWs(env);
    client.send({ type: 'subscribe', session_id: 'ses_ws_replace', agents: { [MAIN_AGENT_ID]: 'delta' } });
    await client.next((frame) => frame['type'] === 'subscribed');

    const listed = await get(env, '/connections');
    const body = await listed.json();
    expect(body.data.items[0].agents).toEqual({ ses_ws_replace: { [MAIN_AGENT_ID]: 'delta' } });

    client.send({ type: 'subscribe', session_id: 'ses_ws_replace', agents: { sub: 'turn' } });
    await vi.waitFor(() => {
      expect(client.frames.filter((frame) => frame['type'] === 'subscribed')).toHaveLength(2);
    });

    queue = [{ text: 'after replace' }];
    await runTurn(agent);
    await client.next((frame) => frame['event_type'] === 'turn.ended');

    const streamed = client.frames.filter((frame) => frame['event_type'] === 'llm.streaming.part');
    expect(streamed).toEqual([]);
    const replaced = await get(env, '/connections');
    expect((await replaced.json()).data.items[0].agents).toEqual({ ses_ws_replace: { sub: 'turn' } });
    await client.close();
  });

  it('answers an error frame for an unknown grade or an unknown agent', async () => {
    const env = await mountHttp([bindTestLlm(createMockRequester())]);
    await openMain(env, 'ses_ws_bad');
    const client = await connectWs(env);

    client.send({ type: 'subscribe', session_id: 'ses_ws_bad', agents: { [MAIN_AGENT_ID]: 'verbose' } });
    const badGrade = await client.next((frame) => frame['type'] === 'error');
    expect(badGrade).toMatchObject({ code: 40001 });

    client.send({ type: 'subscribe', session_id: 'ses_ws_bad', agents: { ghost: 'turn' } });
    await vi.waitFor(() => {
      expect(client.frames.filter((frame) => frame['type'] === 'error')).toHaveLength(2);
    });
    const badAgent = client.frames.filter((frame) => frame['type'] === 'error')[1] as WsFrame;
    expect(badAgent).toMatchObject({ code: 40001, msg: 'unknown agent ghost' });
    expect(client.frames.some((frame) => frame['type'] === 'subscribed')).toBe(false);
    await client.close();
  });

  it('broadcasts session.deleted to every connection when a session is deleted', async () => {
    const env = await mountHttp([bindTestLlm(createMockRequester())]);
    await openMain(env, 'ses_ws_del');
    const subscribed = await connectWs(env);
    subscribed.send({ type: 'subscribe', session_id: 'ses_ws_del' });
    await subscribed.next((frame) => frame['type'] === 'subscribed');
    const bystander = await connectWs(env);

    const response = await del(env, '/sessions/ses_ws_del');
    expect(response.status).toBe(200);

    const expected = {
      type: 'event',
      session_id: 'ses_ws_del',
      event_type: 'session.deleted',
      payload: {},
    };
    expect(await subscribed.next((frame) => frame['event_type'] === 'session.deleted')).toMatchObject(expected);
    expect(await bystander.next((frame) => frame['event_type'] === 'session.deleted')).toMatchObject(expected);
    expect(await env.space.get('ses_ws_del')).toBeUndefined();
    await subscribed.close();
    await bystander.close();
  });
});

describe('feature-http ws v1 (kap-aligned) endpoint', () => {
  const hello = (id: string, payload: Record<string, unknown>): WsFrame => ({
    type: 'client_hello',
    id,
    payload: { client_id: 'test-client', ...payload },
  });

  const subscribe = (id: string, payload: Record<string, unknown>): WsFrame => ({
    type: 'subscribe',
    id,
    payload,
  });

  const subscribeV2 = (id: string, payload: Record<string, unknown>): WsFrame => ({
    type: 'subscribe_v2',
    id,
    payload,
  });

  const durableSeqs = (client: WsTestClient): number[] =>
    client.frames
      .filter((frame) => frame['volatile'] !== true && typeof frame['seq'] === 'number')
      .map((frame) => frame['seq'] as number);

  const collectOps = (client: WsTestClient): Record<string, unknown>[] =>
    client.frames
      .filter((frame) => frame['type'] === 'transcript.ops')
      .flatMap(
        (frame) => ((frame['payload'] as Record<string, unknown>)['ops'] ?? []) as Record<string, unknown>[],
      );

  function runTurnWithPrompt(agent: AgentHandle, promptId: string, text = 'go'): Promise<void> {
    const done = new Promise<void>((resolve) => {
      agent.on('turn.done', () => {
        resolve();
      });
    });
    agent.submit(createUserMessage(text), { promptId });
    return done;
  }

  it('greets with server_hello and answers client_hello with an ack', async () => {
    const env = await mountHttp([]);
    const client = await connectWsV1(env);
    const greeting = await client.next((frame) => frame['type'] === 'server_hello');
    expect(greeting).toMatchObject({
      type: 'server_hello',
      payload: {
        protocol_version: 2,
        heartbeat_ms: 10_000,
        max_event_buffer_size: 1000,
        capabilities: { event_batching: false, compression: false },
      },
    });
    expect(typeof (greeting['payload'] as Record<string, unknown>)['ws_connection_id']).toBe('string');
    expect(typeof greeting['timestamp']).toBe('string');

    client.send(hello('h1', { subscriptions: [], cursors: {} }));
    const ack = await client.next((frame) => frame['type'] === 'ack' && frame['id'] === 'h1');
    expect(ack).toMatchObject({
      type: 'ack',
      id: 'h1',
      code: 0,
      msg: 'success',
      payload: { accepted_subscriptions: [], resync_required: [], cursors: {} },
    });
    await client.close();
  });

  it('streams kap-shaped session events with monotonic seq for a subscription', async () => {
    const env = await mountHttp([bindTestLlm(createMockRequester())]);
    const session = await openMain(env, 'ses_v1_stream');
    const agent = session.get(MAIN_AGENT_ID) as AgentHandle;
    const client = await connectWsV1(env);
    await client.next((frame) => frame['type'] === 'server_hello');

    client.send(hello('h1', { subscriptions: ['ses_v1_stream'], cursors: {} }));
    const ack = await client.next((frame) => frame['type'] === 'ack' && frame['id'] === 'h1');
    expect(ack).toMatchObject({
      code: 0,
      payload: { accepted_subscriptions: ['ses_v1_stream'], resync_required: [] },
    });
    const ackPayload = ack['payload'] as Record<string, unknown>;
    const cursor = (ackPayload['cursors'] as Record<string, { seq: number; epoch: string }>)[
      'ses_v1_stream'
    ];
    expect(typeof cursor.seq).toBe('number');
    expect(typeof cursor.epoch).toBe('string');

    queue = [{ text: 'hello kap' }];
    await runTurnWithPrompt(agent, 'prompt-stream-1');

    const submitted = await client.next((frame) => frame['type'] === 'prompt.submitted');
    expect(submitted).toMatchObject({
      session_id: 'ses_v1_stream',
      payload: {
        agentId: MAIN_AGENT_ID,
        sessionId: 'ses_v1_stream',
        promptId: 'prompt-stream-1',
      },
    });

    const started = await client.next((frame) => frame['type'] === 'turn.started');
    expect(started).toMatchObject({
      session_id: 'ses_v1_stream',
      payload: { turnId: 0, agentId: MAIN_AGENT_ID, sessionId: 'ses_v1_stream', prompt: 'go' },
    });

    const delta = await client.next((frame) => frame['type'] === 'assistant.delta');
    expect(delta).toMatchObject({
      session_id: 'ses_v1_stream',
      volatile: true,
      offset: 0,
      payload: { turnId: 0, delta: 'hello kap', agentId: MAIN_AGENT_ID },
    });

    const stepCompleted = await client.next((frame) => frame['type'] === 'turn.step.completed');
    expect(stepCompleted).toMatchObject({
      payload: { turnId: 0, usage: { inputOther: 10, output: 5 } },
    });

    const ended = await client.next((frame) => frame['type'] === 'turn.ended');
    expect(ended).toMatchObject({
      payload: { turnId: 0, reason: 'completed', agentId: MAIN_AGENT_ID },
    });

    const promptCompleted = await client.next((frame) => frame['type'] === 'prompt.completed');
    expect(promptCompleted).toMatchObject({
      payload: { promptId: 'prompt-stream-1', reason: 'completed' },
    });

    const workChanged = await client.next((frame) => frame['type'] === 'event.session.work_changed');
    expect(workChanged).toMatchObject({
      session_id: 'ses_v1_stream',
      payload: { busy: true, main_turn_active: true },
    });

    const seqs = durableSeqs(client);
    expect(seqs.length).toBeGreaterThan(3);
    expect([...seqs].sort((a, b) => a - b)).toEqual(seqs);

    const listed = await get(env, '/connections');
    const body = await listed.json();
    const mine = body.data.items.find(
      (item: Record<string, unknown>) => item['protocol'] === 'kap-v1',
    );
    expect(mine).toMatchObject({
      protocol: 'kap-v1',
      has_client_hello: true,
      subscriptions: ['ses_v1_stream'],
    });
    await client.close();
  });

  it('broadcasts event.session.created to every connection', async () => {
    const env = await mountHttp([bindTestLlm(createMockRequester())]);
    const client = await connectWsV1(env);
    client.send(hello('h1', { subscriptions: [] }));
    await client.next((frame) => frame['type'] === 'ack' && frame['id'] === 'h1');

    await openMain(env, 'ses_v1_created');
    const created = await client.next((frame) => frame['type'] === 'event.session.created');
    expect(created).toMatchObject({
      session_id: 'ses_v1_created',
      payload: { session: { id: 'ses_v1_created' } },
    });
    await client.close();
  });

  it('serves transcript.reset then live transcript.ops and suppresses raw projected frames', async () => {
    const env = await mountHttp([bindTestLlm(createMockRequester())]);
    const session = await openMain(env, 'ses_v1_transcript');
    const agent = session.get(MAIN_AGENT_ID) as AgentHandle;
    const client = await connectWsV1(env);
    await client.next((frame) => frame['type'] === 'server_hello');
    client.send(hello('h1', { subscriptions: [] }));
    await client.next((frame) => frame['type'] === 'ack' && frame['id'] === 'h1');

    client.send(subscribeV2('s1', { session_id: 'ses_v1_transcript', transcript: { [MAIN_AGENT_ID]: 'delta' } }));
    const ack = await client.next((frame) => frame['type'] === 'ack' && frame['id'] === 's1');
    expect(ack).toMatchObject({
      code: 0,
      payload: { accepted: ['ses_v1_transcript'], not_found: [], resync_required: [] },
    });

    const reset = await client.next((frame) => frame['type'] === 'transcript.reset');
    expect(reset).toMatchObject({
      session_id: 'ses_v1_transcript',
      volatile: true,
      payload: {
        type: 'transcript.reset',
        agent_id: MAIN_AGENT_ID,
        has_more_older: false,
        snapshot: { items: [], tasks: [], interactions: [], attachments: [], todos: [], prompts: [] },
      },
    });
    expect(typeof (reset['payload'] as Record<string, unknown>)['seq']).toBe('number');

    queue = [{ text: 'transcript live' }];
    await runTurnWithPrompt(agent, 'prompt-transcript-1');

    await vi.waitFor(() => {
      const ops = collectOps(client);
      const hasRunningTurn = ops.some(
        (op) => op['op'] === 'turn.upsert' && (op['turn'] as Record<string, unknown>)['state'] === 'running',
      );
      const hasAppend = ops.some(
        (op) => op['op'] === 'append' && typeof op['text'] === 'string' && (op['text'] as string).length > 0,
      );
      const hasCompletedTurn = ops.some(
        (op) => op['op'] === 'turn.upsert' && (op['turn'] as Record<string, unknown>)['state'] === 'completed',
      );
      const hasCompletedPrompt = ops.some(
        (op) =>
          op['op'] === 'prompt.upsert' &&
          (op['prompt'] as Record<string, unknown>)['promptId'] === 'prompt-transcript-1' &&
          (op['prompt'] as Record<string, unknown>)['status'] === 'completed',
      );
      expect(hasRunningTurn).toBe(true);
      expect(hasAppend).toBe(true);
      expect(hasCompletedTurn).toBe(true);
      expect(hasCompletedPrompt).toBe(true);
    });
    const appendText = collectOps(client)
      .filter((op) => op['op'] === 'append')
      .map((op) => op['text'])
      .join('');
    expect(appendText).toContain('transcript live');
    const turnUpserts = collectOps(client).filter((op) => op['op'] === 'turn.upsert');
    expect(turnUpserts.length).toBeGreaterThanOrEqual(2);
    const runningTurn = turnUpserts.find(
      (op) => (op['turn'] as Record<string, unknown>)['state'] === 'running',
    );
    expect((runningTurn?.['turn'] as Record<string, unknown> | undefined)?.['turnId']).toBe('t0');
    const frameUpserts = collectOps(client).filter((op) => op['op'] === 'frame.upsert');
    expect(
      frameUpserts.some(
        (op) =>
          ((op['frame'] as Record<string, unknown>)['kind'] === 'text' ||
            (op['frame'] as Record<string, unknown>)['kind'] === 'thinking') &&
          (op['frame'] as Record<string, unknown>)['frameId'] === 't0.1.f1',
      ),
    ).toBe(true);
    const opsSeqs = client.frames
      .filter((frame) => frame['type'] === 'transcript.ops')
      .map((frame) => (frame['payload'] as Record<string, unknown>)['seq'] as number);
    expect([...opsSeqs].sort((a, b) => a - b)).toEqual(opsSeqs);

    const rawProjected = client.frames.filter((frame) =>
      ['turn.started', 'turn.ended', 'assistant.delta', 'prompt.submitted'].includes(
        frame['type'] as string,
      ),
    );
    expect(rawProjected).toEqual([]);

    client.send({ type: 'unsubscribe_v2', id: 'u1', payload: { session_id: 'ses_v1_transcript' } });
    const unsubAck = await client.next((frame) => frame['type'] === 'ack' && frame['id'] === 'u1');
    expect(unsubAck).toMatchObject({ code: 0, payload: { accepted: ['ses_v1_transcript'] } });

    const opsBefore = client.frames.filter((frame) => frame['type'] === 'transcript.ops').length;
    queue = [{ text: 'after detach' }];
    await runTurn(agent);
    await client.next((frame) => frame['type'] === 'turn.started');
    await client.next((frame) => frame['type'] === 'turn.ended');
    expect(client.frames.filter((frame) => frame['type'] === 'transcript.ops')).toHaveLength(opsBefore);
    await client.close();
  });

  it('replays journaled events from a cursor and echoes the server cursor', async () => {
    const env = await mountHttp([bindTestLlm(createMockRequester())]);
    const session = await openMain(env, 'ses_v1_replay');
    const agent = session.get(MAIN_AGENT_ID) as AgentHandle;
    queue = [{ text: 'replayed turn' }];
    await runTurn(agent);

    const client = await connectWsV1(env);
    await client.next((frame) => frame['type'] === 'server_hello');
    client.send(
      hello('h1', { subscriptions: ['ses_v1_replay'], cursors: { ses_v1_replay: { seq: 0 } } }),
    );
    const ack = await client.next((frame) => frame['type'] === 'ack' && frame['id'] === 'h1');
    expect(ack).toMatchObject({
      code: 0,
      payload: { accepted_subscriptions: ['ses_v1_replay'], resync_required: [] },
    });

    const replayed = await client.next(
      (frame) => frame['type'] === 'turn.started' && (frame['payload'] as Record<string, unknown>)['turnId'] === 0,
    );
    expect(replayed).toMatchObject({ session_id: 'ses_v1_replay' });
    await client.next((frame) => frame['type'] === 'turn.ended');
    const cursor = (
      (ack['payload'] as Record<string, unknown>)['cursors'] as Record<
        string,
        { seq: number; epoch: string }
      >
    )['ses_v1_replay'];
    const maxSeq = Math.max(...durableSeqs(client));
    expect(cursor.seq).toBe(maxSeq);

    const second = await connectWsV1(env);
    await second.next((frame) => frame['type'] === 'server_hello');
    second.send(
      hello('h2', { subscriptions: ['ses_v1_replay'], cursors: { ses_v1_replay: cursor } }),
    );
    const ack2 = await second.next((frame) => frame['type'] === 'ack' && frame['id'] === 'h2');
    expect(ack2).toMatchObject({
      code: 0,
      payload: { accepted_subscriptions: ['ses_v1_replay'], resync_required: [] },
    });
    await vi.waitFor(() => {
      const replays = second.frames.filter((frame) => frame['type'] === 'turn.started');
      expect(replays).toEqual([]);
    });
    await client.close();
    await second.close();
  });

  it('answers resync_required when the cursor epoch mismatches or runs ahead of the journal', async () => {
    const env = await mountHttp([bindTestLlm(createMockRequester())]);
    const session = await openMain(env, 'ses_v1_resync');
    const agent = session.get(MAIN_AGENT_ID) as AgentHandle;
    queue = [{ text: 'resync turn' }];
    await runTurn(agent);

    const client = await connectWsV1(env);
    await client.next((frame) => frame['type'] === 'server_hello');
    client.send(hello('h1', { subscriptions: ['ses_v1_resync'], cursors: {} }));
    const ack = await client.next((frame) => frame['type'] === 'ack' && frame['id'] === 'h1');
    const cursor = (
      (ack['payload'] as Record<string, unknown>)['cursors'] as Record<
        string,
        { seq: number; epoch: string }
      >
    )['ses_v1_resync'];

    client.send(
      hello('h2', {
        subscriptions: ['ses_v1_resync'],
        cursors: { ses_v1_resync: { seq: cursor.seq, epoch: 'ep_bogus' } },
      }),
    );
    const resync = await client.next((frame) => frame['type'] === 'resync_required');
    expect(resync).toMatchObject({
      payload: {
        session_id: 'ses_v1_resync',
        reason: 'epoch_changed',
        current_seq: cursor.seq,
        epoch: cursor.epoch,
      },
    });
    const ack2 = await client.next((frame) => frame['type'] === 'ack' && frame['id'] === 'h2');
    expect(ack2).toMatchObject({
      code: 0,
      payload: { accepted_subscriptions: ['ses_v1_resync'], resync_required: ['ses_v1_resync'] },
    });

    client.send(
      hello('h3', {
        subscriptions: ['ses_v1_resync'],
        cursors: { ses_v1_resync: { seq: cursor.seq + 10_000, epoch: cursor.epoch } },
      }),
    );
    const ahead = await client.next(
      (frame) =>
        frame['type'] === 'resync_required' &&
        (frame['payload'] as Record<string, unknown>)['current_seq'] === cursor.seq &&
        client.frames.filter((f) => f['type'] === 'resync_required').length >= 2,
    );
    expect(ahead).toMatchObject({ payload: { reason: 'epoch_changed' } });
    await client.close();
  });

  it('answers ack errors for invalid subscribe_v2 payloads and not_found for unknown sessions', async () => {
    const env = await mountHttp([bindTestLlm(createMockRequester())]);
    const client = await connectWsV1(env);
    await client.next((frame) => frame['type'] === 'server_hello');
    client.send(hello('h1', { subscriptions: [] }));
    await client.next((frame) => frame['type'] === 'ack' && frame['id'] === 'h1');

    client.send(subscribeV2('s1', { session_id: 'ses_ghost', transcript: 'nope' }));
    const invalid = await client.next((frame) => frame['type'] === 'ack' && frame['id'] === 's1');
    expect(invalid).toMatchObject({ code: 1, msg: 'invalid subscribe_v2 payload' });

    client.send(subscribe('s2', { session_ids: ['ses_ghost'] }));
    const notFound = await client.next((frame) => frame['type'] === 'ack' && frame['id'] === 's2');
    expect(notFound).toMatchObject({
      code: 0,
      payload: { accepted: [], not_found: ['ses_ghost'], resync_required: [] },
    });

    client.send('{"not closed":[');
    client.send(subscribe('s3', { session_ids: ['ses_ghost'] }));
    const after = await client.next((frame) => frame['type'] === 'ack' && frame['id'] === 's3');
    expect(after).toMatchObject({ code: 0, payload: { not_found: ['ses_ghost'] } });
    await client.close();
  });

  it('filters raw agent events by agent_filter', async () => {
    const env = await mountHttp([bindTestLlm(createMockRequester())]);
    const session = await openMain(env, 'ses_v1_filter');
    const main = session.get(MAIN_AGENT_ID) as AgentHandle;
    const sub = await session.create({ agentId: 'sub', systemPrompt: 'test' });
    const client = await connectWsV1(env);
    await client.next((frame) => frame['type'] === 'server_hello');
    client.send(
      subscribe('s1', {
        session_ids: ['ses_v1_filter'],
        agent_filter: { ses_v1_filter: [MAIN_AGENT_ID] },
      }),
    );
    await client.next((frame) => frame['type'] === 'ack' && frame['id'] === 's1');

    queue = [{ text: 'from sub' }];
    await runTurn(sub as AgentHandle);
    await new Promise((resolve) => setTimeout(resolve, 150));
    const subFrames = client.frames.filter(
      (frame) =>
        (frame['payload'] as Record<string, unknown> | undefined)?.['agentId'] === 'sub' &&
        ['turn.started', 'turn.ended', 'assistant.delta'].includes(frame['type'] as string),
    );
    expect(subFrames).toEqual([]);

    queue = [{ text: 'from main' }];
    await runTurn(main);
    const started = await client.next((frame) => frame['type'] === 'turn.started');
    expect(started).toMatchObject({ payload: { agentId: MAIN_AGENT_ID } });
    await client.close();
  });

  it('sends heartbeat pings with a nonce, accepts pong and closes silent clients', async () => {
    const env = await mountHttp([], { wsHeartbeatMs: 50 });
    const client = await connectWsV1(env);
    await client.next((frame) => frame['type'] === 'server_hello');

    const ping = await client.next((frame) => frame['type'] === 'ping');
    const nonce = ((ping['payload'] as Record<string, unknown>)['nonce'] as string) ?? '';
    expect(nonce.length).toBeGreaterThan(0);
    client.send({ type: 'pong', payload: { nonce } });
    const secondPing = await client.next(
      (frame) =>
        frame['type'] === 'ping' &&
        (frame['payload'] as Record<string, unknown>)['nonce'] !== nonce,
    );
    expect(secondPing).toBeDefined();
    await client.close();

    const silent = await connectWsV1(env);
    await silent.next((frame) => frame['type'] === 'server_hello');
    const closed = await silent.closed;
    expect(closed.code).toBe(1001);
  });

  it('projects question interactions with kap wire ids on event frames, transcript ops and REST', async () => {
    const env = await mountHttp([interaction, bindTestLlm(createMockRequester())]);
    const session = await openMain(env, 'ses_v1_question');
    const interactions = session.resolve(InteractionRef);
    const payload = {
      questions: [
        {
          question: 'Pick one',
          header: 'Choice',
          options: [
            { label: 'A', description: 'alpha' },
            { label: 'B', description: '' },
          ],
          multi_select: false,
        },
        {
          question: 'Pick many',
          options: [{ label: 'C' }, { label: 'D' }],
          multi_select: true,
        },
      ],
    };
    const wireQuestions = [
      {
        id: 'q_0',
        question: 'Pick one',
        header: 'Choice',
        options: [
          { id: 'opt_0_0', label: 'A', description: 'alpha' },
          { id: 'opt_0_1', label: 'B', description: '' },
        ],
        multi_select: false,
        allow_other: true,
      },
      {
        id: 'q_1',
        question: 'Pick many',
        options: [
          { id: 'opt_1_0', label: 'C' },
          { id: 'opt_1_1', label: 'D' },
        ],
        multi_select: true,
        allow_other: true,
      },
    ];

    const first = interactions!.enqueue({
      kind: 'question',
      payload,
      tags: { [INTERACTION_TAG_SESSION_ID]: 'ses_v1_question' },
    });
    const listed = await get(env, '/sessions/ses_v1_question/transcript?agent_id=main');
    const listedBody = await listed.json();
    const pendingOnly = listedBody.data.interactions.find(
      (record: Record<string, unknown>) => record['interactionId'] === first.id,
    );
    expect(pendingOnly).toMatchObject({ interactionKind: 'question', state: 'pending' });
    expect(pendingOnly['request']).toEqual({ questions: wireQuestions });
    interactions!.respond(first.id, null);

    const events = await connectWsV1(env);
    await events.next((frame) => frame['type'] === 'server_hello');
    events.send(hello('h1', { subscriptions: ['ses_v1_question'], cursors: {} }));
    await events.next((frame) => frame['type'] === 'ack' && frame['id'] === 'h1');

    const second = interactions!.enqueue({
      kind: 'question',
      payload,
      tags: {
        [INTERACTION_TAG_SESSION_ID]: 'ses_v1_question',
        [INTERACTION_TAG_AGENT_ID]: MAIN_AGENT_ID,
        [INTERACTION_TAG_TOOL_CALL_ID]: 'call-q9',
        [INTERACTION_TAG_TURN_ID]: 7,
      },
    });
    const requested = await events.next((frame) => frame['type'] === 'event.question.requested');
    expect(requested).toMatchObject({
      session_id: 'ses_v1_question',
      payload: {
        question_id: second.id,
        session_id: 'ses_v1_question',
        agent_id: MAIN_AGENT_ID,
        turn_id: 7,
        tool_call_id: 'call-q9',
        questions: wireQuestions,
      },
    });

    const transcripts = await connectWsV1(env);
    await transcripts.next((frame) => frame['type'] === 'server_hello');
    transcripts.send(
      subscribeV2('s1', {
        session_id: 'ses_v1_question',
        transcript: { [MAIN_AGENT_ID]: 'delta' },
      }),
    );
    await transcripts.next((frame) => frame['type'] === 'ack' && frame['id'] === 's1');
    await transcripts.next((frame) => frame['type'] === 'transcript.reset');
    const third = interactions!.enqueue({
      kind: 'question',
      payload,
      tags: {
        [INTERACTION_TAG_SESSION_ID]: 'ses_v1_question',
        [INTERACTION_TAG_AGENT_ID]: MAIN_AGENT_ID,
        [INTERACTION_TAG_TOOL_CALL_ID]: 'call-q10',
      },
    });
    await transcripts.next((frame) => {
      if (frame['type'] !== 'transcript.ops') return false;
      const ops = ((frame['payload'] as Record<string, unknown>)['ops'] ?? []) as Record<
        string,
        unknown
      >[];
      return ops.some((op) => op['op'] === 'interaction.upsert');
    });
    const upsert = collectOps(transcripts).find((op) => op['op'] === 'interaction.upsert');
    const projected = upsert?.['interaction'] as Record<string, unknown>;
    expect(projected).toMatchObject({
      interactionId: third.id,
      interactionKind: 'question',
      toolCallId: 'call-q10',
      state: 'pending',
    });
    expect(projected['request']).toEqual({ questions: wireQuestions });

    interactions!.respond(second.id, null);
    interactions!.respond(third.id, null);
    await events.close();
    await transcripts.close();
  });

  it('projects media refs as session_media sources and inlines tool result media', async () => {
    const dir = await tempDir('media-proj-');
    const store = createMemoryMediaStore();
    const pngBytes = Buffer.from('fake-png-bytes');
    const ref = await store.put({ bytes: pngBytes, mimeType: 'image/png', filename: 'shot.png' });

    const mediaTool: ToolDefinition = {
      name: 'MediaProbe',
      description: 'test media tool',
      parameters: { type: 'object', properties: {}, additionalProperties: false },
      execute: () =>
        Promise.resolve({
          content: [
            { type: 'text' as const, text: '<image path="/tmp/shot.png">' },
            { type: 'image_url' as const, imageUrl: { url: `media://${ref}` } },
            { type: 'text' as const, text: '</image>' },
          ],
        }),
    };
    const bindMediaTool = (): FeatureSpec =>
      createFeature('test-media-tool', {
        agent() {
          useAgentTools(mediaTool);
        },
      });

    const env = await mountHttp([
      createMedia({ workDir: dir, store, cache: createMemoryMediaUploadCache() }),
      bindMediaTool(),
      bindTestLlm(createMockRequester()),
    ]);
    const session = await openMain(env, 'ses_v1_media');
    const agent = session.get(MAIN_AGENT_ID) as AgentHandle;

    const client = await connectWsV1(env);
    await client.next((frame) => frame['type'] === 'server_hello');
    client.send(
      subscribeV2('s1', { session_id: 'ses_v1_media', transcript: { [MAIN_AGENT_ID]: 'delta' } }),
    );
    await client.next((frame) => frame['type'] === 'ack' && frame['id'] === 's1');
    await client.next((frame) => frame['type'] === 'transcript.reset');

    queue = [{ text: 'noted' }];
    const imgDone = new Promise<void>((resolve) => {
      agent.on('turn.done', () => {
        resolve();
      });
    });
    agent.submit(
      {
        role: 'user',
        content: [
          { type: 'image_url', imageUrl: { url: `media://${ref}`, name: 'shot.png' } },
          { type: 'text', text: 'look' },
        ],
      },
      { promptId: 'p-img', origin: { kind: 'user' }, tracked: true },
    );
    await imgDone;
    const attached = await client.next((frame) => {
      if (frame['type'] !== 'transcript.ops') return false;
      const ops = ((frame['payload'] as Record<string, unknown>)['ops'] ?? []) as Record<
        string,
        unknown
      >[];
      return ops.some((op) => op['op'] === 'attachment.upsert');
    });
    const attachOps = ((attached['payload'] as Record<string, unknown>)['ops'] ??
      []) as Record<string, unknown>[];
    const attachment = attachOps.find((op) => op['op'] === 'attachment.upsert')?.[
      'attachment'
    ] as Record<string, unknown>;
    expect(attachment).toMatchObject({
      mediaType: 'image/*',
      source: { kind: 'session_media', fileId: ref },
    });

    const prompted = collectOps(client).find((op) => op['op'] === 'prompt.upsert');
    expect(prompted?.['prompt']).toMatchObject({
      content: [
        { type: 'image', source: { kind: 'session_media', file_id: ref }, name: 'shot.png' },
        { type: 'text', text: 'look' },
      ],
    });

    queue = [{ toolCall: { name: 'MediaProbe', arguments: '{}' } }, { text: 'done' }];
    await runTurnWithPrompt(agent, 'p-tool');
    await client.next((frame) => {
      if (frame['type'] !== 'transcript.ops') return false;
      const ops = ((frame['payload'] as Record<string, unknown>)['ops'] ?? []) as Record<
        string,
        unknown
      >[];
      return ops.some(
        (op) =>
          op['op'] === 'frame.upsert' &&
          (op['frame'] as Record<string, unknown>)['state'] === 'done' &&
          (op['frame'] as Record<string, unknown>)['name'] === 'MediaProbe',
      );
    });
    const toolOp = collectOps(client).find(
      (op) =>
        op['op'] === 'frame.upsert' &&
        (op['frame'] as Record<string, unknown>)['name'] === 'MediaProbe' &&
        (op['frame'] as Record<string, unknown>)['state'] === 'done',
    );
    const output = (toolOp?.['frame'] as Record<string, unknown>)['output'] as Record<
      string,
      unknown
    >[];
    const mediaPart = output.find((part) => part['type'] === 'image_url') as {
      imageUrl: { url: string };
    };
    expect(mediaPart.imageUrl.url.startsWith('data:image/png;base64,')).toBe(true);
    const base64 = mediaPart.imageUrl.url.slice('data:image/png;base64,'.length);
    expect(Buffer.from(base64, 'base64')).toEqual(pngBytes);

    await client.close();
  });
});

describe('feature-http cold session resume', () => {
  async function closeSession(env: HttpEnv, sessionId: string): Promise<void> {
    await env.app.close(sessionId);
    expect(env.app.get(sessionId)).toBeUndefined();
  }

  it('resumes a catalog session for prompt submission instead of answering 40401', async () => {
    const env = await mountHttp([bindTestLlm(createMockRequester())]);
    const session = await openMain(env, 'ses_cold_prompt');
    const agent = session.get(MAIN_AGENT_ID) as AgentHandle;
    queue = [{ text: 'first turn' }];
    await runTurn(agent);
    await closeSession(env, 'ses_cold_prompt');

    queue = [{ text: 'resumed turn' }];
    const submitted = await post(env, '/sessions/ses_cold_prompt/prompts', {
      content: [{ type: 'text', text: 'wake up' }],
      prompt_id: 'prompt-resume-1',
    });
    expect(submitted.status).toBe(200);
    expect(await submitted.json()).toMatchObject({
      code: 0,
      data: { prompt_id: 'prompt-resume-1', submitted: true },
    });

    const resumed = env.app.get('ses_cold_prompt');
    expect(resumed).toBeDefined();
    const resumedAgent = resumed?.get(MAIN_AGENT_ID);
    expect(resumedAgent).toBeDefined();
    await vi.waitFor(() => {
      const history = resumed?.stores.get(MAIN_AGENT_ID)?.getState().history ?? [];
      const text = JSON.stringify(history);
      expect(text).toContain('resumed turn');
    });

    const missing = await post(env, '/sessions/ses_cold_ghost/prompts', {
      content: [{ type: 'text', text: 'nobody' }],
    });
    expect(missing.status).toBe(200);
    expect(await missing.json()).toMatchObject({
      code: 40401,
      msg: 'session ses_cold_ghost does not exist',
    });
  });

  it('resumes a catalog session for live-dependent session routes', async () => {
    const env = await mountHttp([bindTestLlm(createMockRequester())]);
    await openMain(env, 'ses_cold_status');
    await closeSession(env, 'ses_cold_status');

    const status = await get(env, '/sessions/ses_cold_status/status');
    expect(status.status).toBe(200);
    expect(await status.json()).toMatchObject({ code: 0, data: { busy: false } });
    expect(env.app.get('ses_cold_status')).toBeDefined();

    const agents = await get(env, '/sessions/ses_cold_status/agents');
    expect(agents.status).toBe(200);
    expect(await agents.json()).toMatchObject({
      code: 0,
      data: { items: [{ id: MAIN_AGENT_ID }] },
    });

    const missing = await get(env, '/sessions/ses_cold_ghost/status');
    expect(await missing.json()).toMatchObject({
      code: 40401,
      msg: 'session ses_cold_ghost does not exist',
    });
  });

  it('resumes a catalog session for ws subscriptions and seeds transcript from persisted history', async () => {
    const env = await mountHttp([bindTestLlm(createMockRequester())]);
    const session = await openMain(env, 'ses_cold_ws');
    const agent = session.get(MAIN_AGENT_ID) as AgentHandle;
    queue = [{ text: 'persisted cold turn' }];
    await runTurn(agent);
    await closeSession(env, 'ses_cold_ws');

    const client = await connectWsV1(env);
    await client.next((frame) => frame['type'] === 'server_hello');
    client.send({
      type: 'client_hello',
      id: 'h1',
      payload: { client_id: 'test-client', subscriptions: ['ses_cold_ws'], cursors: {} },
    });
    const ack = await client.next((frame) => frame['type'] === 'ack' && frame['id'] === 'h1');
    expect(ack).toMatchObject({
      code: 0,
      payload: { accepted_subscriptions: ['ses_cold_ws'], resync_required: [] },
    });
    expect(env.app.get('ses_cold_ws')).toBeDefined();

    client.send({
      type: 'subscribe_v2',
      id: 's1',
      payload: { session_id: 'ses_cold_ws', transcript: { [MAIN_AGENT_ID]: 'delta' } },
    });
    await client.next((frame) => frame['type'] === 'ack' && frame['id'] === 's1');
    const reset = await client.next((frame) => frame['type'] === 'transcript.reset');
    const payload = reset['payload'] as Record<string, unknown>;
    expect(payload).toMatchObject({ agent_id: MAIN_AGENT_ID, has_more_older: false });
    const snapshot = payload['snapshot'] as {
      items: { kind: string; turnId?: string; state?: string; steps?: { frames: { kind: string; text?: string }[] }[] }[];
    };
    expect(snapshot.items).toHaveLength(1);
    expect(snapshot.items[0]).toMatchObject({ kind: 'turn', turnId: 't0', state: 'completed' });
    const frames = snapshot.items[0]?.steps?.flatMap((step) => step.frames) ?? [];
    expect(frames.some((frame) => frame.kind === 'text' && frame.text === 'persisted cold turn')).toBe(
      true,
    );

    client.send({
      type: 'client_hello',
      id: 'h2',
      payload: {
        client_id: 'test-client',
        subscriptions: ['ses_cold_ws'],
        cursors: { ses_cold_ws: { seq: 0, epoch: 'ep_stale' } },
      },
    });
    const resync = await client.next((frame) => frame['type'] === 'resync_required');
    expect(resync).toMatchObject({
      payload: { session_id: 'ses_cold_ws', reason: 'epoch_changed' },
    });
    await client.close();

    const ghost = await connectWsV1(env);
    await ghost.next((frame) => frame['type'] === 'server_hello');
    ghost.send({
      type: 'subscribe',
      id: 'g1',
      payload: { session_ids: ['ses_cold_ghost'] },
    });
    const ghostAck = await ghost.next((frame) => frame['type'] === 'ack' && frame['id'] === 'g1');
    expect(ghostAck).toMatchObject({ code: 0, payload: { not_found: ['ses_cold_ghost'] } });
    await ghost.close();
  });
});

describe('feature-http transcript routes', () => {
  function transcriptTurnTexts(body: unknown): { turnId: string; state: string; texts: string[] }[] {
    const data = (body as { data: { items: Record<string, unknown>[] } }).data;
    return data.items
      .filter((item) => item['kind'] === 'turn')
      .map((item) => ({
        turnId: item['turnId'] as string,
        state: item['state'] as string,
        texts: ((item['steps'] as { frames: Record<string, unknown>[] }[] | undefined) ?? [])
          .flatMap((step) => step.frames)
          .filter((frame) => frame['kind'] === 'text')
          .map((frame) => frame['text'] as string),
      }));
  }

  function bindTestExitPlanTool(output: (toolCallId: string) => string): FeatureSpec {
    const tool: ToolDefinition = {
      name: 'ExitPlanMode',
      description: 'test exit plan mode tool',
      parameters: { type: 'object', properties: {}, additionalProperties: false },
      execute: ({ toolCall }) =>
        Promise.resolve({ content: [{ type: 'text' as const, text: output(toolCall.id) }] }),
    };
    return createFeature('test-exit-plan', {
      agent() {
        useAgentTools(tool);
      },
    });
  }

  function lastToolCallId(session: SessionHandle): string {
    const history = session.stores.get(MAIN_AGENT_ID)?.getState().history ?? [];
    const assistant = history.findLast(
      (entry) =>
        entry.message.role === 'assistant' &&
        ((entry.message as { toolCalls?: unknown[] }).toolCalls?.length ?? 0) > 0,
    );
    const toolCalls = (assistant?.message as { toolCalls?: { id: string }[] } | undefined)?.toolCalls;
    const id = toolCalls?.[0]?.id;
    if (id === undefined) throw new Error('no tool call in history');
    return id;
  }

  it('serves the baseline transcript page with kap wire shape and turn pagination', async () => {
    const env = await mountHttp([bindTestLlm(createMockRequester())]);
    const session = await openMain(env, 'ses_tr');
    const agent = session.get(MAIN_AGENT_ID) as AgentHandle;
    for (const text of ['turn one', 'turn two', 'turn three']) {
      queue = [{ text }];
      await runTurn(agent);
    }

    const full = await get(env, '/sessions/ses_tr/transcript?agent_id=main');
    expect(full.status).toBe(200);
    const body = await full.json();
    expect(body.code).toBe(0);
    expect(body.data.agent_id).toBe('main');
    expect(body.data.has_more).toBe(false);
    expect(body.data.agents).toEqual([{ agentId: 'main', type: 'main' }]);
    expect(body.data.pending_interactions).toEqual([]);
    expect(body.data.tasks).toEqual([]);
    const turns = transcriptTurnTexts(body);
    expect(turns.map((turn) => turn.turnId)).toEqual(['t0', 't1', 't2']);
    expect(turns.every((turn) => turn.state === 'completed')).toBe(true);
    expect(turns[2]?.texts.join('')).toContain('turn three');

    const paged = await get(env, '/sessions/ses_tr/transcript?agent_id=main&page_size=2');
    const pagedBody = await paged.json();
    expect(pagedBody.data.has_more).toBe(true);
    expect(transcriptTurnTexts(pagedBody).map((turn) => turn.turnId)).toEqual(['t1', 't2']);

    const before = await get(env, '/sessions/ses_tr/transcript?agent_id=main&before_turn=t1');
    const beforeBody = await before.json();
    expect(beforeBody.data.has_more).toBe(false);
    expect(transcriptTurnTexts(beforeBody).map((turn) => turn.turnId)).toEqual(['t0']);

    const after = await get(env, '/sessions/ses_tr/transcript?agent_id=main&after_turn=t0&page_size=2');
    const afterBody = await after.json();
    expect(afterBody.data.has_more).toBe(false);
    expect(transcriptTurnTexts(afterBody).map((turn) => turn.turnId)).toEqual(['t1', 't2']);
  });

  it('rejects invalid transcript queries with 40001 and unknown sessions with the kap message', async () => {
    const env = await mountHttp([bindTestLlm(createMockRequester())]);
    await openMain(env, 'ses_tr_query');

    const missing = await get(env, '/sessions/ses_tr_query/transcript');
    expect(await missing.json()).toMatchObject({ code: 40001, msg: 'agent_id is required' });

    const both = await get(
      env,
      '/sessions/ses_tr_query/transcript?agent_id=main&before_turn=t1&after_turn=t0',
    );
    expect(await both.json()).toMatchObject({
      code: 40001,
      msg: 'before_turn and after_turn are mutually exclusive',
    });

    const small = await get(env, '/sessions/ses_tr_query/transcript?agent_id=main&page_size=0');
    expect(await small.json()).toMatchObject({ code: 40001 });
    const large = await get(env, '/sessions/ses_tr_query/transcript?agent_id=main&page_size=101');
    expect(await large.json()).toMatchObject({ code: 40001 });

    const separator = await get(env, '/sessions/ses_tr_query/transcript?agent_id=a%2Fb');
    expect(await separator.json()).toMatchObject({ code: 40001 });

    const ghost = await get(env, '/sessions/ses_tr_ghost/transcript?agent_id=main');
    expect(await ghost.json()).toMatchObject({
      code: 40401,
      msg: 'session not found: ses_tr_ghost',
    });
  });

  it('serves a cold session transcript from persisted history after resume', async () => {
    const env = await mountHttp([bindTestLlm(createMockRequester())]);
    const session = await openMain(env, 'ses_tr_cold');
    const agent = session.get(MAIN_AGENT_ID) as AgentHandle;
    queue = [{ text: 'cold baseline' }];
    await runTurn(agent);
    await env.app.close('ses_tr_cold');
    expect(env.app.get('ses_tr_cold')).toBeUndefined();

    const response = await get(env, '/sessions/ses_tr_cold/transcript?agent_id=main');
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.code).toBe(0);
    const turns = transcriptTurnTexts(body);
    expect(turns).toHaveLength(1);
    expect(turns[0]).toMatchObject({ turnId: 't0', state: 'completed' });
    expect(turns[0]?.texts.join('')).toContain('cold baseline');
    expect(env.app.get('ses_tr_cold')).toBeDefined();
  });

  it('projects ExitPlanMode plans from tool output and from review interactions', async () => {
    const env = await mountHttp([
      interaction,
      bindTestExitPlanTool(
        () =>
          'Exited plan mode. Plan mode deactivated. All tools are now available.\nPlan saved to: /tmp/plan-a.md\n\n## Approved Plan:\nShip the feature',
      ),
      bindTestLlm(createMockRequester()),
    ]);
    const session = await openMain(env, 'ses_tr_plan');
    const agent = session.get(MAIN_AGENT_ID) as AgentHandle;

    queue = [{ toolCall: { name: 'ExitPlanMode', arguments: '{}' } }, { text: 'done one' }];
    await runTurn(agent);
    const firstCallId = lastToolCallId(session);
    queue = [{ toolCall: { name: 'ExitPlanMode', arguments: '{}' } }, { text: 'done two' }];
    await runTurn(agent);
    const secondCallId = lastToolCallId(session);

    const interactions = session.resolve(InteractionRef);
    expect(interactions).toBeDefined();
    interactions!.enqueue({
      kind: 'approval',
      payload: {
        plan: 'Choose wisely',
        path: '/tmp/plan-b.md',
        options: [{ label: 'Option A' }, { label: 'Option B', description: 'desc B' }],
      },
      tags: {
        [INTERACTION_TAG_SESSION_ID]: 'ses_tr_plan',
        [INTERACTION_TAG_AGENT_ID]: MAIN_AGENT_ID,
        [INTERACTION_TAG_TOOL_CALL_ID]: secondCallId,
      },
    });

    const listed = await get(env, '/sessions/ses_tr_plan/transcript/plan?agent_id=main');
    expect(listed.status).toBe(200);
    const body = await listed.json();
    expect(body.code).toBe(0);
    expect(body.data.agent_id).toBe('main');
    expect(body.data.plans).toHaveLength(2);
    expect(body.data.plans[0]).toMatchObject({
      tool_call_id: firstCallId,
      turn_id: 't0',
      source: 'output',
      plan: 'Ship the feature',
      path: '/tmp/plan-a.md',
    });
    expect(body.data.plans[0]['review']).toBeUndefined();
    expect(body.data.plans[1]).toMatchObject({
      tool_call_id: secondCallId,
      turn_id: 't1',
      source: 'interaction',
      plan: 'Choose wisely',
      path: '/tmp/plan-b.md',
      options: [{ label: 'Option A' }, { label: 'Option B', description: 'desc B' }],
      review: { state: 'pending' },
    });

    const narrowed = await get(
      env,
      `/sessions/ses_tr_plan/transcript/plan?agent_id=main&tool_call_id=${firstCallId}`,
    );
    const narrowedBody = await narrowed.json();
    expect(narrowedBody.data.plans).toHaveLength(1);
    expect(narrowedBody.data.plans[0]['tool_call_id']).toBe(firstCallId);

    const unknown = await get(
      env,
      '/sessions/ses_tr_plan/transcript/plan?agent_id=main&tool_call_id=call-nope',
    );
    expect(await unknown.json()).toMatchObject({
      code: 40416,
      msg: 'no ExitPlanMode tool call found for tool_call_id: call-nope',
    });

    const ghost = await get(env, '/sessions/ses_tr_ghost/transcript/plan?agent_id=main');
    expect(await ghost.json()).toMatchObject({
      code: 40401,
      msg: 'session not found: ses_tr_ghost',
    });
  });

  it('serves resolved plan reviews and the ops watermark once a transcript stream is attached', async () => {
    const env = await mountHttp([
      interaction,
      bindTestExitPlanTool(() => 'Exited plan mode. ## Approved Plan:\nHidden plan'),
      bindTestLlm(createMockRequester()),
    ]);
    const session = await openMain(env, 'ses_tr_review');
    const agent = session.get(MAIN_AGENT_ID) as AgentHandle;

    const client = await connectWsV1(env);
    await client.next((frame) => frame['type'] === 'server_hello');
    client.send({
      type: 'subscribe_v2',
      id: 's1',
      payload: { session_id: 'ses_tr_review', transcript: { [MAIN_AGENT_ID]: 'delta' } },
    });
    await client.next((frame) => frame['type'] === 'ack' && frame['id'] === 's1');
    await client.next((frame) => frame['type'] === 'transcript.reset');

    queue = [{ toolCall: { name: 'ExitPlanMode', arguments: '{}' } }, { text: 'done' }];
    await runTurn(agent);
    const callId = lastToolCallId(session);

    const interactions = session.resolve(InteractionRef);
    const enqueued = interactions!.enqueue({
      kind: 'approval',
      payload: { plan: 'Reviewed plan', path: '/tmp/plan-c.md', options: [{ label: 'Option B' }] },
      tags: {
        [INTERACTION_TAG_SESSION_ID]: 'ses_tr_review',
        [INTERACTION_TAG_AGENT_ID]: MAIN_AGENT_ID,
        [INTERACTION_TAG_TOOL_CALL_ID]: callId,
      },
    });
    await client.next((frame) => {
      if (frame['type'] !== 'transcript.ops') return false;
      const ops = ((frame['payload'] as Record<string, unknown>)['ops'] ?? []) as Record<string, unknown>[];
      return ops.some((op) => op['op'] === 'interaction.upsert');
    });
    expect(interactions!.respond(enqueued.id, { decision: 'approved', selectedLabel: 'Option B' })).toBe(
      true,
    );
    await client.next((frame) => {
      if (frame['type'] !== 'transcript.ops') return false;
      const ops = ((frame['payload'] as Record<string, unknown>)['ops'] ?? []) as Record<string, unknown>[];
      return ops.some(
        (op) =>
          op['op'] === 'interaction.upsert' &&
          (op['interaction'] as Record<string, unknown>)['state'] === 'approved',
      );
    });

    const listed = await get(env, '/sessions/ses_tr_review/transcript/plan?agent_id=main');
    const body = await listed.json();
    expect(body.data.plans).toHaveLength(1);
    expect(body.data.plans[0]).toMatchObject({
      tool_call_id: callId,
      source: 'interaction',
      plan: 'Reviewed plan',
      path: '/tmp/plan-c.md',
      options: [{ label: 'Option B' }],
      review: { state: 'approved', selected_option: 'Option B' },
    });

    const baseline = await get(env, '/sessions/ses_tr_review/transcript?agent_id=main');
    const baselineBody = await baseline.json();
    expect(typeof baselineBody.data.seq).toBe('number');
    expect(baselineBody.data.seq).toBeGreaterThan(0);
    expect(baselineBody.data.interactions).toHaveLength(1);
    expect(baselineBody.data.pending_interactions).toEqual([]);
    await client.close();
  });
});

function jsonResponse(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function stubOAuthFetch(
  options: { polls?: readonly (() => Response)[] } & {
    models?: { current: readonly unknown[] };
  } = {},
): void {
  let pollIndex = 0;
  const realFetch = globalThis.fetch;
  vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.startsWith('http://127.0.0.1') || url.startsWith('http://localhost')) {
      return realFetch(input, init);
    }
    if (url.endsWith('/api/oauth/device_authorization')) {
      return jsonResponse({
        user_code: 'ABCD-EFGH',
        device_code: 'device-code-1',
        verification_uri: 'https://auth.example.com/device',
        verification_uri_complete: 'https://auth.example.com/device?user_code=ABCD-EFGH',
        expires_in: 900,
        interval: 1,
      });
    }
    if (url.endsWith('/api/oauth/token')) {
      const polls = options.polls;
      const next =
        polls === undefined
          ? () =>
              jsonResponse({
                access_token: 'sk-new-access',
                refresh_token: 'refresh-new',
                expires_in: 3600,
              })
          : polls[Math.min(pollIndex, polls.length - 1)];
      pollIndex += 1;
      return next();
    }
    if (url.endsWith('/models')) {
      return jsonResponse({ data: options.models?.current ?? [] });
    }
    if (url.endsWith('/usages')) {
      return jsonResponse({ usages: { limit_5h: { used_ratio: 0.5 } }, boosterWallet: null });
    }
    if (url.endsWith('/me')) {
      return jsonResponse({ user_id: 'u_123', nickname: 'moonwalker' });
    }
    throw new Error(`unexpected fetch: ${url}`);
  });
}

async function seedManagedToken(home: string): Promise<void> {
  await new FileTokenStorage(join(home, 'credentials')).save('kimi-code', {
    accessToken: 'sk-managed',
    refreshToken: 'refresh-token',
    expiresAt: Math.floor(Date.now() / 1000) + 3600,
    scope: '',
    tokenType: 'Bearer',
    expiresIn: 3600,
  });
}

const MANAGED_PROVIDER_HTTP_TOML =
  '[providers."managed:kimi-code"]\n' +
  'type = "kimi"\n' +
  'baseUrl = "https://api.kimi.com/coding/v1"\n\n' +
  '[providers."managed:kimi-code".oauth]\n' +
  'storage = "file"\n' +
  'key = "oauth/kimi-code"\n';

describe('feature-http auth/oauth routes', () => {
  it('runs the device login, poll and logout routes end to end', async () => {
    const home = await tempDir('oauth-http-');
    stubOAuthFetch();
    const env = await mountHttp([
      createConfig({ persist: fakePersist().persist }),
      providerCatalog,
      createKimi({ oauth: { home } }),
    ]);

    const started = await post(env, '/oauth/login', {});
    expect(started.status).toBe(200);
    const startBody = await started.json();
    expect(startBody.data).toMatchObject({
      provider: 'managed:kimi-code',
      status: 'pending',
      verification_uri: 'https://auth.example.com/device',
      verification_uri_complete: 'https://auth.example.com/device?user_code=ABCD-EFGH',
      user_code: 'ABCD-EFGH',
      expires_in: 900,
      interval: 1,
    });
    expect(startBody.data.flow_id).toMatch(/^oauth_/);
    expect(Number.isNaN(Date.parse(startBody.data.expires_at))).toBe(false);

    await vi.waitFor(async () => {
      const poll = await get(env, '/oauth/login');
      expect((await poll.json()).data.status).toBe('authenticated');
    });
    const snapshot = await get(env, '/oauth/login?provider=managed%3Akimi-code');
    const snapshotBody = await snapshot.json();
    expect(snapshotBody.data).toMatchObject({ status: 'authenticated', user_code: 'ABCD-EFGH' });
    expect(typeof snapshotBody.data.resolved_at).toBe('string');

    const stored = JSON.parse(await readFile(join(home, 'credentials', 'kimi-code.json'), 'utf8')) as {
      access_token?: string;
      accessToken?: string;
    };
    expect(stored.access_token ?? stored.accessToken).toBe('sk-new-access');

    const badRegion = await post(env, '/oauth/login', { region: 'moon' });
    expect(badRegion.status).toBe(200);
    expect(await badRegion.json()).toMatchObject({ code: 40001 });

    const logout = await post(env, '/oauth/logout', {});
    expect(logout.status).toBe(200);
    expect(await logout.json()).toMatchObject({
      data: { logged_out: true, provider: 'managed:kimi-code' },
    });
    await expect(readFile(join(home, 'credentials', 'kimi-code.json'), 'utf8')).rejects.toThrow();

    const loggedOut = await get(env, '/auth');
    expect((await loggedOut.json()).data.managed_provider).toBeNull();
  });

  it('polls a pending flow, cancels it, validates input and reports 40948 when oauth is absent', async () => {
    const home = await tempDir('oauth-http-cancel-');
    stubOAuthFetch({ polls: [() => jsonResponse({ error: 'authorization_pending' }, 400)] });
    const env = await mountHttp([
      createConfig({ persist: fakePersist().persist }),
      providerCatalog,
      createKimi({ oauth: { home } }),
    ]);

    const started = await post(env, '/oauth/login', { provider: 'managed:kimi-code' });
    expect(started.status).toBe(200);
    expect((await started.json()).data.status).toBe('pending');

    const pending = await get(env, '/oauth/login');
    expect(pending.status).toBe(200);
    expect((await pending.json()).data.status).toBe('pending');

    const badQuery = await get(env, '/oauth/login?provider=');
    expect(badQuery.status).toBe(200);
    expect(await badQuery.json()).toMatchObject({ code: 40001 });

    const cancelled = await del(env, '/oauth/login');
    expect(cancelled.status).toBe(200);
    expect(await cancelled.json()).toMatchObject({
      data: { cancelled: true, status: 'cancelled' },
    });

    const bare = await mountHttp([]);
    const probes = [
      () => get(bare, '/auth'),
      () => post(bare, '/oauth/login', {}),
      () => get(bare, '/oauth/login'),
      () => del(bare, '/oauth/login'),
      () => post(bare, '/oauth/logout', {}),
      () => get(bare, '/oauth/usage'),
      () => get(bare, '/oauth/userinfo'),
      () => get(bare, '/oauth/region'),
      () => post(bare, '/providers:refresh_oauth'),
    ];
    for (const probe of probes) {
      const response = await probe();
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({ code: 40948 });
    }
  });

  it('refreshes oauth-backed providers through the providers collection action', async () => {
    const home = await tempDir('oauth-http-refresh-');
    await seedManagedToken(home);
    const models: { current: readonly unknown[] } = {
      current: [
        {
          id: 'kimi-for-coding',
          context_length: 262144,
          supports_reasoning: true,
          supports_image_in: true,
          supports_video_in: false,
          supports_tool_use: true,
        },
      ],
    };
    stubOAuthFetch({ models });
    const file = fakePersist(
      '[providers."managed:kimi-code"]\n' +
        'type = "kimi"\n' +
        'base_url = "https://managed.example.com"\n' +
        'model_source = "oauth-catalog"\n\n' +
        '[providers."managed:kimi-code".oauth]\n' +
        'storage = "file"\n' +
        'key = "oauth/kimi-code"\n\n' +
        '[model_catalog]\n' +
        'refresh_on_start = false\n' +
        'refresh_interval_ms = 0\n',
    );
    const env = await mountHttp([
      createConfig({ persist: file.persist }),
      providerCatalog,
      createKimi({ oauth: { home } }),
    ]);
    await vi.waitFor(async () => {
      expect(file.saved.at(-1)?.includes('kimi-code/kimi-for-coding')).toBe(true);
    });

    const first = await post(env, '/providers:refresh_oauth');
    expect(first.status).toBe(200);
    expect(await first.json()).toMatchObject({
      code: 0,
      data: { changed: [], unchanged: ['managed:kimi-code'], failed: [] },
    });

    models.current = [
      ...models.current,
      {
        id: 'kimi-latest',
        context_length: 131072,
        supports_reasoning: false,
        supports_image_in: false,
        supports_video_in: false,
        supports_tool_use: true,
      },
    ];
    const second = await post(env, '/providers:refresh_oauth');
    expect(second.status).toBe(200);
    expect(await second.json()).toMatchObject({
      code: 0,
      data: {
        changed: [
          { provider_id: 'managed:kimi-code', provider_name: 'Kimi Code', added: 1, removed: 0 },
        ],
        unchanged: [],
        failed: [],
      },
    });
    await vi.waitFor(async () => {
      expect(file.saved.at(-1)?.includes('kimi-code/kimi-latest')).toBe(true);
    });
  });

  it('serves usage, userinfo, region and the auth summary over http', async () => {
    const home = await tempDir('oauth-http-info-');
    await seedManagedToken(home);
    stubOAuthFetch();
    const env = await mountHttp([
      createConfig({ persist: fakePersist(MANAGED_PROVIDER_HTTP_TOML).persist }),
      providerCatalog,
      createKimi({ oauth: { home } }),
    ]);

    const usage = await get(env, '/oauth/usage');
    expect(usage.status).toBe(200);
    expect(await usage.json()).toMatchObject({
      data: { kind: 'ok', quota: { usages: { limit5h: { usedRatio: 0.5 } }, extraUsage: null } },
    });

    const userinfo = await get(env, '/oauth/userinfo');
    expect(userinfo.status).toBe(200);
    expect(await userinfo.json()).toMatchObject({
      data: { kind: 'ok', userInfo: { userId: 'u_123', nickname: 'moonwalker' } },
    });

    const region = await get(env, '/oauth/region');
    expect(region.status).toBe(200);
    expect(await region.json()).toMatchObject({ data: { region: 'mainland-cn' } });

    const auth = await get(env, '/auth');
    expect(auth.status).toBe(200);
    expect(await auth.json()).toMatchObject({
      data: {
        models_ready: false,
        providers_count: 1,
        managed_provider: { name: 'managed:kimi-code', status: 'authenticated' },
      },
    });
  });
});

describe('feature-http files and session media routes', () => {
  const postForm = (env: HttpEnv, path: string, form: FormData): Promise<Response> =>
    fetch(`${env.origin}/api/v1${path}`, { method: 'POST', body: form });

  it('uploads a file over multipart and streams it back with kap headers', async () => {
    const dir = await tempDir('files-lib-');
    const env = await mountHttp([createFiles({ dir })]);
    const bytes = Buffer.from('png-bytes-0123456789');
    const form = new FormData();
    form.append('file', new Blob([bytes], { type: 'image/png' }), 'pic.png');

    const uploaded = await postForm(env, '/files', form);
    expect(uploaded.status).toBe(200);
    const body = await uploaded.json();
    expect(body).toMatchObject({ code: 0, msg: 'success', request_id: '' });
    const meta = body.data;
    expect(meta.id).toMatch(/^f_/);
    expect(meta.name).toBe('pic.png');
    expect(meta.media_type).toBe('image/png');
    expect(meta.size).toBe(bytes.length);
    expect(Number.isNaN(Date.parse(meta.created_at))).toBe(false);
    expect(meta.expires_at).toBeUndefined();
    expect(await readFile(join(dir, meta.id))).toEqual(bytes);

    const got = await get(env, `/files/${meta.id}`);
    expect(got.status).toBe(200);
    expect(got.headers.get('content-type')).toBe('image/png');
    expect(got.headers.get('content-disposition')).toBe('inline; filename="pic.png"');
    expect(got.headers.get('accept-ranges')).toBe('bytes');
    expect(got.headers.get('etag')).toBe(`"${meta.id}-${bytes.length}"`);
    expect(got.headers.get('content-length')).toBe(String(bytes.length));
    expect(Buffer.from(await got.arrayBuffer())).toEqual(bytes);
  });

  it('honors the name override and expiry fields, and marks downloads as attachment for non-media types', async () => {
    const dir = await tempDir('files-lib-');
    const env = await mountHttp([createFiles({ dir })]);
    const form = new FormData();
    form.append('file', new Blob([Buffer.from('hello')], { type: 'text/plain' }), 'orig.bin');
    form.append('name', 'renamed.txt');
    form.append('expires_in_sec', '3600');

    const uploaded = await postForm(env, '/files', form);
    const meta = (await uploaded.json()).data;
    expect(meta.name).toBe('renamed.txt');
    expect(meta.media_type).toBe('text/plain');
    expect(Date.parse(meta.expires_at)).toBeGreaterThan(Date.now());

    const got = await get(env, `/files/${meta.id}`);
    expect(got.headers.get('content-disposition')).toBe('attachment; filename="renamed.txt"');
  });

  it('rejects multipart posts without a file part and reports missing files with the kap code', async () => {
    const dir = await tempDir('files-lib-');
    const env = await mountHttp([createFiles({ dir })]);

    const form = new FormData();
    form.append('name', 'only-text');
    const rejected = await postForm(env, '/files', form);
    expect(rejected.status).toBe(200);
    expect(await rejected.json()).toMatchObject({ code: 40001, msg: 'missing `file` field' });

    const missing = await get(env, '/files/f_00000000-0000-0000-0000-000000000000');
    expect(missing.status).toBe(200);
    expect(await missing.json()).toMatchObject({ code: 40407, msg: 'file not found' });

    const malformed = await get(env, '/files/not-a-file-id');
    expect(await malformed.json()).toMatchObject({ code: 40407 });
  });

  it('serves byte ranges with 206 and kap range semantics', async () => {
    const dir = await tempDir('files-lib-');
    const env = await mountHttp([createFiles({ dir })]);
    const bytes = Buffer.from('0123456789');
    const form = new FormData();
    form.append('file', new Blob([bytes], { type: 'application/octet-stream' }), 'range.bin');
    const meta = (await (await postForm(env, '/files', form)).json()).data;

    const ranged = await fetch(`${env.origin}/api/v1/files/${meta.id}`, {
      headers: { range: 'bytes=2-5' },
    });
    expect(ranged.status).toBe(206);
    expect(ranged.headers.get('content-range')).toBe(`bytes 2-5/${bytes.length}`);
    expect(ranged.headers.get('content-length')).toBe('4');
    expect(Buffer.from(await ranged.arrayBuffer())).toEqual(bytes.subarray(2, 6));

    const suffix = await fetch(`${env.origin}/api/v1/files/${meta.id}`, {
      headers: { range: 'bytes=-3' },
    });
    expect(suffix.status).toBe(206);
    expect(suffix.headers.get('content-range')).toBe(`bytes 7-9/${bytes.length}`);
    expect(Buffer.from(await suffix.arrayBuffer())).toEqual(bytes.subarray(7));

    const open = await fetch(`${env.origin}/api/v1/files/${meta.id}`, {
      headers: { range: 'bytes=4-' },
    });
    expect(open.status).toBe(206);
    expect(Buffer.from(await open.arrayBuffer())).toEqual(bytes.subarray(4));
  });

  it('streams session media, falls back to the staged file library, and maps kap error codes', async () => {
    const dir = await tempDir('files-lib-');
    const store = createMemoryMediaStore();
    const env = await mountHttp([
      createFiles({ dir }),
      createMedia({ workDir: dir, store, cache: createMemoryMediaUploadCache() }),
    ]);
    await env.app.open({ sessionId: 'ses_media' });

    const bytes = Buffer.from('media-bytes-abcdef');
    const ref = await store.put({ bytes, mimeType: 'image/png', filename: 'shot.png' });

    const got = await get(env, `/sessions/ses_media/media/${ref}`);
    expect(got.status).toBe(200);
    expect(got.headers.get('content-type')).toBe('image/png');
    expect(got.headers.get('content-disposition')).toBe('inline; filename="shot.png"');
    expect(got.headers.get('accept-ranges')).toBe('bytes');
    expect(got.headers.get('etag')).toBe(`"ses_media-${ref}-${bytes.length}"`);
    expect(Buffer.from(await got.arrayBuffer())).toEqual(bytes);

    const ranged = await fetch(`${env.origin}/api/v1/sessions/ses_media/media/${ref}`, {
      headers: { range: 'bytes=1-3' },
    });
    expect(ranged.status).toBe(206);
    expect(ranged.headers.get('content-range')).toBe(`bytes 1-3/${bytes.length}`);
    expect(Buffer.from(await ranged.arrayBuffer())).toEqual(bytes.subarray(1, 4));

    const stagedForm = new FormData();
    stagedForm.append('file', new Blob([Buffer.from('staged')], { type: 'text/plain' }), 'staged.txt');
    const stagedMeta = (await (await postForm(env, '/files', stagedForm)).json()).data;
    const staged = await get(env, `/sessions/ses_media/media/${stagedMeta.id}`);
    expect(staged.status).toBe(200);
    expect(Buffer.from(await staged.arrayBuffer())).toEqual(Buffer.from('staged'));

    const missingFile = await get(env, '/sessions/ses_media/media/f_00000000-0000-0000-0000-000000000000');
    expect(await missingFile.json()).toMatchObject({ code: 40407, msg: 'file not found' });

    const missingSession = await get(env, `/sessions/ses_ghost/media/${ref}`);
    expect(await missingSession.json()).toMatchObject({ code: 40401, msg: 'session not found' });
  });

  it('reports unavailable codes when the files or media features are not installed', async () => {
    const bare = await mountHttp([]);
    await bare.app.open({ sessionId: 'ses_bare' });

    const form = new FormData();
    form.append('file', new Blob([Buffer.from('x')]), 'x.bin');
    const uploaded = await postForm(bare, '/files', form);
    expect(await uploaded.json()).toMatchObject({ code: 40951 });

    const downloaded = await get(bare, '/files/f_00000000-0000-0000-0000-000000000000');
    expect(await downloaded.json()).toMatchObject({ code: 40951 });

    const media = await get(bare, '/sessions/ses_bare/media/abc123');
    expect(await media.json()).toMatchObject({ code: 40950 });
  });
});

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  agentContextOf,
  closeSessionById,
  DYNAMIC_TOOL_SCHEMA_VARIANT,
  getLiveSessionById,
  IAgentLifecycleService,
  IAgentLoopService,
  IEventDispatcher,
  IModelCatalog,
  ISessionTokenCountingService,
  IWireService,
  type ContextMessage,
  type IAgentScopeHandle,
  type ScopeSeed,
} from '@moonshot-ai/agent-core-v2';
import { historyEntryFromContext } from '@moonshot-ai/agent-core-v2/agent/loop/history';
import { estimateTokens } from '@moonshot-ai/agent-core-v2/llm-adapter/contract/tokens';
import type { ToolCall } from '@moonshot-ai/core/llm/message';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { ErrorCode } from '../src/protocol/error-codes';
import type {
  ContextItemDetail,
  ContextItemsResponse,
  ContextSummary,
} from '../src/protocol/rest-context';
import { splitSystemPromptParts } from '../src/routes/context';
import { selectContextItems } from '../src/routes/contextItems';
import { type RunningServer, startServer } from '../src/start';
import { authHeaders } from './helpers/auth';
import { TEST_HOST_IDENTITY } from './helpers/hostIdentity';

function item(id: string, role: string) {
  return {
    id,
    role,
    preview: id,
    tokens: id.length,
    has_media: false,
  };
}

const system = item('system', 'system');
const user = item('message-0', 'user');
const assistant = item('message-1', 'assistant');
const tool = item('tool-0', 'definition');
const nonTools = [system, user, assistant];
const tools = [tool];

describe('selectContextItems', () => {
  it('keeps tools separate from the unfiltered message page', () => {
    expect(selectContextItems(nonTools, tools, [])).toEqual({ items: nonTools, tools });
  });

  it('retains the existing single-role behavior', () => {
    expect(selectContextItems(nonTools, tools, ['user'])).toEqual({ items: [user], tools: [] });
    expect(selectContextItems(nonTools, tools, ['definition'])).toEqual({ items: tools, tools });
  });

  it('combines selected roles in context order', () => {
    expect(selectContextItems(nonTools, tools, ['user', 'definition', 'system'])).toEqual({
      items: [system, tool, user],
      tools,
    });
  });
});

describe('splitSystemPromptParts', () => {
  it('splits top-level markdown sections while ignoring headings inside code fences', () => {
    const prompt = [
      'You are Kimi Code.',
      '',
      '# Project information',
      '',
      '```````',
      '# Repository-level Agent Guide',
      '## Working Principles',
      '```````',
      '',
      '# Skills',
      '',
      '## Available skills',
      '- demo-skill',
    ].join('\n');

    expect(splitSystemPromptParts(prompt)).toEqual([
      { kind: 'text', name: undefined, text: 'You are Kimi Code.' },
      {
        kind: 'text',
        name: 'Project information',
        text: ['```````', '# Repository-level Agent Guide', '## Working Principles', '```````'].join('\n'),
      },
      {
        kind: 'text',
        name: 'Skills',
        text: '## Available skills\n- demo-skill',
      },
    ]);
  });
});

describe('context routes on restored sessions and dynamic tools', () => {
  let server: RunningServer | undefined;
  let home: string | undefined;
  let base: string;

  const TOOL_SELECT_ENV = 'KIMI_CODE_EXPERIMENTAL_TOOL_SELECT';

  beforeAll(async () => {
    home = await mkdtemp(join(tmpdir(), 'kimi-server-v2-context-'));
    const modelCatalog: IModelCatalog = {
      _serviceBrand: undefined,
      get: (id: string) => ({
        id,
        providerName: 'kimi',
        providerType: 'kimi',
        protocol: 'openai',
        maxOutputSize: 8192,
        spec: {
          name: id,
          maxContextSize: 262144,
          capability: {
            tool_use: true,
            thinking: true,
            dynamically_loaded_tools: true,
          },
        },
      } as never),
      findByName: () => [],
      listModels: async () => [],
      listProviders: async () => [],
      getProvider: async () => {
        throw new Error('not implemented');
      },
      setDefaultModel: async () => {
        throw new Error('not implemented');
      },
    };
    const seeds: ScopeSeed = [[IModelCatalog, modelCatalog]];
    process.env[TOOL_SELECT_ENV] = '1';
    server = await startServer({
      hostIdentity: TEST_HOST_IDENTITY,
      host: '127.0.0.1',
      port: 0,
      homeDir: home,
      logLevel: 'silent',
      seeds,
    });
    base = `http://127.0.0.1:${server.port}`;
  });

  afterAll(async () => {
    delete process.env[TOOL_SELECT_ENV];
    if (server !== undefined) {
      await server.close();
      server = undefined;
    }
    if (home !== undefined) {
      await rm(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
      home = undefined;
    }
  });

  async function getEnvelope<T>(path: string): Promise<{ code: number; data: T; msg: string }> {
    const res = await fetch(`${base}${path}`, {
      headers: authHeaders(server!),
    } as never);
    return (await res.json()) as { code: number; data: T; msg: string };
  }

  async function getJson<T>(path: string): Promise<T> {
    const body = await getEnvelope<T>(path);
    expect(body.code, body.msg).toBe(0);
    return body.data;
  }

  async function createSession(): Promise<string> {
    const res = await fetch(`${base}/api/v1/sessions`, {
      method: 'POST',
      headers: authHeaders(server!, { 'content-type': 'application/json' }),
      body: JSON.stringify({ metadata: { cwd: home! } }),
    } as never);
    const created = (await res.json()) as { code: number; data: { id: string } };
    expect(created.code).toBe(0);
    return created.data.id;
  }

  async function seedMainAgent(sid: string): Promise<IAgentScopeHandle> {
    const lifecycle = getLiveSessionById(server!.core.accessor, sid)!.accessor.get(IAgentLifecycleService);
    await lifecycle.create({ agentId: 'main' });
    const main = lifecycle.handleOf('main')!;
    const loop = main.accessor.get(IAgentLoopService);
    await loop.setProfile({
      modelAlias: 'kimi-code/k3',
      profileName: 'agent',
      thinkingLevel: 'high',
      systemPrompt: 'You are Kimi Code.',
    });
    loop.replaceHistory(
      [
        { role: 'user', content: [{ type: 'text', text: 'summarize the repository layout' }] },
        {
          role: 'assistant',
          content: [{ type: 'text', text: 'It is a TypeScript monorepo with apps and packages.' }],
          toolCalls: [],
        },
      ],
      'fork',
    );
    await main.accessor.get(IEventDispatcher).flush();
    return main;
  }

  function sumTokens(entries: readonly { tokens: number }[]): number {
    return entries.reduce((sum, entry) => sum + entry.tokens, 0);
  }

  it('rejects item ids that the listing never produces', async () => {
    const sid = await createSession();
    const toolDetail = await getJson<ContextItemDetail>(`/api/v1/sessions/${sid}/context/items/tool-0`);
    expect(toolDetail.id).toBe('tool-0');

    for (const id of ['tool-0junk', 'tool-01', 'tool--1', 'message-0-extra']) {
      const body = await getEnvelope<null>(`/api/v1/sessions/${sid}/context/items/${id}`);
      expect(body.code, id).toBe(ErrorCode.MESSAGE_NOT_FOUND);
    }
  });

  it('preserves system prompt sections after session close/resume and surfaces dynamic tool schemas', async () => {
    const sid = await createSession();

    const live = getLiveSessionById(server!.core.accessor, sid)!;
    await live.accessor.get(IAgentLifecycleService).create({ agentId: 'main' });
    const main = live.accessor.get(IAgentLifecycleService).handleOf('main')!;
    const loop = main.accessor.get(IAgentLoopService);

    await loop.setProfile({
      modelAlias: 'kimi-code/k3',
      profileName: 'agent',
      thinkingLevel: 'high',
      systemPrompt: 'You are Kimi Code.\n\n# Skills\n\nAvailable skill: demo-skill',
    });
    const dynamicSchema: ContextMessage = {
      role: 'system',
      content: [],
      tools: [
        {
          name: 'mcp__demo__search',
          description: 'Search demo records',
          parameters: {
            type: 'object',
            properties: { query: { type: 'string', description: 'Search query' } },
            required: ['query'],
          },
        },
      ],
      origin: { kind: 'injection', variant: DYNAMIC_TOOL_SCHEMA_VARIANT },
    };
    loop.replaceHistory(
      [
        { role: 'user', content: [{ type: 'text', text: 'hello' }] },
        historyEntryFromContext(dynamicSchema),
      ],
      'fork',
    );
    await main.accessor.get(IEventDispatcher).flush();
    await main.accessor.get(IWireService).flush();

    await closeSessionById(server!.core.accessor, sid);

    const summary = await getJson<ContextSummary>(`/api/v1/sessions/${sid}/context/summary`);
    expect(summary.model).toBe('kimi-code/k3');
    const systemGroup = summary.groups.find((g) => g.role === 'system');
    expect(systemGroup).toBeDefined();
    expect(systemGroup!.count).toBeGreaterThanOrEqual(1);
    expect(systemGroup!.tokens).toBe(
      estimateTokens('You are Kimi Code.\n\n# Skills\n\nAvailable skill: demo-skill'),
    );

    const page = await getJson<ContextItemsResponse>(`/api/v1/sessions/${sid}/context/items`);
    expect(page.items[0]).toMatchObject({
      id: 'system',
      role: 'system',
    });
    expect(page.tools.length).toBeGreaterThan(0);

    const systemDetail = await getJson<ContextItemDetail>(
      `/api/v1/sessions/${sid}/context/items/system`,
    );
    expect(systemDetail.parts).toEqual([
      { kind: 'text', text: 'You are Kimi Code.', tokens: estimateTokens('You are Kimi Code.') },
      {
        kind: 'text',
        name: 'Skills',
        text: 'Available skill: demo-skill',
        tokens: estimateTokens('Available skill: demo-skill'),
      },
    ]);

    const dynamicMsgItem = page.items.find((entry) => entry.name === 'mcp__demo__search');
    expect(dynamicMsgItem).toBeDefined();
    expect(dynamicMsgItem!.role).toBe('definition');
    expect(dynamicMsgItem!.tokens).toBeGreaterThan(0);
    expect(dynamicMsgItem!.preview).toContain('Search demo records');
    expect(summary.groups.find((g) => g.role === 'definition')?.count).toBe(page.tools.length + 1);

    const definitions = await getJson<ContextItemsResponse>(
      `/api/v1/sessions/${sid}/context/items?role=definition`,
    );
    expect(definitions.items.map((entry) => entry.id)).toContain(dynamicMsgItem!.id);

    const dynamicDetail = await getJson<ContextItemDetail>(
      `/api/v1/sessions/${sid}/context/items/${dynamicMsgItem!.id}`,
    );
    expect(dynamicDetail.role).toBe('definition');
    expect(dynamicDetail.parts).toEqual([
      {
        kind: 'definition',
        name: 'mcp__demo__search',
        data: {
          name: 'mcp__demo__search',
          description: 'Search demo records',
          parameters: {
            type: 'object',
            properties: { query: { type: 'string', description: 'Search query' } },
            required: ['query'],
          },
        },
      },
    ]);
  });

  it('redacts media payloads without touching long plain text', async () => {
    const sid = await createSession();
    const live = getLiveSessionById(server!.core.accessor, sid)!;
    const lifecycle = live.accessor.get(IAgentLifecycleService);
    await lifecycle.create({ agentId: 'main' });
    const main = lifecycle.handleOf('main')!;
    const minified = JSON.stringify(
      Object.fromEntries(Array.from({ length: 80 }, (_, index) => [`key${index}`, index])),
    );
    const imageData = `data:image/png;base64,${'A'.repeat(800)}`;
    main.accessor.get(IAgentLoopService).replaceHistory(
      [
        {
          role: 'user',
          content: [
            { type: 'text', text: minified },
            { type: 'image_url', imageUrl: { url: imageData } },
          ],
        },
      ],
      'fork',
    );
    await main.accessor.get(IEventDispatcher).flush();
    await main.accessor.get(IWireService).flush();

    const detail = await getJson<ContextItemDetail>(`/api/v1/sessions/${sid}/context/items/message-0`);
    const raw = detail.raw as { content: [{ text: string }, { imageUrl: { url: string } }] };
    expect(minified.length).toBeGreaterThan(512);
    expect(raw.content[0].text).toBe(minified);
    expect(raw.content[1].imageUrl.url).toBe(`[encoded media · ${imageData.length} chars]`);
  });

  it('restores a persisted subagent before reading its context', async () => {
    const sid = await createSession();

    const live = getLiveSessionById(server!.core.accessor, sid)!;
    const lifecycle = live.accessor.get(IAgentLifecycleService);
    await lifecycle.create({ agentId: 'main' });
    await lifecycle.create({ agentId: 'agent-7' });
    const sub = lifecycle.handleOf('agent-7')!;
    const loop = sub.accessor.get(IAgentLoopService);
    await loop.setProfile({
      modelAlias: 'kimi-code/k3',
      profileName: 'agent',
      thinkingLevel: 'high',
      systemPrompt: 'You are a subagent.',
    });
    loop.replaceHistory([{ role: 'user', content: [{ type: 'text', text: 'inspect me' }] }], 'fork');
    await sub.accessor.get(IEventDispatcher).flush();
    await sub.accessor.get(IWireService).flush();

    await closeSessionById(server!.core.accessor, sid);

    const summary = await getJson<ContextSummary>(
      `/api/v1/sessions/${sid}/context/summary?agent_id=agent-7`,
    );
    expect(summary.agent_id).toBe('agent-7');
    const page = await getJson<ContextItemsResponse>(
      `/api/v1/sessions/${sid}/context/items?agent_id=agent-7`,
    );
    expect(page.items.some((entry) => entry.preview.includes('inspect me'))).toBe(true);
  });

  it('shows messages the way the model receives them', async () => {
    const sid = await createSession();

    const live = getLiveSessionById(server!.core.accessor, sid)!;
    await live.accessor.get(IAgentLifecycleService).create({ agentId: 'main' });
    const main = live.accessor.get(IAgentLifecycleService).handleOf('main')!;
    const loop = main.accessor.get(IAgentLoopService);
    await loop.setProfile({
      modelAlias: 'kimi-code/k3',
      profileName: 'agent',
      thinkingLevel: 'high',
      systemPrompt: 'You are Kimi Code.',
    });
    const call = (id: string, name: string): ToolCall => ({ type: 'function', id, name, arguments: '{}' });
    loop.replaceHistory(
      [
        { role: 'user', content: [{ type: 'text', text: 'run it' }] },
        { role: 'assistant', content: [], toolCalls: [call('call_1', 'Bash')] },
        { role: 'user', content: [{ type: 'text', text: 'reminder sent while the tool ran' }] },
        {
          role: 'tool',
          toolCallId: 'call_1',
          content: [{ type: 'text', text: 'ok' }],
          attributes: { durationMs: 1500, note: 'Output truncated.' },
        },
        { role: 'assistant', content: [], toolCalls: [call('call_2', 'Read')] },
        {
          role: 'tool',
          toolCallId: 'call_2',
          content: [{ type: 'text', text: 'missing file' }],
          attributes: { isError: true },
        },
        { role: 'assistant', content: [], toolCalls: [call('call_3', 'Bash')] },
        { role: 'user', content: [{ type: 'text', text: 'continue' }] },
      ],
      'fork',
    );
    await main.accessor.get(IEventDispatcher).flush();

    const page = await getJson<ContextItemsResponse>(`/api/v1/sessions/${sid}/context/items`);
    expect(page.items.map((entry) => entry.role)).toEqual([
      'system', 'user', 'assistant', 'tool', 'user', 'assistant', 'tool', 'assistant', 'tool', 'user',
    ]);
    const toolTexts = await Promise.all(
      page.items
        .filter((entry) => entry.role === 'tool')
        .map(async (entry) => {
          const detail = await getJson<ContextItemDetail>(`/api/v1/sessions/${sid}/context/items/${entry.id}`);
          return detail.parts.map((part) => part.text).join('\n');
        }),
    );
    expect(toolTexts).toEqual([
      'Wall time: 1.500 seconds\nok\nOutput truncated.',
      '<system>ERROR: Tool execution failed.</system>\nmissing file',
      'Tool result is not available in the current context. Do not assume the tool completed successfully.',
    ]);
  });

  it('reports the estimated total before any model call is measured', async () => {
    const sid = await createSession();
    await seedMainAgent(sid);

    const page = await getJson<ContextItemsResponse>(`/api/v1/sessions/${sid}/context/items`);
    expect(page.summary.tokens.used).toBeGreaterThan(0);
    expect(sumTokens(page.summary.groups)).toBe(page.summary.tokens.used);
    expect(sumTokens(page.tools) + sumTokens(page.items)).toBe(page.summary.tokens.used);
  });

  it('splits the measured context size across items in proportion to their estimates', async () => {
    const sid = await createSession();
    const main = await seedMainAgent(sid);
    const before = await getJson<ContextItemsResponse>(`/api/v1/sessions/${sid}/context/items`);
    const measured = before.summary.tokens.used * 3;
    main.accessor.get(ISessionTokenCountingService).rebase(agentContextOf(main), {
      length: main.accessor.get(IAgentLoopService).history().length,
      tokens: measured,
      measured: true,
    });
    await main.accessor.get(IEventDispatcher).flush();

    const after = await getJson<ContextItemsResponse>(`/api/v1/sessions/${sid}/context/items`);
    const itemCount = after.tools.length + after.items.length;
    expect(after.summary.tokens.used).toBe(measured);
    expect(Math.abs(sumTokens(after.summary.groups) - measured)).toBeLessThanOrEqual(itemCount);
    expect(Math.abs(sumTokens(after.tools) + sumTokens(after.items) - measured)).toBeLessThanOrEqual(itemCount);
    expect(after.items.find((entry) => entry.id === 'system')?.tokens).toBe(
      3 * before.items.find((entry) => entry.id === 'system')!.tokens,
    );
  });
});

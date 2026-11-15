import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  closeSessionById,
  DYNAMIC_TOOL_SCHEMA_VARIANT,
  getLiveSessionById,
  IAgentLifecycleService,
  IAgentLoopService,
  IEventDispatcher,
  IModelCatalog,
  IWireService,
  type ContextMessage,
  type ScopeSeed,
} from '@moonshot-ai/agent-core-v2';
import { historyEntryFromContext } from '@moonshot-ai/agent-core-v2/agent/loop/history';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

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
    chars: id.length,
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
      await rm(home, { recursive: true, force: true });
      home = undefined;
    }
  });

  async function getJson<T>(path: string): Promise<T> {
    const res = await fetch(`${base}${path}`, {
      headers: authHeaders(server!),
    } as never);
    const body = (await res.json()) as { code: number; data: T; msg: string };
    expect(body.code, body.msg).toBe(0);
    return body.data;
  }

  it('preserves system prompt sections after session close/resume and surfaces dynamic tool schemas', async () => {
    const createRes = await fetch(`${base}/api/v1/sessions`, {
      method: 'POST',
      headers: authHeaders(server!, { 'content-type': 'application/json' }),
      body: JSON.stringify({ metadata: { cwd: home! } }),
    } as never);
    const created = (await createRes.json()) as { code: number; data: { id: string } };
    expect(created.code).toBe(0);
    const sid = created.data.id;

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
    expect(systemGroup!.chars).toBeGreaterThan(50);

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
      { kind: 'text', text: 'You are Kimi Code.' },
      { kind: 'text', name: 'Skills', text: 'Available skill: demo-skill' },
    ]);

    const dynamicMsgItem = page.items.find((entry) => entry.name === 'mcp__demo__search');
    expect(dynamicMsgItem).toBeDefined();
    expect(dynamicMsgItem!.chars).toBeGreaterThan(0);
    expect(dynamicMsgItem!.preview).toContain('Search demo records');

    const dynamicDetail = await getJson<ContextItemDetail>(
      `/api/v1/sessions/${sid}/context/items/${dynamicMsgItem!.id}`,
    );
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
});

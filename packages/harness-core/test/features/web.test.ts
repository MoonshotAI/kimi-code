import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  createConfig,
  createFeature,
  createUserMessage,
  MAIN_AGENT_ID,
  MemoryBackend,
  createHarness,
  openBlobs,
  openSessionStores,
  providerCatalog,
  Trees,
  UNKNOWN_CAPABILITY,
  useAgent,
  ConfigRef,
  type AgentHandle,
  type ConfigPersist,
  type LlmModel,
  type LlmRequester,
  type ToolCall,
  type ToolDescription,
} from '@moonshot-ai/agent-core';
import { FileTokenStorage } from '@moonshot-ai/kimi-code-oauth';

import { createOauth } from '#/features/kimi/oauth/index';
import {
  classifySearchError,
  createMoonshotWebSearchProvider,
  createWeb,
  createWebSearchTool,
  formatSearchResults,
  SERVICES_CONFIG_SECTION,
  servicesConfigSection,
  WEB_SEARCH_PROVIDER_REMOVED_MESSAGE,
  WebSearchRef,
  type ServicesSection,
  type WebSearchProvider,
} from '#/features/kimi/web/index';

const homes: string[] = [];

afterEach(async () => {
  await Promise.all(homes.splice(0).map((home) => rm(home, { recursive: true, force: true })));
});

async function setupHome(): Promise<string> {
  const home = await mkdtemp(join(tmpdir(), 'harness-web-'));
  homes.push(home);
  await new FileTokenStorage(join(home, 'credentials')).save('kimi-code', {
    accessToken: 'sk-managed',
    refreshToken: 'refresh-token',
    expiresAt: Math.floor(Date.now() / 1000) + 3600,
    scope: '',
    tokenType: 'Bearer',
    expiresIn: 3600,
  });
  return home;
}

function fakePersist(initial?: string): ConfigPersist {
  let text = initial;
  return {
    load: () => Promise.resolve(text),
    save: (value) => {
      text = value;
      return Promise.resolve();
    },
  };
}

interface SearchCall {
  readonly url: string;
  readonly headers: Record<string, string>;
  readonly body: string;
}

function stubSearchFetch(handler: () => Response): { calls: SearchCall[]; fetchImpl: typeof fetch } {
  const calls: SearchCall[] = [];
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({
      url: String(input),
      headers: (init?.headers ?? {}) as Record<string, string>,
      body: String(init?.body ?? ''),
    });
    return handler();
  }) as typeof fetch;
  return { calls, fetchImpl };
}

const SEARCH_RESULTS = {
  search_results: [
    {
      title: 'T1',
      url: 'https://a.example.com',
      snippet: 'S1',
      site_name: 'SiteA',
      date: '2026-01-01',
    },
    { title: 'T2', url: 'https://b.example.com', snippet: 'S2' },
  ],
};

const MANAGED_PROVIDER_TOML =
  '[providers."managed:kimi-code"]\n' +
  'type = "kimi"\n' +
  'base_url = "https://managed.example.com"\n' +
  'model_source = "oauth-catalog"\n' +
  'custom_headers = { "X-Custom" = "yes" }\n\n' +
  '[providers."managed:kimi-code".oauth]\n' +
  'storage = "file"\n' +
  'key = "oauth/kimi-code"\n';

const SERVICES_TOML =
  '[services.moonshot_search]\n' +
  'base_url = "https://search.example.com/search"\n' +
  'api_key = "sk-search"\n';

const model: LlmModel = { provider: 'test', model: 'test-model', capability: UNKNOWN_CAPABILITY };

function captureTools(): { requester: LlmRequester; seen: ToolDescription[][] } {
  const seen: ToolDescription[][] = [];
  return {
    seen,
    requester: {
      generate: async (_config, content, { onEvent }) => {
        seen.push([...(content.tools ?? [])]);
        onEvent?.({ type: 'llm.streaming.part', part: { type: 'text', text: 'ok' } });
        onEvent?.({
          type: 'llm.streaming.usage',
          usage: { inputOther: 10, output: 5, inputCacheRead: 0, inputCacheCreation: 0 },
        });
        onEvent?.({ type: 'llm.done' });
      },
    },
  };
}

async function openSession(
  toml: string | undefined,
  extra: { home?: string; fetchImpl?: typeof fetch } = {},
): Promise<{ seen: ToolDescription[][]; main: AgentHandle; dispose: () => Promise<void> }> {
  const backend = new MemoryBackend();
  const trees = await Trees.open(backend.trees, {});
  const tree = await trees.tree('sess');
  const stores = await openSessionStores(tree, openBlobs(backend.blobs));
  const { requester, seen } = captureTools();
  const bindLlm = createFeature('test-llm', {
    agent() {
      const agent = useAgent();
      agent.setConfig({ model });
      agent.setRequester(requester);
    },
  });
  const app = createHarness({
    features: [
      createConfig({ persist: fakePersist(toml) }),
      providerCatalog,
      ...(extra.home === undefined ? [] : [createOauth({ home: extra.home })]),
      createWeb({ fetchImpl: extra.fetchImpl }),
      bindLlm,
    ],
  });
  await app.ready();
  const session = await app.create({ sessionId: 'sess', stores });
  const main = await session.create({ agentId: MAIN_AGENT_ID, systemPrompt: 'main-host' });
  return {
    seen,
    main,
    dispose: async () => {
      await app.disposeAsync();
      await stores.dispose();
    },
  };
}

function nextTurnDone(agent: AgentHandle): Promise<void> {
  return new Promise((resolve) => {
    agent.on('turn.done', () => {
      resolve();
    });
  });
}

function toolCall(arguments_: unknown): ToolCall {
  return { type: 'function', id: 'call-1', name: 'WebSearch', arguments: JSON.stringify(arguments_) };
}

describe('web feature', () => {
  it('registers the WebSearch tool only when a provider is resolvable', async () => {
    const without = await openSession(undefined, { fetchImpl: stubSearchFetch(() => new Response()).fetchImpl });
    let done = nextTurnDone(without.main);
    without.main.submit(createUserMessage('hi'));
    await done;
    expect(without.seen[0]?.map((tool) => tool.name)).not.toContain('WebSearch');
    await without.dispose();

    const withServices = await openSession(SERVICES_TOML, {
      fetchImpl: stubSearchFetch(() => new Response()).fetchImpl,
    });
    done = nextTurnDone(withServices.main);
    withServices.main.submit(createUserMessage('hi'));
    await done;
    const tools = withServices.seen[0] ?? [];
    const webSearch = tools.find((tool) => tool.name === 'WebSearch');
    expect(webSearch?.description).toContain('Search the web for information.');
    await withServices.dispose();
  });

  it('prefers the services config over the managed oauth fallback', async () => {
    const home = await setupHome();
    const { calls, fetchImpl } = stubSearchFetch(
      () => new Response(JSON.stringify(SEARCH_RESULTS), { status: 200 }),
    );
    const app = createHarness({
      features: [
        createConfig({ persist: fakePersist(`${MANAGED_PROVIDER_TOML}\n${SERVICES_TOML}`) }),
        providerCatalog,
        createOauth({ home }),
        createWeb({ fetchImpl }),
      ],
    });
    await app.ready();
    const provider = app.resolve(WebSearchRef).getProvider();
    expect(provider).toBeDefined();
    const results = await provider!.search('hello', { toolCallId: 'call-1' });
    expect(results).toHaveLength(2);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe('https://search.example.com/search');
    expect(calls[0]?.headers['Authorization']).toBe('Bearer sk-search');
    expect(calls[0]?.headers['X-Msh-Tool-Call-Id']).toBe('call-1');
    expect(calls[0]?.body).toBe('{"text_query":"hello"}');
    await app.disposeAsync();
  });

  it('falls back to the managed oauth provider with tokens from the oauth facade', async () => {
    const home = await setupHome();
    const { calls, fetchImpl } = stubSearchFetch(
      () => new Response(JSON.stringify(SEARCH_RESULTS), { status: 200 }),
    );
    const app = createHarness({
      features: [
        createConfig({ persist: fakePersist(MANAGED_PROVIDER_TOML) }),
        providerCatalog,
        createOauth({ home }),
        createWeb({ fetchImpl }),
      ],
    });
    await app.ready();
    const provider = app.resolve(WebSearchRef).getProvider();
    expect(provider).toBeDefined();
    await provider!.search('hello');
    expect(calls[0]?.url).toBe('https://managed.example.com/search');
    expect(calls[0]?.headers['Authorization']).toBe('Bearer sk-managed');
    expect(calls[0]?.headers['X-Custom']).toBe('yes');
    await app.disposeAsync();
  });

  it('formats result blocks and the empty-results message', async () => {
    const { calls, fetchImpl } = stubSearchFetch(
      () => new Response(JSON.stringify(SEARCH_RESULTS), { status: 200 }),
    );
    const provider: WebSearchProvider = createMoonshotWebSearchProvider({
      baseUrl: 'https://search.example.com/search',
      apiKey: 'sk-search',
      fetchImpl,
    });
    const results = await provider.search('q');
    expect(results).toEqual([
      { title: 'T1', url: 'https://a.example.com', snippet: 'S1', date: '2026-01-01', siteName: 'SiteA' },
      { title: 'T2', url: 'https://b.example.com', snippet: 'S2' },
    ]);
    expect(calls[0]?.headers['Authorization']).toBe('Bearer sk-search');

    const formatted = formatSearchResults(results);
    expect(formatted).toBe(
      'Title: T1\nSite: SiteA\nDate: 2026-01-01\nURL: https://a.example.com\nSnippet: S1\n\n' +
        '---\n\n' +
        'Title: T2\nURL: https://b.example.com\nSnippet: S2\n\n' +
        'When you rely on a result in your answer, cite it inline as a markdown link, e.g. [title](url).',
    );
    expect(formatSearchResults([])).toBe('No search results found.');

    const tool = createWebSearchTool({ getProvider: () => provider });
    const out = await tool.execute({ toolCall: toolCall({ query: 'q' }), signal: new AbortController().signal });
    expect(out.content[0]).toEqual({ type: 'text', text: formatted });

    const missing = createWebSearchTool({ getProvider: () => undefined });
    const degraded = await missing.execute({
      toolCall: toolCall({ query: 'q' }),
      signal: new AbortController().signal,
    });
    expect(degraded.content[0]).toEqual({ type: 'text', text: WEB_SEARCH_PROVIDER_REMOVED_MESSAGE });
  });

  it('classifies search errors and rethrows when the signal is aborted', async () => {
    const respond = (status: number): WebSearchProvider =>
      createMoonshotWebSearchProvider({
        baseUrl: 'https://search.example.com/search',
        apiKey: 'sk-search',
        fetchImpl: (async () => new Response('detail', { status })) as typeof fetch,
      });
    await expect(respond(401).search('q')).rejects.toThrow('HTTP 401 (auth/unauthorized)');
    await expect(respond(500).search('q')).rejects.toThrow('HTTP 500');

    const failingToken: WebSearchProvider = createMoonshotWebSearchProvider({
      baseUrl: 'https://search.example.com/search',
      tokenProvider: { getAccessToken: () => Promise.reject(new Error('revoked')) },
      apiKey: 'sk-fallback',
      fetchImpl: stubSearchFetch(() => new Response(JSON.stringify({ search_results: [] }), { status: 200 })).fetchImpl,
    });
    await expect(failingToken.search('q')).resolves.toEqual([]);

    const noCredentials = createMoonshotWebSearchProvider({
      baseUrl: 'https://search.example.com/search',
      fetchImpl: stubSearchFetch(() => new Response()).fetchImpl,
    });
    await expect(noCredentials.search('q')).rejects.toThrow('authentication is not configured');

    expect(classifySearchError(Object.assign(new Error('stopped'), { name: 'AbortError' }))).toBe(
      'Search cancelled: stopped',
    );
    expect(classifySearchError(Object.assign(new Error('slow'), { name: 'TimeoutError' }))).toBe(
      'Search timed out: slow',
    );
    expect(classifySearchError(new Error('HTTP 401 (auth/unauthorized)'))).toBe(
      'Search failed (authentication): HTTP 401 (auth/unauthorized)',
    );
    expect(classifySearchError(new TypeError('fetch failed'))).toBe(
      'Search failed (network): fetch failed',
    );
    expect(classifySearchError(new Error('boom'))).toBe('Search failed: boom');

    const broken = createWebSearchTool({
      getProvider: () => ({
        search: () => Promise.reject(new Error('HTTP 500. down')),
      }),
    });
    const out = await broken.execute({
      toolCall: toolCall({ query: 'q' }),
      signal: new AbortController().signal,
    });
    expect(out.content[0]).toEqual({ type: 'text', text: 'Search failed (network): HTTP 500. down' });

    const controller = new AbortController();
    controller.abort();
    await expect(
      broken.execute({ toolCall: toolCall({ query: 'q' }), signal: controller.signal }),
    ).rejects.toThrow('HTTP 500. down');
  });

  it('applies the KIMI_WEB_SEARCH_* env bindings to the moonshot_search entry', async () => {
    const env = {
      KIMI_WEB_SEARCH_BASE_URL: 'https://env.example.com/search',
      KIMI_WEB_SEARCH_API_KEY: 'sk-env',
    };
    const { calls, fetchImpl } = stubSearchFetch(
      () => new Response(JSON.stringify(SEARCH_RESULTS), { status: 200 }),
    );
    const app = createHarness({
      features: [
        createConfig({
          persist: fakePersist(),
          env,
        }),
        providerCatalog,
        createWeb({ fetchImpl }),
      ],
    });
    await app.ready();
    const provider = app.resolve(WebSearchRef).getProvider();
    expect(provider).toBeDefined();
    await provider!.search('hello');
    expect(calls[0]?.url).toBe('https://env.example.com/search');
    expect(calls[0]?.headers['Authorization']).toBe('Bearer sk-env');
    await app.disposeAsync();

    const fileEntry = { baseUrl: 'https://disk.example.com/search', apiKey: 'sk-disk' };
    expect(
      servicesConfigSection.stripEnv?.(
        { moonshot_search: { baseUrl: env.KIMI_WEB_SEARCH_BASE_URL, apiKey: env.KIMI_WEB_SEARCH_API_KEY } },
        { moonshot_search: fileEntry },
        (name) => env[name as keyof typeof env],
      ),
    ).toEqual({ moonshot_search: fileEntry });
    expect(
      servicesConfigSection.stripEnv?.(
        { moonshot_search: fileEntry },
        { moonshot_search: fileEntry },
        () => undefined,
      ),
    ).toEqual({ moonshot_search: fileEntry });
  });

  it('does not inherit persisted credentials when env selects a service endpoint', async () => {
    const env = {
      KIMI_WEB_SEARCH_BASE_URL: 'https://search-env.example.com/search',
      KIMI_WEB_SEARCH_API_KEY: 'env-search-key',
      KIMI_WEB_FETCH_BASE_URL: 'https://fetch-env.example.com/fetch',
      KIMI_WEB_FETCH_API_KEY: 'env-fetch-key',
    };
    const toml =
      '[services.moonshot_search]\n' +
      'base_url = "https://file.example.com/search"\n' +
      'api_key = "file-search-key"\n' +
      'custom_headers = { Authorization = "Bearer configured-search-secret" }\n' +
      '[services.moonshot_search.oauth]\n' +
      'storage = "file"\n' +
      'key = "oauth/search"\n\n' +
      '[services.moonshot_fetch]\n' +
      'base_url = "https://file.example.com/fetch"\n' +
      'api_key = "file-fetch-key"\n' +
      'custom_headers = { Authorization = "Bearer configured-fetch-secret" }\n' +
      '[services.moonshot_fetch.oauth]\n' +
      'storage = "file"\n' +
      'key = "oauth/fetch"\n';
    const app = createHarness({
      features: [
        createConfig({ persist: fakePersist(toml), env }),
        providerCatalog,
        createWeb({ fetchImpl: stubSearchFetch(() => new Response()).fetchImpl }),
      ],
    });
    await app.ready();
    const config = app.resolve(ConfigRef);
    expect(config.get<ServicesSection>(SERVICES_CONFIG_SECTION)).toEqual({
      moonshot_search: { baseUrl: 'https://search-env.example.com/search', apiKey: 'env-search-key' },
      moonshot_fetch: { baseUrl: 'https://fetch-env.example.com/fetch', apiKey: 'env-fetch-key' },
    });
    await app.disposeAsync();
  });

  it('uses an env API key instead of persisted OAuth for a configured endpoint', async () => {
    const env = { KIMI_WEB_SEARCH_API_KEY: 'env-search-key' };
    const toml =
      '[services.moonshot_search]\n' +
      'base_url = "https://file.example.com/search"\n' +
      'custom_headers = { X-Service = "search" }\n' +
      '[services.moonshot_search.oauth]\n' +
      'storage = "file"\n' +
      'key = "oauth/search"\n';
    const app = createHarness({
      features: [
        createConfig({ persist: fakePersist(toml), env }),
        providerCatalog,
        createWeb({ fetchImpl: stubSearchFetch(() => new Response()).fetchImpl }),
      ],
    });
    await app.ready();
    const config = app.resolve(ConfigRef);
    expect(config.get<ServicesSection>(SERVICES_CONFIG_SECTION)?.moonshot_search).toEqual({
      baseUrl: 'https://file.example.com/search',
      apiKey: 'env-search-key',
      customHeaders: { 'X-Service': 'search' },
    });
    await app.disposeAsync();
  });
});

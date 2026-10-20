import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { createFeature } from '@moonshot-ai/agent-core/app/index';
import { createUserEntry } from '@moonshot-ai/agent-core/history/index';
import { useInject, type ShallowRef } from '@moonshot-ai/agent-core/kernel/index';
import {
  createAssistantMessage,
  createUserMessage,
  type ToolCall,
  type ToolDescription,
} from '@moonshot-ai/agent-core/llm/message';
import type { LlmRequest } from '@moonshot-ai/agent-core/llm/request';
import { mergeFields, type LlmRequester } from '@moonshot-ai/agent-core/llm/requester';
import type { LlmOutcome } from '@moonshot-ai/agent-core/llm/response';
import { MAIN_AGENT_ID, type Agent } from '@moonshot-ai/agent-core/session/index';
import { FileTokenStorage } from '@moonshot-ai/kimi-code-oauth';

import { ConfigRef, createConfig, type ConfigPersist, type ConfigStore } from '#/features/config/index';
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
  type WebSearchFace,
  type WebSearchProvider,
} from '#/features/kimi/web/index';
import { providerCatalog } from '#/features/provider-catalog/index';
import {
  createHarness,
  harnessInternals,
  memoryHarnessSpace,
  type Harness,
} from '#/runtime/index';

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

const tick = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

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

type Fields = Record<string, unknown>;

function fakeRequester(next: (rest: Fields) => LlmOutcome | Promise<LlmOutcome>): LlmRequester<'model'> {
  const make = (filled: Fields): LlmRequester<'model'> => ({
    with: (part) => make(mergeFields(filled, part as Fields) ?? {}) as LlmRequester<'model'>,
    request: (rest) => mergeFields(filled, rest as Fields) as unknown as LlmRequest,
    generate: async (rest) => next(mergeFields(filled, rest as Fields) ?? {}),
  });
  return make({});
}

function textOutcome(text: string): LlmOutcome {
  return { type: 'done', message: createAssistantMessage([{ type: 'text', text }]) };
}

async function openSession(
  toml: string | undefined,
  extra: { fetchImpl?: typeof fetch } = {},
): Promise<{ harness: Harness; seen: ToolDescription[][]; main: Agent }> {
  const seen: ToolDescription[][] = [];
  const requester = fakeRequester((rest) => {
    seen.push([...((rest['profile'] as { tools?: ToolDescription[] } | undefined)?.tools ?? [])]);
    return textOutcome('ok');
  });
  const harness = createHarness({ space: memoryHarnessSpace() });
  harness.app.features.add(createConfig({ persist: fakePersist(toml) }));
  harness.app.features.add(providerCatalog);
  harness.app.features.add(createWeb({ fetchImpl: extra.fetchImpl }));
  await tick();
  const session = await harness.app.create({ sessionId: 'sess' });
  const main = await harness.ensureAgent(session, MAIN_AGENT_ID, { systemPrompt: 'main-host' });
  const runtime = harnessInternals(harness.app).agents.get(session)?.get(MAIN_AGENT_ID);
  if (runtime === undefined) throw new Error('agent runtime not found');
  runtime.requester = requester;
  return { harness, seen, main };
}

async function mountWebApp(options: {
  toml?: string;
  env?: Record<string, string>;
  home?: string;
  fetchImpl?: typeof fetch;
}): Promise<{ harness: Harness; face: WebSearchFace; config: ConfigStore }> {
  const capture: {
    web?: Readonly<ShallowRef<WebSearchFace | undefined>>;
    config?: Readonly<ShallowRef<ConfigStore | undefined>>;
  } = {};
  const harness = createHarness({ space: memoryHarnessSpace() });
  harness.app.features.add(createConfig({ persist: fakePersist(options.toml), env: options.env }));
  harness.app.features.add(providerCatalog);
  if (options.home !== undefined) harness.app.features.add(createOauth({ home: options.home }));
  harness.app.features.add(createWeb({ fetchImpl: options.fetchImpl }));
  harness.app.features.add(
    createFeature('probe', {
      app() {
        capture.web = useInject(WebSearchRef);
        capture.config = useInject(ConfigRef);
      },
    }),
  );
  await tick();
  const face = capture.web?.value;
  const config = capture.config?.value;
  if (face === undefined || config === undefined) {
    throw new Error('web search or config face was not exposed');
  }
  return { harness, face, config };
}

function toolCall(arguments_: unknown): ToolCall {
  return { type: 'function', id: 'call-1', name: 'WebSearch', arguments: JSON.stringify(arguments_) };
}

describe('web feature', () => {
  it('registers the WebSearch tool only when a provider is resolvable', async () => {
    const without = await openSession(undefined, {
      fetchImpl: stubSearchFetch(() => new Response()).fetchImpl,
    });
    let outcome = await without.main.loop.runTurn(
      createUserEntry(createUserMessage('hi'), { origin: { kind: 'user' } }),
    );
    expect(outcome.type).toBe('done');
    expect(without.seen[0]?.map((tool) => tool.name)).not.toContain('WebSearch');
    await without.harness.close();

    const withServices = await openSession(SERVICES_TOML, {
      fetchImpl: stubSearchFetch(() => new Response()).fetchImpl,
    });
    outcome = await withServices.main.loop.runTurn(
      createUserEntry(createUserMessage('hi'), { origin: { kind: 'user' } }),
    );
    expect(outcome.type).toBe('done');
    const tools = withServices.seen[0] ?? [];
    const webSearch = tools.find((tool) => tool.name === 'WebSearch');
    expect(webSearch?.description).toContain('Search the web for information.');
    await withServices.harness.close();
  });

  it('prefers the services config over the managed oauth fallback', async () => {
    const home = await setupHome();
    const { calls, fetchImpl } = stubSearchFetch(
      () => new Response(JSON.stringify(SEARCH_RESULTS), { status: 200 }),
    );
    const { harness, face } = await mountWebApp({
      toml: `${MANAGED_PROVIDER_TOML}\n${SERVICES_TOML}`,
      home,
      fetchImpl,
    });
    const provider = face.getProvider();
    expect(provider).toBeDefined();
    const results = await provider!.search('hello', { toolCallId: 'call-1' });
    expect(results).toHaveLength(2);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe('https://search.example.com/search');
    expect(calls[0]?.headers['Authorization']).toBe('Bearer sk-search');
    expect(calls[0]?.headers['X-Msh-Tool-Call-Id']).toBe('call-1');
    expect(calls[0]?.body).toBe('{"text_query":"hello"}');
    await harness.close();
  });

  it('falls back to the managed oauth provider with tokens from the oauth facade', async () => {
    const home = await setupHome();
    const { calls, fetchImpl } = stubSearchFetch(
      () => new Response(JSON.stringify(SEARCH_RESULTS), { status: 200 }),
    );
    const { harness, face } = await mountWebApp({ toml: MANAGED_PROVIDER_TOML, home, fetchImpl });
    const provider = face.getProvider();
    expect(provider).toBeDefined();
    await provider!.search('hello');
    expect(calls[0]?.url).toBe('https://managed.example.com/search');
    expect(calls[0]?.headers['Authorization']).toBe('Bearer sk-managed');
    expect(calls[0]?.headers['X-Custom']).toBe('yes');
    await harness.close();
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
    const { harness, face } = await mountWebApp({ env, fetchImpl });
    const provider = face.getProvider();
    expect(provider).toBeDefined();
    await provider!.search('hello');
    expect(calls[0]?.url).toBe('https://env.example.com/search');
    expect(calls[0]?.headers['Authorization']).toBe('Bearer sk-env');
    await harness.close();

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
    const { harness, config } = await mountWebApp({
      toml,
      env,
      fetchImpl: stubSearchFetch(() => new Response()).fetchImpl,
    });
    expect(config.get<ServicesSection>(SERVICES_CONFIG_SECTION)).toEqual({
      moonshot_search: { baseUrl: 'https://search-env.example.com/search', apiKey: 'env-search-key' },
      moonshot_fetch: { baseUrl: 'https://fetch-env.example.com/fetch', apiKey: 'env-fetch-key' },
    });
    await harness.close();
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
    const { harness, config } = await mountWebApp({
      toml,
      env,
      fetchImpl: stubSearchFetch(() => new Response()).fetchImpl,
    });
    expect(config.get<ServicesSection>(SERVICES_CONFIG_SECTION)?.moonshot_search).toEqual({
      baseUrl: 'https://file.example.com/search',
      apiKey: 'env-search-key',
      customHeaders: { 'X-Service': 'search' },
    });
    await harness.close();
  });
});

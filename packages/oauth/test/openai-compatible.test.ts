import { afterEach, describe, expect, it, vi } from 'vitest';

import type { ManagedKimiConfigShape, ManagedKimiOAuthRef } from '../src/managed-kimi-code';
import {
  fetchOpenAIProviderModels,
  type FetchOpenAIProviderModelsOptions,
} from '../src/openai-compatible';
import { refreshProviderModels, type RefreshProviderHost } from '../src/refreshProviderModels';

type FetchMock = (
  input: Parameters<typeof fetch>[0],
  init?: Parameters<typeof fetch>[1],
) => Promise<Response>;

function makeRefreshHost(initial: ManagedKimiConfigShape): RefreshProviderHost {
  let persisted = structuredClone(initial) as ManagedKimiConfigShape;
  return {
    getConfig: async () => structuredClone(persisted),
    removeProvider: async (providerId: string) => {
      const providers = { ...persisted.providers };
      delete providers[providerId];
      const models = { ...(persisted.models ?? {}) };
      for (const [alias, model] of Object.entries(models)) {
        if ((model as { provider?: string }).provider === providerId) delete models[alias];
      }
      persisted = { ...persisted, providers, models };
      return structuredClone(persisted);
    },
    setConfig: async (patch: ManagedKimiConfigShape) => {
      persisted = { ...persisted, ...patch };
      return structuredClone(persisted);
    },
    resolveOAuthToken: async (_name: string, _ref?: ManagedKimiOAuthRef) => 'token',
  };
}

function fetchInputUrl(input: Parameters<typeof fetch>[0]): string {
  if (typeof input === 'string') return input;
  if (input instanceof URL) return input.href;
  return input.url;
}

describe('fetchOpenAIProviderModels', () => {
  it('normalizes an OpenAI /models payload into model infos', async () => {
    const fetchMock = vi.fn<FetchMock>(async () =>
      new Response(
        JSON.stringify({ data: [{ id: 'gpt-4o' }, { id: 'gpt-4o-mini', object: 'model' }] }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      ),
    );
    vi.stubGlobal('fetch', fetchMock);

    const models = await fetchOpenAIProviderModels('https://api.example.test/v1', 'sk-test', {});

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(fetchInputUrl(url)).toBe('https://api.example.test/v1/models');
    expect(new Headers(init?.headers).get('authorization')).toBe('Bearer sk-test');
    expect(models.map((m) => m.id)).toEqual(['gpt-4o', 'gpt-4o-mini']);
    expect(models[0]?.contextLength).toBeGreaterThan(0);
  });

  it('throws on a non-OK response', async () => {
    const fetchMock = vi.fn<FetchMock>(async () =>
      new Response('boom', { status: 500 }),
    );
    vi.stubGlobal('fetch', fetchMock);

    await expect(
      fetchOpenAIProviderModels('https://api.example.test/v1', 'sk-test', {}),
    ).rejects.toThrow(/HTTP 500/);
  });

  it('throws on a malformed payload', async () => {
    const fetchMock = vi.fn<FetchMock>(async () =>
      new Response(JSON.stringify({ not: 'data' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    );
    vi.stubGlobal('fetch', fetchMock);

    await expect(
      fetchOpenAIProviderModels('https://api.example.test/v1', 'sk-test', {}),
    ).rejects.toThrow(/expected \{ data/);
  });

  it('passes a custom fetch impl through options', async () => {
    const fetchMock = vi.fn<FetchMock>(async () =>
      new Response(JSON.stringify({ data: [{ id: 'm1' }] }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    );
    const options: FetchOpenAIProviderModelsOptions = { fetchImpl: fetchMock };
    const models = await fetchOpenAIProviderModels('https://api.example.test/v1', 'sk-test', options);
    expect(models.map((m) => m.id)).toEqual(['m1']);
  });

  it('uses the provider-supplied context_length when present', async () => {
    const fetchMock = vi.fn<FetchMock>(async () =>
      new Response(
        JSON.stringify({ data: [{ id: 'minimax/minimax-m3:free', context_length: 1048576 }] }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      ),
    );
    vi.stubGlobal('fetch', fetchMock);

    const models = await fetchOpenAIProviderModels('https://api.example.test/v1', 'sk-test', {});

    expect(models).toHaveLength(1);
    expect(models[0]?.id).toBe('minimax/minimax-m3:free');
    expect(models[0]?.contextLength).toBe(1048576);
  });

  it('falls back to the default when context_length is absent', async () => {
    const fetchMock = vi.fn<FetchMock>(async () =>
      new Response(
        JSON.stringify({ data: [{ id: 'm1' }] }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      ),
    );
    vi.stubGlobal('fetch', fetchMock);

    const models = await fetchOpenAIProviderModels('https://api.example.test/v1', 'sk-test', {});

    expect(models[0]?.contextLength).toBe(131072);
  });

  it('prefers context_length over context_window', async () => {
    const fetchMock = vi.fn<FetchMock>(async () =>
      new Response(
        JSON.stringify({ data: [{ id: 'm1', context_window: 200000, context_length: 1048576 }] }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      ),
    );
    vi.stubGlobal('fetch', fetchMock);

    const models = await fetchOpenAIProviderModels('https://api.example.test/v1', 'sk-test', {});

    expect(models[0]?.contextLength).toBe(1048576);
  });

  it('falls back to the default for non-positive context lengths', async () => {
    const fetchMock = vi.fn<FetchMock>(async () =>
      new Response(
        JSON.stringify({ data: [{ id: 'm1', context_length: 0 }] }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      ),
    );
    vi.stubGlobal('fetch', fetchMock);

    const models = await fetchOpenAIProviderModels('https://api.example.test/v1', 'sk-test', {});

    expect(models[0]?.contextLength).toBe(131072);
  });
});

describe('refreshProviderModels — OpenAI-compatible branch (3.5)', () => {
  const baseUrl = 'https://opencode.ai/zen/v1';

  it('refreshes a plain openai provider from its /models endpoint', async () => {
    const config: ManagedKimiConfigShape = {
      providers: {
        opencode: {
          type: 'openai',
          baseUrl,
          apiKey: 'sk-test-token',
        },
      },
      models: {
        'opencode/old-model': {
          provider: 'opencode',
          model: 'old-model',
          maxContextSize: 131072,
          capabilities: ['tool_use'],
          displayName: 'Old',
        },
      },
      telemetry: true,
    };
    const host = makeRefreshHost(config);
    const fetchMock = vi.fn<FetchMock>(async (input, init) => {
      expect(fetchInputUrl(input)).toBe(`${baseUrl}/models`);
      expect(new Headers(init?.headers).get('authorization')).toBe('Bearer sk-test-token');
      return new Response(
        JSON.stringify({ data: [{ id: 'new-model' }] }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      );
    });
    vi.stubGlobal('fetch', fetchMock);

    const result = await refreshProviderModels(host, { scope: 'all' });

    expect(result.failed).toEqual([]);
    expect(result.unchanged).toEqual([]);
    expect(result.changed).toEqual([
      { providerId: 'opencode', providerName: 'opencode', added: 1, removed: 1 },
    ]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    // Stale model removed, new model added under the provider prefix.
    const models = (await host.getConfig()).models ?? {};
    expect(models['opencode/old-model']).toBeUndefined();
    expect(models['opencode/new-model']).toBeDefined();
  });

  it('reports a failed fetch in the failed list instead of skipping silently', async () => {
    const config: ManagedKimiConfigShape = {
      providers: {
        kilo: {
          type: 'openai',
          baseUrl: 'https://api.kilo.ai/api/gateway',
          apiKey: 'kilo-token',
        },
      },
      telemetry: true,
    };
    const host = makeRefreshHost(config);
    const fetchMock = vi.fn<FetchMock>(async () => new Response('nope', { status: 500 }));
    vi.stubGlobal('fetch', fetchMock);

    const result = await refreshProviderModels(host, { scope: 'all' });

    expect(result.changed).toEqual([]);
    expect(result.unchanged).toEqual([]);
    expect(result.failed).toEqual([
      { provider: 'kilo', reason: expect.stringContaining('HTTP 500') },
    ]);
  });

  it('does not refresh an openai provider that has a custom-registry source (branch 3 owns it)', async () => {
    const config: ManagedKimiConfigShape = {
      providers: {
        github: {
          type: 'openai',
          baseUrl: 'https://ghcopilot.example.test/v1',
          apiKey: 'gh-token',
          source: { kind: 'apiJson', url: 'http://localhost:4141', apiKey: 'gh-token' },
        },
      },
      telemetry: true,
    };
    const host = makeRefreshHost(config);
    const fetchMock = vi.fn<FetchMock>(async () => new Response('[]', { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    const result = await refreshProviderModels(host, { scope: 'all' });

    // Branch 3 (custom registry) legitimately fetches the registry URL; branch
    // 3.5 must NOT also hit the provider's own /models endpoint.
    const openAiBaseUrlHits = fetchMock.mock.calls.filter(
      (call) => fetchInputUrl(call[0]).includes('ghcopilot.example.test'),
    );
    expect(openAiBaseUrlHits).toHaveLength(0);
  });

  it('scoped refresh only touches the targeted openai provider', async () => {
    const config: ManagedKimiConfigShape = {
      providers: {
        opencode: { type: 'openai', baseUrl: 'https://opencode.ai/zen/v1', apiKey: 'sk-oc' },
        kilo: { type: 'openai', baseUrl: 'https://api.kilo.ai/api/gateway', apiKey: 'sk-kilo' },
      },
      telemetry: true,
    };
    const host = makeRefreshHost(config);
    let calls = 0;
    const fetchMock = vi.fn<FetchMock>(async (input) => {
      calls += 1;
      expect(fetchInputUrl(input)).toContain('opencode.ai');
      return new Response(JSON.stringify({ data: [{ id: 'm' }] }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    });
    vi.stubGlobal('fetch', fetchMock);

    const result = await refreshProviderModels(host, { scope: 'all', providerId: 'opencode' });

    expect(calls).toBe(1);
    expect(result.changed.map((c) => c.providerId)).toEqual(['opencode']);
  });

  it('refreshes an openai_responses provider from its /models endpoint', async () => {
    const config: ManagedKimiConfigShape = {
      providers: {
        opencode: {
          type: 'openai_responses',
          baseUrl,
          apiKey: 'sk-test-token',
        },
      },
      telemetry: true,
    };
    const host = makeRefreshHost(config);
    const fetchMock = vi.fn<FetchMock>(async (input, init) => {
      expect(fetchInputUrl(input)).toBe(`${baseUrl}/models`);
      expect(new Headers(init?.headers).get('authorization')).toBe('Bearer sk-test-token');
      return new Response(
        JSON.stringify({ data: [{ id: 'oai-resp-model' }] }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      );
    });
    vi.stubGlobal('fetch', fetchMock);

    const result = await refreshProviderModels(host, { scope: 'all' });

    expect(result.failed).toEqual([]);
    expect(result.changed).toEqual([
      { providerId: 'opencode', providerName: 'opencode', added: 1, removed: 0 },
    ]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('resolves a named apiKey via activeApiKeyId', async () => {
    const config: ManagedKimiConfigShape = {
      providers: {
        kilo: {
          type: 'openai',
          baseUrl: 'https://api.kilo.ai/api/gateway',
          apiKeys: { kilo1: { key: 'kilo-named-key', name: 'kilo1' } },
          activeApiKeyId: 'kilo1',
        },
      },
      telemetry: true,
    };
    const host = makeRefreshHost(config);
    const fetchMock = vi.fn<FetchMock>(async (input, init) => {
      expect(fetchInputUrl(input)).toBe('https://api.kilo.ai/api/gateway/models');
      expect(new Headers(init?.headers).get('authorization')).toBe('Bearer kilo-named-key');
      return new Response(
        JSON.stringify({ data: [{ id: 'kilo-model' }] }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      );
    });
    vi.stubGlobal('fetch', fetchMock);

    const result = await refreshProviderModels(host, { scope: 'all' });

    expect(result.failed).toEqual([]);
    expect(result.changed).toEqual([
      { providerId: 'kilo', providerName: 'kilo', added: 1, removed: 0 },
    ]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('falls back to env.KIMI_API_KEY when no inline key is set', async () => {
    const config: ManagedKimiConfigShape = {
      providers: {
        opencode: {
          type: 'openai',
          baseUrl,
          env: { KIMI_API_KEY: 'sk-env-key' },
        },
      },
      telemetry: true,
    };
    const host = makeRefreshHost(config);
    const fetchMock = vi.fn<FetchMock>(async (input, init) => {
      expect(fetchInputUrl(input)).toBe(`${baseUrl}/models`);
      expect(new Headers(init?.headers).get('authorization')).toBe('Bearer sk-env-key');
      return new Response(
        JSON.stringify({ data: [{ id: 'env-model' }] }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      );
    });
    vi.stubGlobal('fetch', fetchMock);

    const result = await refreshProviderModels(host, { scope: 'all' });

    expect(result.failed).toEqual([]);
    expect(result.changed).toEqual([
      { providerId: 'opencode', providerName: 'opencode', added: 1, removed: 0 },
    ]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('carries an OpenRouter context_length through to the model maxContextSize', async () => {
    const config: ManagedKimiConfigShape = {
      providers: {
        openrouter: {
          type: 'openai',
          baseUrl: 'https://openrouter.ai/api/v1',
          apiKey: 'sk-or-test',
        },
      },
      telemetry: true,
    };
    const host = makeRefreshHost(config);
    const fetchMock = vi.fn<FetchMock>(async (input, init) => {
      expect(fetchInputUrl(input)).toBe('https://openrouter.ai/api/v1/models');
      expect(new Headers(init?.headers).get('authorization')).toBe('Bearer sk-or-test');
      return new Response(
        JSON.stringify({
          data: [{ id: 'minimax/minimax-m3:free', context_length: 1048576 }],
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      );
    });
    vi.stubGlobal('fetch', fetchMock);

    const result = await refreshProviderModels(host, { scope: 'all' });

    expect(result.failed).toEqual([]);
    expect(result.changed).toEqual([
      { providerId: 'openrouter', providerName: 'openrouter', added: 1, removed: 0 },
    ]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const models = Object.values((await host.getConfig()).models ?? {});
    const carried = models.find((m) => m.maxContextSize === 1048576);
    expect(carried).toBeDefined();
    expect(carried?.provider).toBe('openrouter');
    expect(carried?.model).toBe('minimax/minimax-m3:free');
  });
});

import { describe, expect, it, vi } from 'vitest';
import { DaemonKimiWebApi } from '../src/api/daemon/client';
import { DaemonApiError, DaemonNetworkError } from '../src/api/errors';

const identity = {
  clientId: 'web_t',
  clientName: 't',
  clientVersion: '0',
  clientUiMode: 'web',
};

function makeApi() {
  return new DaemonKimiWebApi({
    origin: 'http://test.local',
    identity,
    projectorFactory: () => {
      throw new Error('projector not needed for REST-only tests');
    },
  });
}

function envelope(data: unknown, status = 200): Response {
  return new Response(JSON.stringify({ code: 0, msg: '', data, request_id: 'req_t' }), { status });
}

const wireProvider = {
  id: 'my-openai',
  type: 'openai',
  base_url: 'https://api.openai.com/v1',
  has_api_key: true,
  status: 'connected',
  models: ['my-openai/gpt-4.1'],
};

describe('DaemonKimiWebApi.getProvider', () => {
  it('GETs the single provider and maps the revealed api_key', async () => {
    const fetchMock = vi.fn().mockResolvedValue(envelope({ ...wireProvider, api_key: 'sk-real' }));
    vi.stubGlobal('fetch', fetchMock);

    const result = await makeApi().getProvider('my-openai');

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('http://test.local/api/v1/providers/my-openai');
    expect(init.method).toBe('GET');
    expect(result.apiKey).toBe('sk-real');
    expect(result.hasApiKey).toBe(true);
  });

  it('leaves apiKey undefined when the provider has none stored', async () => {
    const { api_key: _omit, ...noKey } = { ...wireProvider, api_key: undefined };
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(envelope(noKey)));

    const result = await makeApi().getProvider('my-openai');
    expect(result).not.toHaveProperty('apiKey');
  });

  it('throws DaemonApiError carrying 40412 for an unknown provider', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ code: 40412, msg: 'provider not found', data: null, request_id: 'req_t' }), { status: 200 }),
    );
    vi.stubGlobal('fetch', fetchMock);

    await expect(makeApi().getProvider('nope')).rejects.toMatchObject({ code: 40412 });
  });
});

describe('DaemonKimiWebApi.addProvider', () => {
  it('POSTs the snake_case create body and maps the ProviderCatalogItem', async () => {
    const fetchMock = vi.fn().mockResolvedValue(envelope(wireProvider, 201));
    vi.stubGlobal('fetch', fetchMock);

    const result = await makeApi().addProvider({
      id: 'my-openai',
      type: 'openai',
      apiKey: 'sk-test',
      baseUrl: 'https://api.openai.com/v1',
      defaultModel: 'gpt-4.1',
      models: [
        { model: 'gpt-4.1', maxContextSize: 1047576, displayName: 'GPT-4.1', maxOutputSize: 32768 },
        { model: 'gpt-4.1-mini', maxContextSize: 1047576 },
      ],
    });

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('http://test.local/api/v1/providers');
    expect(init.method).toBe('POST');
    expect(JSON.parse(init.body as string)).toEqual({
      id: 'my-openai',
      type: 'openai',
      api_key: 'sk-test',
      base_url: 'https://api.openai.com/v1',
      default_model: 'gpt-4.1',
      models: [
        { model: 'gpt-4.1', max_context_size: 1047576, display_name: 'GPT-4.1', max_output_size: 32768 },
        { model: 'gpt-4.1-mini', max_context_size: 1047576 },
      ],
    });
    expect(result).toEqual({
      id: 'my-openai',
      type: 'openai',
      baseUrl: 'https://api.openai.com/v1',
      defaultModel: undefined,
      hasApiKey: true,
      status: 'connected',
      models: ['my-openai/gpt-4.1'],
    });
  });

  it('omits blank optionals (api_key / base_url / default_model)', async () => {
    const fetchMock = vi.fn().mockResolvedValue(envelope(wireProvider, 201));
    vi.stubGlobal('fetch', fetchMock);

    await makeApi().addProvider({
      id: 'my-openai',
      type: 'openai',
      models: [{ model: 'gpt-4.1', maxContextSize: 1047576 }],
    });

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(init.body as string) as Record<string, unknown>;
    expect(body).not.toHaveProperty('api_key');
    expect(body).not.toHaveProperty('base_url');
    expect(body).not.toHaveProperty('default_model');
  });

  it('throws DaemonApiError carrying the 40921 code on a conflict envelope', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ code: 40921, msg: 'provider already exists', data: null, request_id: 'req_t' }), { status: 200 }),
    );
    vi.stubGlobal('fetch', fetchMock);

    await expect(
      makeApi().addProvider({
        id: 'my-openai',
        type: 'openai',
        models: [{ model: 'gpt-4.1', maxContextSize: 1047576 }],
      }),
    ).rejects.toMatchObject({ code: 40921 });
  });
});

describe('DaemonKimiWebApi.updateProvider', () => {
  it('PUTs the snake_case replace body and maps { provider }', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      envelope({ provider: wireProvider }),
    );
    vi.stubGlobal('fetch', fetchMock);

    const result = await makeApi().updateProvider('my-openai', {
      type: 'openai',
      apiKey: 'sk-new',
      baseUrl: 'https://api.openai.com/v1',
      defaultModel: 'gpt-4.1',
      models: [
        { model: 'gpt-4.1', maxContextSize: 1047576, displayName: 'GPT-4.1', maxOutputSize: 32768 },
        { model: 'gpt-4.1-mini', maxContextSize: 1047576 },
      ],
    });

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('http://test.local/api/v1/providers/my-openai');
    expect(init.method).toBe('PUT');
    expect(JSON.parse(init.body as string)).toEqual({
      type: 'openai',
      api_key: 'sk-new',
      base_url: 'https://api.openai.com/v1',
      default_model: 'gpt-4.1',
      models: [
        { model: 'gpt-4.1', max_context_size: 1047576, display_name: 'GPT-4.1', max_output_size: 32768 },
        { model: 'gpt-4.1-mini', max_context_size: 1047576 },
      ],
    });
    expect(result).toEqual({
      provider: {
        id: 'my-openai',
        type: 'openai',
        baseUrl: 'https://api.openai.com/v1',
        defaultModel: undefined,
        hasApiKey: true,
        status: 'connected',
        models: ['my-openai/gpt-4.1'],
      },
    });
  });

  it('passes api_key through three-state: keep (undefined) / clear ("") / set', async () => {
    const fetchMock = vi.fn().mockImplementation(() =>
      Promise.resolve(envelope({ provider: wireProvider })),
    );
    vi.stubGlobal('fetch', fetchMock);

    const models = [{ model: 'gpt-4.1', maxContextSize: 1047576 }];
    await makeApi().updateProvider('my-openai', { type: 'openai', models });
    await makeApi().updateProvider('my-openai', { type: 'openai', apiKey: '', models });
    await makeApi().updateProvider('my-openai', { type: 'openai', apiKey: 'sk-x', models });

    const bodies = fetchMock.mock.calls.map(
      (call) => JSON.parse((call[1] as RequestInit).body as string) as Record<string, unknown>,
    );
    expect(bodies[0]).not.toHaveProperty('api_key');
    expect(bodies[1]?.['api_key']).toBe('');
    expect(bodies[2]?.['api_key']).toBe('sk-x');
    // Replace semantics: untouched optionals are simply absent from the body.
    expect(bodies[0]).not.toHaveProperty('base_url');
    expect(bodies[0]).not.toHaveProperty('default_model');
  });

  it('encodes the provider id in the path', async () => {
    const fetchMock = vi.fn().mockResolvedValue(envelope({ provider: wireProvider }));
    vi.stubGlobal('fetch', fetchMock);

    await makeApi().updateProvider('managed:kimi-code', {
      type: 'kimi',
      models: [{ model: 'kimi-for-coding', maxContextSize: 262144 }],
    });

    const [url] = fetchMock.mock.calls[0] as [string];
    expect(url).toBe('http://test.local/api/v1/providers/managed%3Akimi-code');
  });

  it('throws DaemonApiError on a 40412 (unknown provider) envelope', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ code: 40412, msg: 'provider not found', data: null, request_id: 'req_t' }), { status: 200 }),
    );
    vi.stubGlobal('fetch', fetchMock);

    await expect(
      makeApi().updateProvider('nope', {
        type: 'openai',
        models: [{ model: 'gpt-4.1', maxContextSize: 1047576 }],
      }),
    ).rejects.toBeInstanceOf(DaemonApiError);
  });
});

describe('DaemonKimiWebApi.deleteProvider', () => {
  it('treats a bare 204 (empty body) as a plain delete', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 204 }));
    vi.stubGlobal('fetch', fetchMock);

    const result = await makeApi().deleteProvider('my-openai');

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('http://test.local/api/v1/providers/my-openai');
    expect(init.method).toBe('DELETE');
    expect(result).toEqual({ deleted: 'my-openai' });
  });

  it('encodes the provider id in the path', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 204 }));
    vi.stubGlobal('fetch', fetchMock);

    await makeApi().deleteProvider('managed:kimi-code');

    const [url] = fetchMock.mock.calls[0] as [string];
    expect(url).toBe('http://test.local/api/v1/providers/managed%3Akimi-code');
  });

  it('throws DaemonApiError on an error envelope (e.g. 40003 managed OAuth)', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ code: 40003, msg: 'managed by OAuth', data: null, request_id: 'req_t' }), { status: 200 }),
    );
    vi.stubGlobal('fetch', fetchMock);

    await expect(makeApi().deleteProvider('managed:kimi-code')).rejects.toMatchObject({
      code: 40003,
    });
  });
});

describe('DaemonHttpClient envelope parsing (via deleteProvider)', () => {
  it('rejects a non-204 empty body instead of forging a success', async () => {
    // A bare 500 from a proxy has no envelope — this must surface as an error,
    // not as a fabricated code:0 success (regression guard).
    const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 500 }));
    vi.stubGlobal('fetch', fetchMock);

    await expect(makeApi().deleteProvider('my-openai')).rejects.toBeInstanceOf(
      DaemonNetworkError,
    );
  });

  it('rejects a 200 with an empty body (truncated response)', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    await expect(makeApi().deleteProvider('my-openai')).rejects.toBeInstanceOf(
      DaemonNetworkError,
    );
  });
});


const wireCatalogProvider = {
  id: 'openai',
  name: 'OpenAI',
  wire_type: 'openai',
  guessed: false,
  needs_base_url: false,
  rejected: false,
  reject_reason: null,
  env_key: 'OPENAI_API_KEY',
  models: [
    {
      id: 'gpt-4.1',
      name: 'GPT-4.1',
      max_context_size: 1047576,
      capabilities: ['image_in', 'tool_use'],
      reasoning: false,
    },
    { id: 'gpt-4o-mini', max_context_size: 128000, reasoning: false },
  ],
};

describe('DaemonKimiWebApi.listCatalogProviders', () => {
  it('GETs the directory and maps the pruned items', async () => {
    const fetchMock = vi.fn().mockResolvedValue(envelope({ items: [wireCatalogProvider] }));
    vi.stubGlobal('fetch', fetchMock);

    const result = await makeApi().listCatalogProviders();

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('http://test.local/api/v1/catalog/providers');
    expect(init.method).toBe('GET');
    expect(result).toEqual([
      {
        id: 'openai',
        name: 'OpenAI',
        wireType: 'openai',
        guessed: false,
        needsBaseUrl: false,
        rejected: false,
        rejectReason: null,
        envKey: 'OPENAI_API_KEY',
        models: [
          {
            id: 'gpt-4.1',
            name: 'GPT-4.1',
            maxContextSize: 1047576,
            capabilities: ['image_in', 'tool_use'],
            reasoning: false,
          },
          { id: 'gpt-4o-mini', name: undefined, maxContextSize: 128000, capabilities: undefined, reasoning: false },
        ],
      },
    ]);
  });
});

describe('DaemonKimiWebApi.getCatalogProvider', () => {
  it('GETs one entry and encodes the catalog id', async () => {
    const fetchMock = vi.fn().mockResolvedValue(envelope(wireCatalogProvider));
    vi.stubGlobal('fetch', fetchMock);

    const result = await makeApi().getCatalogProvider('openai');

    const [url] = fetchMock.mock.calls[0] as [string];
    expect(url).toBe('http://test.local/api/v1/catalog/providers/openai');
    expect(result.id).toBe('openai');
    expect(result.models).toHaveLength(2);
  });

  it('throws DaemonApiError carrying 40416 for an unknown catalog id', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ code: 40416, msg: 'catalog entry does not exist', data: null, request_id: 'req_t' }), { status: 200 }),
    );
    vi.stubGlobal('fetch', fetchMock);

    await expect(makeApi().getCatalogProvider('nope')).rejects.toMatchObject({ code: 40416 });
  });

  it('throws DaemonApiError carrying 50004 when the catalog is unavailable', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ code: 50004, msg: 'catalog unavailable', data: null, request_id: 'req_t' }), { status: 200 }),
    );
    vi.stubGlobal('fetch', fetchMock);

    await expect(makeApi().listCatalogProviders()).rejects.toMatchObject({ code: 50004 });
  });
});

describe('DaemonKimiWebApi.importCatalogProvider', () => {
  it('POSTs the snake_case import body and maps the 201 result', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(envelope({ provider: wireProvider, models_imported: 2 }, 201));
    vi.stubGlobal('fetch', fetchMock);

    const result = await makeApi().importCatalogProvider({
      catalogId: 'openai',
      apiKey: 'sk-test',
      baseUrl: 'https://proxy.example/v1',
      id: 'my-oai',
    });

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('http://test.local/api/v1/providers:import_catalog');
    expect(init.method).toBe('POST');
    expect(JSON.parse(init.body as string)).toEqual({
      catalog_id: 'openai',
      api_key: 'sk-test',
      base_url: 'https://proxy.example/v1',
      id: 'my-oai',
    });
    expect(result.provider.id).toBe('my-openai');
    expect(result.modelsImported).toBe(2);
  });

  it('omits blank optionals (api_key / base_url / id)', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(envelope({ provider: wireProvider, models_imported: 2 }, 201));
    vi.stubGlobal('fetch', fetchMock);

    await makeApi().importCatalogProvider({ catalogId: 'openai' });

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(JSON.parse(init.body as string)).toEqual({ catalog_id: 'openai' });
  });
});


describe('DaemonKimiWebApi.importCustomRegistry', () => {
  it('POSTs the snake_case registry body and maps the 201 result', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      envelope({ providers: [wireProvider], models_imported: 2 }, 201),
    );
    vi.stubGlobal('fetch', fetchMock);

    const result = await makeApi().importCustomRegistry({
      url: 'https://internal.example/api.json',
      apiKey: 'tok-1',
    });

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('http://test.local/api/v1/providers:import_registry');
    expect(init.method).toBe('POST');
    expect(JSON.parse(init.body as string)).toEqual({
      url: 'https://internal.example/api.json',
      api_key: 'tok-1',
    });
    expect(result.providers).toHaveLength(1);
    expect(result.providers[0]?.id).toBe('my-openai');
    expect(result.modelsImported).toBe(2);
  });

  it('omits a blank api_key', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      envelope({ providers: [wireProvider], models_imported: 2 }, 201),
    );
    vi.stubGlobal('fetch', fetchMock);

    await makeApi().importCustomRegistry({ url: 'https://internal.example/api.json' });

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(JSON.parse(init.body as string)).toEqual({ url: 'https://internal.example/api.json' });
  });
});

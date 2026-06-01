import { describe, expect, it, vi } from 'vitest';

import {
  applyCustomRegistryProvider,
  CUSTOM_REGISTRY_DEFAULT_CAPABILITIES,
  CUSTOM_REGISTRY_DEFAULT_MAX_CONTEXT,
  capabilitiesFromCustomEntry,
  CustomRegistryApiError,
  fetchCustomRegistry,
  removeCustomRegistryProvider,
  type CustomRegistryProviderEntry,
  type CustomRegistrySource,
  type ManagedKimiConfigShape,
} from '../src/custom-registry';

function makeKokubResponseBody(): Record<string, CustomRegistryProviderEntry> {
  return {
    'registry_chat-completions': {
      id: 'registry_chat-completions',
      name: 'Sample Registry (chat completions)',
      api: 'https://registry.example.test/v1',
      type: 'openai',
      models: {
        'gpt-5.5': { id: 'gpt-5.5', name: 'GPT 5.5' },
        'claude-opus-4-7': { id: 'claude-opus-4-7', name: 'Claude Opus 4.7' },
      },
    },
    'registry_messages': {
      id: 'registry_messages',
      name: 'Sample Registry (messages)',
      api: 'https://registry.example.test',
      type: 'anthropic',
      models: {
        'claude-opus-4-7': { id: 'claude-opus-4-7', name: 'Claude Opus 4.7' },
      },
    },
    'registry_responses': {
      id: 'registry_responses',
      name: 'Sample Registry (responses)',
      api: 'https://registry.example.test/v1',
      type: 'openai_responses',
      models: {
        'gpt-5.5': { id: 'gpt-5.5', name: 'GPT 5.5' },
      },
    },
  };
}

function makeJsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

const KOKUB_SOURCE: CustomRegistrySource = {
  kind: 'apiJson',
  url: 'https://registry.example.test/v1/models/api.json',
  apiKey: 'sk-token',
};

describe('fetchCustomRegistry', () => {
  it('parses a kokub-shaped 200 response into three providers', async () => {
    const fetchMock = vi.fn(async () => makeJsonResponse(makeKokubResponseBody()));

    const result = await fetchCustomRegistry(
      KOKUB_SOURCE,
      fetchMock as unknown as typeof fetch,
    );

    expect(Object.keys(result)).toHaveLength(3);
    expect(result['registry_chat-completions']?.type).toBe('openai');
    expect(result['registry_messages']?.type).toBe('anthropic');
    expect(result['registry_responses']?.type).toBe('openai_responses');
    expect(result['registry_chat-completions']?.models['gpt-5.5']).toEqual({
      id: 'gpt-5.5',
      name: 'GPT 5.5',
    });

    expect(fetchMock).toHaveBeenCalledWith(
      KOKUB_SOURCE.url,
      expect.objectContaining({
        headers: expect.objectContaining({
          Authorization: 'Bearer sk-token',
          Accept: 'application/json',
        }),
      }),
    );
  });

  it('omits the Authorization header when the apiKey is empty', async () => {
    const fetchMock = vi.fn(async () => makeJsonResponse(makeKokubResponseBody()));

    await fetchCustomRegistry(
      { kind: 'apiJson', url: KOKUB_SOURCE.url, apiKey: '' },
      fetchMock as unknown as typeof fetch,
    );

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const call = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    const headers = call[1].headers as Record<string, string>;
    expect(headers['Authorization']).toBeUndefined();
    expect(headers['Accept']).toBe('application/json');
  });

  it('forwards an AbortSignal when provided', async () => {
    const fetchMock = vi.fn(async () => makeJsonResponse(makeKokubResponseBody()));
    const controller = new AbortController();

    await fetchCustomRegistry(
      KOKUB_SOURCE,
      fetchMock as unknown as typeof fetch,
      controller.signal,
    );

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const call = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(call[1].signal).toBe(controller.signal);
  });

  it('throws CustomRegistryApiError with status on 401', async () => {
    const fetchMock = vi.fn(
      async () => makeJsonResponse({ error: { message: 'invalid bearer' } }, 401),
    );

    const error = await fetchCustomRegistry(
      KOKUB_SOURCE,
      fetchMock as unknown as typeof fetch,
    ).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(CustomRegistryApiError);
    expect((error as CustomRegistryApiError).status).toBe(401);
    expect((error as Error).message).toBe('invalid bearer');
  });

  it('throws when the payload is not an object', async () => {
    const fetchMock = vi.fn(async () => makeJsonResponse(['not', 'an', 'object']));

    await expect(
      fetchCustomRegistry(KOKUB_SOURCE, fetchMock as unknown as typeof fetch),
    ).rejects.toThrow(/expected a JSON object/);
  });

  it('skips invalid entries and keeps valid ones', async () => {
    const goodEntry = makeKokubResponseBody()['registry_chat-completions'];
    const fetchMock = vi.fn(
      async () =>
        makeJsonResponse({
          'broken-entry': { id: 'broken-entry', name: 'Broken' },
          'unknown-type': {
            id: 'unknown-type',
            name: 'Unknown Type',
            api: 'https://example.test/v1',
            type: 'google-genai',
            models: { 'm-1': { id: 'm-1' } },
          },
          'registry_chat-completions': goodEntry,
        }),
    );
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    try {
      const result = await fetchCustomRegistry(
        KOKUB_SOURCE,
        fetchMock as unknown as typeof fetch,
      );

      expect(Object.keys(result)).toEqual(['registry_chat-completions']);
      expect(result['broken-entry']).toBeUndefined();
      expect(result['unknown-type']).toBeUndefined();
      expect(result['registry_chat-completions']?.type).toBe('openai');

      expect(warnSpy).toHaveBeenCalledTimes(2);
      const warnings = warnSpy.mock.calls.map((args) => String(args[0]));
      expect(warnings.some((m) => m.includes('broken-entry'))).toBe(true);
      expect(warnings.some((m) => m.includes('unknown-type'))).toBe(true);
      expect(warnings.every((m) => m.includes(KOKUB_SOURCE.url))).toBe(true);
    } finally {
      warnSpy.mockRestore();
    }
  });
});

describe('applyCustomRegistryProvider', () => {
  it('writes provider + model aliases for a kokub-shaped entry with default fallbacks', () => {
    const config: ManagedKimiConfigShape = { providers: {} };
    const entry: CustomRegistryProviderEntry = {
      id: 'registry_chat-completions',
      name: 'Sample Registry (chat completions)',
      api: 'https://registry.example.test/v1',
      type: 'openai',
      models: {
        'gpt-5.5': { id: 'gpt-5.5', name: 'GPT 5.5' },
        'claude-opus-4-7': { id: 'claude-opus-4-7', name: 'Claude Opus 4.7' },
      },
    };

    applyCustomRegistryProvider(config, entry, KOKUB_SOURCE);

    expect(config.providers['registry_chat-completions']).toEqual({
      type: 'openai',
      baseUrl: 'https://registry.example.test/v1',
      apiKey: 'sk-token',
      source: KOKUB_SOURCE,
    });

    const gpt = config.models?.['registry_chat-completions/gpt-5.5'];
    expect(gpt).toBeDefined();
    expect(gpt).toMatchObject({
      provider: 'registry_chat-completions',
      model: 'gpt-5.5',
      maxContextSize: CUSTOM_REGISTRY_DEFAULT_MAX_CONTEXT,
      displayName: 'GPT 5.5',
    });
    expect(gpt).toMatchObject({ maxContextSize: 131072 });
    expect((gpt as { capabilities: string[] }).capabilities).toEqual([
      ...CUSTOM_REGISTRY_DEFAULT_CAPABILITIES,
    ]);

    const claude = config.models?.['registry_chat-completions/claude-opus-4-7'];
    expect(claude).toBeDefined();
    expect((claude as { displayName: string }).displayName).toBe('Claude Opus 4.7');
  });

  it('falls back to the model id for displayName when name is absent', () => {
    const config: ManagedKimiConfigShape = { providers: {} };
    const entry: CustomRegistryProviderEntry = {
      id: 'demo',
      name: 'Demo',
      api: 'https://demo.example/v1',
      type: 'openai',
      models: {
        'm-1': { id: 'm-1' },
      },
    };

    applyCustomRegistryProvider(config, entry, {
      kind: 'apiJson',
      url: 'https://demo.example/api.json',
      apiKey: 'x',
    });

    expect((config.models?.['demo/m-1'] as { displayName: string }).displayName).toBe('m-1');
  });

  it('derives rich capabilities and limit-based context size when rich fields are present', () => {
    const config: ManagedKimiConfigShape = { providers: {} };
    const entry: CustomRegistryProviderEntry = {
      id: 'rich',
      name: 'Rich Provider',
      api: 'https://rich.example/v1',
      type: 'openai',
      models: {
        'rich-vision': {
          id: 'rich-vision',
          name: 'Rich Vision',
          tool_call: true,
          reasoning: true,
          modalities: { input: ['text', 'image'], output: ['text'] },
          limit: { context: 200000, output: 8192 },
        },
      },
    };

    applyCustomRegistryProvider(config, entry, {
      kind: 'apiJson',
      url: 'https://rich.example/api.json',
      apiKey: 'sk-rich',
    });

    const alias = config.models?.['rich/rich-vision'] as {
      maxContextSize: number;
      capabilities: string[];
    };
    expect(alias.maxContextSize).toBe(200000);
    expect(alias.capabilities).toEqual(expect.arrayContaining(['tool_use', 'thinking', 'image_in']));
    expect(alias.capabilities).not.toContain('image_out');
  });

  it('clears stale aliases for the same provider before re-populating', () => {
    const config: ManagedKimiConfigShape = {
      providers: {
        'registry_chat-completions': {
          type: 'openai',
          baseUrl: 'https://registry.example.test/v1',
          apiKey: 'sk-old',
        },
      },
      models: {
        'registry_chat-completions/stale-model': {
          provider: 'registry_chat-completions',
          model: 'stale-model',
          maxContextSize: 1000,
        },
        'other/keepme': {
          provider: 'other',
          model: 'keepme',
          maxContextSize: 1000,
        },
      },
    };

    applyCustomRegistryProvider(
      config,
      {
        id: 'registry_chat-completions',
        name: 'Sample Registry (chat completions)',
        api: 'https://registry.example.test/v1',
        type: 'openai',
        models: {
          'gpt-5.5': { id: 'gpt-5.5', name: 'GPT 5.5' },
        },
      },
      KOKUB_SOURCE,
    );

    expect(config.models?.['registry_chat-completions/stale-model']).toBeUndefined();
    expect(config.models?.['registry_chat-completions/gpt-5.5']).toBeDefined();
    expect(config.models?.['other/keepme']).toBeDefined();
  });
});

describe('removeCustomRegistryProvider', () => {
  it('removes the provider and every alias for it, and clears matching defaultModel', () => {
    const config: ManagedKimiConfigShape = {
      providers: {
        'registry_chat-completions': {
          type: 'openai',
          baseUrl: 'https://registry.example.test/v1',
          apiKey: 'sk-token',
        },
        other: { type: 'openai', baseUrl: 'https://other.test/v1', apiKey: 'sk-other' },
      },
      models: {
        'registry_chat-completions/gpt-5.5': {
          provider: 'registry_chat-completions',
          model: 'gpt-5.5',
          maxContextSize: 131072,
        },
        'registry_chat-completions/claude-opus-4-7': {
          provider: 'registry_chat-completions',
          model: 'claude-opus-4-7',
          maxContextSize: 131072,
        },
        'other/keepme': { provider: 'other', model: 'keepme', maxContextSize: 1000 },
      },
      defaultModel: 'registry_chat-completions/gpt-5.5',
    };

    removeCustomRegistryProvider(config, 'registry_chat-completions');

    expect(config.providers['registry_chat-completions']).toBeUndefined();
    expect(config.providers['other']).toBeDefined();
    expect(config.models?.['registry_chat-completions/gpt-5.5']).toBeUndefined();
    expect(config.models?.['registry_chat-completions/claude-opus-4-7']).toBeUndefined();
    expect(config.models?.['other/keepme']).toBeDefined();
    expect(config.defaultModel).toBeUndefined();
  });

  it('leaves defaultModel intact when it belongs to another provider', () => {
    const config: ManagedKimiConfigShape = {
      providers: {
        'registry_chat-completions': {
          type: 'openai',
          baseUrl: 'https://registry.example.test/v1',
          apiKey: 'sk-token',
        },
      },
      models: {
        'registry_chat-completions/gpt-5.5': {
          provider: 'registry_chat-completions',
          model: 'gpt-5.5',
          maxContextSize: 131072,
        },
      },
      defaultModel: 'other/keepme',
    };

    removeCustomRegistryProvider(config, 'registry_chat-completions');

    expect(config.defaultModel).toBe('other/keepme');
  });
});

describe('capabilitiesFromCustomEntry', () => {
  it('returns an empty array when no rich fields are present', () => {
    expect(capabilitiesFromCustomEntry({ id: 'm' })).toEqual([]);
  });

  it('maps individual fields to kosong capability strings', () => {
    expect(
      capabilitiesFromCustomEntry({
        id: 'm',
        tool_call: true,
        reasoning: true,
        modalities: { input: ['text', 'image', 'video'], output: ['text', 'image', 'audio'] },
      }),
    ).toEqual(expect.arrayContaining(['tool_use', 'thinking', 'image_in', 'video_in', 'image_out', 'audio_out']));
  });

  it('omits capabilities that are explicitly false', () => {
    expect(
      capabilitiesFromCustomEntry({
        id: 'm',
        tool_call: false,
        reasoning: false,
      }),
    ).toEqual([]);
  });
});

import { APIError as RawOpenAISDKAPIError } from 'openai/error';
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';

import { contentsOf } from '@moonshot-ai/core/llm/requester';
import { streamLlmRequest } from '@moonshot-ai/core/llm/stream';
import { supportsLlmUpload } from '#/llm-adapter/model/media';
import type { Model } from '#/llm-adapter/model/catalog';
import { ProtocolAdapterRegistry } from '#/llm-adapter/protocol/protocolAdapterRegistry';
import {
  getProviderDefinition,
  getProviderDefinitions,
  hasProviderDefinition,
  registerProviderDefinition,
  resolveProviderEndpoint,
} from '#/llm-adapter/provider/provider-definition';

const ENV_KEYS = [
  'OPENAI_API_KEY',
  'OPENAI_BASE_URL',
  'KIMI_API_KEY',
  'KIMI_BASE_URL',
  'GOOGLE_API_KEY',
  'VERTEXAI_API_KEY',
  'DEEPSEEK_API_KEY',
  'DEEPSEEK_BASE_URL',
  'ZAI_API_KEY',
  'ZAI_BASE_URL',
  'MINIMAX_API_KEY',
  'MINIMAX_BASE_URL',
] as const;

let envSnapshot: Record<string, string | undefined>;

beforeEach(() => {
  envSnapshot = {};
  for (const key of ENV_KEYS) {
    envSnapshot[key] = process.env[key];
    delete process.env[key];
  }
});

afterEach(() => {
  for (const key of ENV_KEYS) {
    const value = envSnapshot[key];
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
});

registerProviderDefinition({
  id: 'cap-vendor',
  baseProtocol: 'openai',
  capability: (modelName: string) =>
    modelName === 'special-model'
      ? {
          image_in: true,
          video_in: false,
          audio_in: false,
          thinking: false,
          tool_use: true,
        }
      : undefined,
});

const registry = new ProtocolAdapterRegistry();

function modelWith(spec: {
  readonly protocol: Model['protocol'];
  readonly providerType?: string;
  readonly providerOptions?: Model['providerOptions'];
  readonly reasoningKey?: string;
  readonly supportEfforts?: readonly string[];
}): Model {
  return {
    id: 'm1',
    aliases: [],
    protocol: spec.protocol,
    spec: {
      provider: spec.providerType ?? spec.protocol,
      name: 'wire-model',
      capability: {
        image_in: false,
        video_in: false,
        audio_in: false,
        thinking: false,
        tool_use: true,
      },
      thinking: {
        supportEfforts: spec.supportEfforts,
        adaptiveThinking: spec.providerOptions?.adaptiveThinking,
        alwaysThinking: false,
      },
      maxContextSize: 128000,
    },
    endpoint: { headers: {} },
    providerType: spec.providerType,
    providerName: spec.providerType ?? spec.protocol,
    reasoningKey: spec.reasoningKey,
    providerOptions: spec.providerOptions,
  };
}

describe('supportedProtocols', () => {
  it('lists the four wire protocols and contains neither kimi nor vertexai', () => {
    const protocols = registry.supportedProtocols();
    expect(protocols).toHaveLength(4);
    expect([...protocols].toSorted()).toEqual(
      ['anthropic', 'google-genai', 'openai', 'openai_responses'].toSorted(),
    );
    expect(protocols).not.toContain('kimi');
    expect(protocols).not.toContain('vertexai');
  });
});

describe('resolveAdapterIdentity', () => {
  it('resolves the kimi pair registrations to their vendor protocol bindings', () => {
    expect(registry.resolveAdapterIdentity('openai', 'kimi').baseId).toBe('openai');
    expect(registry.resolveAdapterIdentity('openai', 'kimi').thinkingDriven).toBe(true);
    expect(registry.resolveAdapterIdentity('openai', 'kimi').strictThinkingValidation).toBe(true);
    expect(registry.resolveAdapterIdentity('anthropic', 'kimi').baseId).toBe('anthropic');
    expect(registry.resolveAdapterIdentity('anthropic', 'kimi').thinkingDriven).toBe(true);
    expect(registry.resolveAdapterIdentity('openai_responses', 'kimi').baseId).toBe(
      'openai_responses',
    );
    expect(registry.resolveAdapterIdentity('openai_responses', 'kimi').thinkingDriven).toBe(true);
    expect(registry.resolveAdapterIdentity('openai', 'deepseek').thinkingDriven).toBe(true);
    expect(registry.resolveAdapterIdentity('anthropic', 'deepseek').thinkingDriven).toBe(true);
    expect(registry.resolveAdapterIdentity('openai', 'glm').thinkingDriven).toBe(true);
    expect(registry.resolveAdapterIdentity('openai', 'minimax').thinkingDriven).toBe(true);
    expect(registry.resolveAdapterIdentity('anthropic', 'minimax').thinkingDriven).toBe(true);
  });

  it('resolves unregistered pairs to the protocol itself with no vendor trait', () => {
    const google = registry.resolveAdapterIdentity('google-genai', 'kimi');
    expect(google.baseId).toBe('google-genai');
    expect(google.thinkingDriven).toBeUndefined();
    const unknown = registry.resolveAdapterIdentity('openai', 'no-such-vendor');
    expect(unknown.baseId).toBe('openai');
    expect(unknown.thinkingDriven).toBeUndefined();
    const identity = registry.resolveAdapterIdentity('openai');
    expect(identity.baseId).toBe('openai');
    expect(identity.thinkingDriven).toBeUndefined();
    expect(registry.resolveProviderBaseId('google-genai', 'kimi')).toBe('google-genai');
    expect(registry.resolveProviderBaseId('openai', 'no-such-vendor')).toBe('openai');
    expect(registry.resolveProviderBaseId('openai')).toBe('openai');
  });
});

describe('resolveProviderBaseId', () => {
  it('returns the pair registration’s baseProtocol — the protocol itself by construction', () => {
    expect(registry.resolveProviderBaseId('openai', 'kimi')).toBe('openai');
    expect(registry.resolveProviderBaseId('anthropic', 'kimi')).toBe('anthropic');
  });

});

describe('resolveCapability', () => {
  it('falls back to trait capability hooks before the base catalog', () => {
    const fromTrait = registry.resolveCapability('openai', 'special-model', 'cap-vendor');
    expect(fromTrait?.image_in).toBe(true);
    const fromBase = registry.resolveCapability('openai', 'gpt-4o', 'cap-vendor');
    expect(fromBase?.image_in).toBe(true);
  });

  it('falls back to the base catalog and then to UNKNOWN', () => {
    expect(registry.resolveCapability('openai', 'gpt-4o')?.image_in).toBe(true);
    expect(registry.resolveCapability('openai', 'mystery-model')).toBeUndefined();
    expect(registry.resolveCapability('anthropic', 'claude-opus-4-1')?.thinking).toBe(true);
  });

  it('resolves builtin vendor capabilities before the base catalog', () => {
    expect(registry.resolveCapability('openai', 'kimi-for-coding', 'kimi')).toBeUndefined();
    expect(registry.resolveCapability('openai', 'gpt-4o', 'kimi')?.image_in).toBe(true);
    expect(registry.resolveCapability('openai', 'deepseek-flash', 'deepseek')?.image_in).toBe(true);
    expect(registry.resolveCapability('openai', 'deepseek-v4-pro', 'deepseek')?.image_in).toBe(false);
    expect(registry.resolveCapability('openai', 'glm-5.3', 'glm')?.image_in).toBe(false);
    expect(registry.resolveCapability('openai', 'glm-5.3-flash', 'glm')?.image_in).toBe(true);
    expect(registry.resolveCapability('openai', 'MiniMax-M3.1-Flash', 'minimax')).toMatchObject({
      image_in: true,
      video_in: true,
      thinking: true,
    });
  });
});

describe('request gateway routes', () => {
  it('routes kimi+openai to the kimi trait with the video upload media', () => {
    const resolved = registry.request(modelWith({ protocol: 'openai', providerType: 'kimi' }));
    expect(contentsOf(resolved).model?.spec?.provider).toBe('openai');
    expect(contentsOf(resolved).model?.spec?.name).toBe('wire-model');
    expect(supportsLlmUpload(resolved, 'video')).toBe(true);
    expect(supportsLlmUpload(resolved, 'image')).toBe(true);
  });

  it('routes plain and vendor requesters with their own upload media', () => {
    const resolved = registry.request(modelWith({ protocol: 'openai' }));
    expect(contentsOf(resolved).model?.spec?.provider).toBe('openai');
    expect(supportsLlmUpload(resolved, 'video')).toBe(false);
    expect(supportsLlmUpload(resolved, 'image')).toBe(false);
    const options = contentsOf(resolved).protocol?.options as {
      detectedReasoningKey?: () => string | undefined;
      onReasoningKey?: (key: string) => void;
    };
    expect(options.detectedReasoningKey?.()).toBeUndefined();
    options.onReasoningKey?.('reasoning_content');
    expect(options.detectedReasoningKey?.()).toBe('reasoning_content');

    const deepseek = registry.request(modelWith({ protocol: 'openai', providerType: 'deepseek' }));
    expect(contentsOf(deepseek).endpoint?.defaultBaseUrl).toBe('https://api.deepseek.com');
    expect(supportsLlmUpload(deepseek, 'image')).toBe(true);
    expect(supportsLlmUpload(deepseek, 'video')).toBe(false);
    const deepseekAnthropic = registry.request(
      modelWith({ protocol: 'anthropic', providerType: 'deepseek' }),
    );
    expect(contentsOf(deepseekAnthropic).endpoint?.defaultBaseUrl).toBe(
      'https://api.deepseek.com/anthropic',
    );
    expect(supportsLlmUpload(deepseekAnthropic, 'image')).toBe(true);
    const glm = registry.request(modelWith({ protocol: 'openai', providerType: 'glm' }));
    expect(contentsOf(glm).endpoint?.defaultBaseUrl).toBe('https://open.bigmodel.cn/api/paas/v4');
    expect(supportsLlmUpload(glm, 'image')).toBe(false);
    const miniMax = registry.request(modelWith({ protocol: 'openai', providerType: 'minimax' }));
    expect(contentsOf(miniMax).endpoint?.defaultBaseUrl).toBe('https://api.minimax.cn/v1');
    expect(supportsLlmUpload(miniMax, 'video')).toBe(false);
    const miniMaxAnthropic = registry.request(
      modelWith({ protocol: 'anthropic', providerType: 'minimax' }),
    );
    expect(contentsOf(miniMaxAnthropic).endpoint?.defaultBaseUrl).toBe(
      'https://api.minimax.cn/anthropic',
    );
    expect(supportsLlmUpload(miniMaxAnthropic, 'video')).toBe(false);
  });

  it('keeps stream business codes out of the real HTTP status at the registry boundary', () => {
    const resolved = registry.request(modelWith({ protocol: 'openai', providerType: 'kimi' }));
    const decodeError = contentsOf(resolved).protocol?.base?.decodeError;
    const rawError = new RawOpenAISDKAPIError(
      429,
      { message: 'backend stream quota', type: 'exceeded_current_quota_error' },
      'SDK-composed fallback',
      new Headers(),
    );

    expect(decodeError?.(rawError, 'stream')).toMatchObject({
      kind: 'quota_exhausted',
      message: 'backend stream quota',
      statusCode: undefined,
      retryable: false,
    });
    expect(decodeError?.(rawError)).toMatchObject({
      kind: 'quota_exhausted',
      message: 'backend stream quota',
      statusCode: 429,
      retryable: false,
    });
  });

  it('reports the wire protocol regardless of beta or vertex provider options', () => {
    const beta = registry.request(
      modelWith({ protocol: 'anthropic', providerOptions: { betaApi: true } }),
    );
    expect(contentsOf(beta).model?.spec?.provider).toBe('anthropic');
    expect(contentsOf(beta).protocol?.options).toMatchObject({ betaApi: true });
    const vertex = registry.request(
      modelWith({
        protocol: 'google-genai',
        providerOptions: { vertexai: true, project: 'p', location: 'l' },
      }),
    );
    expect(contentsOf(vertex).model?.spec?.provider).toBe('google_genai');
    expect(contentsOf(vertex).protocol?.options).toMatchObject({ vertexai: true });
  });

  it('routes kimi+anthropic with media and explicit beta opt-in', async () => {
    const resolved = registry.request(modelWith({ protocol: 'anthropic', providerType: 'kimi' }));
    expect(contentsOf(resolved).model?.spec?.provider).toBe('anthropic');
    expect(supportsLlmUpload(resolved, 'video')).toBe(true);
    expect(supportsLlmUpload(resolved, 'image')).toBe(true);

    const urls: string[] = [];
    const terminal: string[] = [];
    const failures: unknown[] = [];
    vi.stubGlobal('fetch', (async (
      input: Parameters<typeof fetch>[0],
      init?: Parameters<typeof fetch>[1],
    ) => {
      urls.push(new Request(input, init).url);
      const events = [
        {
          type: 'message_start',
          message: {
            id: 'msg_1',
            type: 'message',
            role: 'assistant',
            model: 'wire-model',
            content: [],
            stop_reason: null,
            stop_sequence: null,
            usage: { input_tokens: 1, output_tokens: 1 },
          },
        },
        { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
        { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'hi' } },
        { type: 'content_block_stop', index: 0 },
        { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 1 } },
        { type: 'message_stop' },
      ];
      return new Response(
        events
          .map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`)
          .join(''),
        { status: 200, headers: { 'content-type': 'text/event-stream' } },
      );
    }) as typeof fetch);
    const generate = async (providerOptions?: Model['providerOptions']) => {
      const routed = registry.request(
        modelWith({ protocol: 'anthropic', providerType: 'kimi', providerOptions }),
      );
      try {
        for await (const event of streamLlmRequest(
          routed.request({
            profile: { systemPrompt: '', tools: [] },
            content: { messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }] },
          }),
          { signal: new AbortController().signal },
        )) {
          if (event.type === 'llm.ended') terminal.push(event.type);
        }
      } catch (error) {
        failures.push(error);
      }
    };
    try {
      await generate();
      await generate({ betaApi: true });
      expect(failures).toEqual([]);
      expect(urls.map((url) => new URL(url).searchParams.get('beta'))).toEqual([null, 'true']);
      expect(terminal).toEqual(['llm.ended', 'llm.ended']);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('carries thinking metadata and model limits onto the resolved LlmModel', () => {
    const resolved = registry.request(
      modelWith({
        protocol: 'anthropic',
        supportEfforts: ['low', 'high'],
        providerOptions: { supportEfforts: ['low', 'high'], adaptiveThinking: true },
      }),
    );
    expect(contentsOf(resolved).model?.spec?.maxContextSize).toBe(128000);
    expect(contentsOf(resolved).model?.spec?.thinking).toMatchObject({
      supportEfforts: ['low', 'high'],
      adaptiveThinking: true,
    });
  });
});

describe('resolveProviderEndpoint', () => {
  it('resolves the kimi endpoint chain from process.env', () => {
    process.env['KIMI_API_KEY'] = 'sk-kimi-env';
    expect(resolveProviderEndpoint('kimi')).toEqual({
      apiKey: 'sk-kimi-env',
      baseUrl: 'https://api.moonshot.ai/v1',
    });
  });

  it('reads a caller-supplied env bag instead of process.env', () => {
    process.env['KIMI_API_KEY'] = 'sk-kimi-env';
    expect(resolveProviderEndpoint('kimi', { KIMI_BASE_URL: 'https://example.com/v1' })).toEqual({
      baseUrl: 'https://example.com/v1',
    });
    expect(resolveProviderEndpoint('deepseek', {})).toEqual({ baseUrl: 'https://api.deepseek.com' });
    expect(resolveProviderEndpoint('deepseek', {}, 'anthropic')).toEqual({
      baseUrl: 'https://api.deepseek.com/anthropic',
    });
    expect(resolveProviderEndpoint('glm', {})).toEqual({
      baseUrl: 'https://open.bigmodel.cn/api/paas/v4',
    });
    expect(resolveProviderEndpoint('minimax', {})).toEqual({ baseUrl: 'https://api.minimax.cn/v1' });
    expect(resolveProviderEndpoint('minimax', {}, 'anthropic')).toEqual({
      baseUrl: 'https://api.minimax.cn/anthropic',
    });
    expect(resolveProviderEndpoint('no-such-vendor')).toEqual({});
    expect(
      resolveProviderEndpoint('openai', { OPENAI_BASE_URL: 'https://example.com/v1' }, 'anthropic'),
    ).toEqual({ baseUrl: 'https://example.com/v1' });
  });

  it('aggregates the google-genai chain with the legacy vertex precedence', () => {
    expect(
      resolveProviderEndpoint('google-genai', {
        VERTEXAI_API_KEY: 'vertex-env-key',
        GOOGLE_API_KEY: 'google-env-key',
      }),
    ).toEqual({ apiKey: 'vertex-env-key' });
    expect(resolveProviderEndpoint('google-genai', { GOOGLE_API_KEY: 'google-env-key' })).toEqual({
      apiKey: 'google-env-key',
    });
    expect(
      resolveProviderEndpoint('google-genai', {
        GOOGLE_VERTEX_BASE_URL: 'https://vertex.example.test',
        GOOGLE_GEMINI_BASE_URL: 'https://gemini.example.test',
      }),
    ).toEqual({ baseUrl: 'https://vertex.example.test' });
    expect(
      resolveProviderEndpoint('google-genai', {
        GOOGLE_GEMINI_BASE_URL: 'https://gemini.example.test',
      }),
    ).toEqual({ baseUrl: 'https://gemini.example.test' });
  });

});

describe('kimi provider definitions', () => {
  it('registers one definition per transport, with shared vendor-level facts', () => {
    const native = getProviderDefinition('kimi', 'openai');
    const anthropic = getProviderDefinition('kimi', 'anthropic');
    const responses = getProviderDefinition('kimi', 'openai_responses');
    expect(native?.baseProtocol).toBe('openai');
    expect(native?.requester).toBeDefined();
    expect(anthropic?.baseProtocol).toBe('anthropic');
    expect(anthropic?.requester).toBeDefined();
    expect(responses?.baseProtocol).toBe('openai_responses');
    expect(responses?.requester).toBeDefined();
    for (const definition of [native, anthropic, responses]) {
      expect(definition?.endpoint).toEqual({
        apiKeyEnv: 'KIMI_API_KEY',
        baseUrlEnv: 'KIMI_BASE_URL',
        defaultBaseUrl: 'https://api.moonshot.ai/v1',
      });
      expect(definition?.hostHeaders).toBe('full');
      expect(definition?.modelSource).toBe('oauth-catalog');
    }
  });

  it('answers id-level queries and reports unregistered pairs', () => {
    expect(getProviderDefinition('kimi')?.baseProtocol).toBe('openai');
    expect(getProviderDefinitions('kimi')).toHaveLength(3);
    expect(getProviderDefinitions('deepseek')).toHaveLength(2);
    expect(getProviderDefinition('deepseek', 'openai')?.endpoint?.apiKeyEnv).toBe('DEEPSEEK_API_KEY');
    expect(getProviderDefinition('deepseek', 'anthropic')?.endpoint?.apiKeyEnv).toBe('DEEPSEEK_API_KEY');
    expect(getProviderDefinition('glm', 'openai')?.endpoint?.apiKeyEnv).toBe('ZAI_API_KEY');
    expect(getProviderDefinitions('minimax')).toHaveLength(2);
    expect(getProviderDefinition('minimax', 'openai')?.endpoint?.apiKeyEnv).toBe('MINIMAX_API_KEY');
    expect(getProviderDefinition('minimax', 'anthropic')?.endpoint?.apiKeyEnv).toBe('MINIMAX_API_KEY');
    expect(hasProviderDefinition('kimi')).toBe(true);
    expect(hasProviderDefinition('no-such-vendor')).toBe(false);
    expect(getProviderDefinition('kimi', 'google-genai')).toBeUndefined();
  });

  it('allows the same id on several protocols but rejects a duplicate (id, baseProtocol) pair', () => {
    registerProviderDefinition({
      id: 'pair-vendor',
      baseProtocol: 'openai',
    });
    registerProviderDefinition({
      id: 'pair-vendor',
      baseProtocol: 'anthropic',
    });
    expect(getProviderDefinition('pair-vendor', 'openai')).toBeDefined();
    expect(getProviderDefinition('pair-vendor', 'anthropic')).toBeDefined();
    expect(() =>
      registerProviderDefinition({
        id: 'pair-vendor',
        baseProtocol: 'openai',
      }),
    ).toThrow(/already registered/);
    expect(() =>
      registerProviderDefinition({
        id: 'kimi',
        baseProtocol: 'openai',
      }),
    ).toThrow(/already registered/);
  });
});

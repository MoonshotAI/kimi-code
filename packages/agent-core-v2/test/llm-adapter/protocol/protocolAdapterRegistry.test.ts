import { APIError as RawOpenAISDKAPIError } from 'openai/error';
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';

import { isUnknownCapability } from '#/llm-adapter/contract/capability';
import { contentsOf } from '#human/llm/requester';
import { supportsLlmUpload, uploadImage, uploadVideo } from '#/llm-adapter/model/media';
import { generateModel } from '#/llm-adapter/model/generate';
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
    name: 'wire-model',
    aliases: [],
    protocol: spec.protocol,
    headers: {},
    capabilities: {
      image_in: false,
      video_in: false,
      audio_in: false,
      thinking: false,
      tool_use: true,
      max_context_tokens: 128000,
    },
    maxContextSize: 128000,
    alwaysThinking: false,
    providerType: spec.providerType,
    providerName: spec.providerType ?? spec.protocol,
    reasoningKey: spec.reasoningKey,
    supportEfforts: spec.supportEfforts,
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
  });

  it('resolves unregistered pairs to the protocol itself with no vendor trait', () => {
    const google = registry.resolveAdapterIdentity('google-genai', 'kimi');
    expect(google.baseId).toBe('google-genai');
    expect(google.thinkingDriven).toBeUndefined();
    const unknown = registry.resolveAdapterIdentity('openai', 'no-such-vendor');
    expect(unknown.baseId).toBe('openai');
    expect(unknown.thinkingDriven).toBeUndefined();
  });

  it('resolves the no-providerType branch identically', () => {
    const identity = registry.resolveAdapterIdentity('openai');
    expect(identity.baseId).toBe('openai');
    expect(identity.thinkingDriven).toBeUndefined();
  });
});

describe('resolveProviderBaseId', () => {
  it('returns the pair registration’s baseProtocol — the protocol itself by construction', () => {
    expect(registry.resolveProviderBaseId('openai', 'kimi')).toBe('openai');
    expect(registry.resolveProviderBaseId('anthropic', 'kimi')).toBe('anthropic');
  });

  it('returns the protocol itself otherwise', () => {
    expect(registry.resolveProviderBaseId('google-genai', 'kimi')).toBe('google-genai');
    expect(registry.resolveProviderBaseId('openai', 'no-such-vendor')).toBe('openai');
    expect(registry.resolveProviderBaseId('openai')).toBe('openai');
  });
});

describe('resolveCapability', () => {
  it('falls back to trait capability hooks before the base catalog', () => {
    const fromTrait = registry.resolveCapability('openai', 'special-model', 'cap-vendor');
    expect(fromTrait.image_in).toBe(true);
    const fromBase = registry.resolveCapability('openai', 'gpt-4o', 'cap-vendor');
    expect(fromBase.image_in).toBe(true);
  });

  it('falls back to the base catalog and then to UNKNOWN', () => {
    expect(registry.resolveCapability('openai', 'gpt-4o').image_in).toBe(true);
    expect(isUnknownCapability(registry.resolveCapability('openai', 'mystery-model'))).toBe(true);
    expect(registry.resolveCapability('anthropic', 'claude-opus-4-1').thinking).toBe(true);
  });

  it('kimi declares no vendor-level capability — the base catalog answers instead', () => {
    expect(isUnknownCapability(registry.resolveCapability('openai', 'kimi-for-coding', 'kimi'))).toBe(
      true,
    );
    expect(registry.resolveCapability('openai', 'gpt-4o', 'kimi').image_in).toBe(true);
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

  it('routes plain openai without the upload media', () => {
    const resolved = registry.request(modelWith({ protocol: 'openai' }));
    expect(contentsOf(resolved).model?.spec?.provider).toBe('openai');
    expect(supportsLlmUpload(resolved, 'video')).toBe(false);
    expect(supportsLlmUpload(resolved, 'image')).toBe(false);
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
        for await (const event of generateModel(
          routed,
          {
            systemPrompt: '',
            tools: [],
            messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
          },
          new AbortController().signal,
          { stream: true },
        )) {
          if (event.type === 'finish') terminal.push(event.type);
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
      expect(terminal).toEqual(['finish', 'finish']);
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

  it('returns {} for unregistered vendors', () => {
    expect(resolveProviderEndpoint('no-such-vendor')).toEqual({});
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

  describe('kimi files upload status validation', () => {
    function kimiUploadRequest(protocol: 'openai' | 'anthropic' | 'openai_responses', responseBody: unknown, status = 200) {
      const seenUrls: string[] = [];
      const mockFetch: typeof fetch = async (input, init) => {
        const httpRequest = new Request(input, init);
        if (httpRequest.url.startsWith('data:')) {
          return fetch(input, init);
        }
        seenUrls.push(httpRequest.url);
        return Response.json(responseBody, { status });
      };
      const baseModel = modelWith({ protocol, providerType: 'kimi' });
      const model: Model = {
        ...baseModel,
        baseUrl: protocol === 'anthropic' ? 'https://example.test' : 'https://example.test/v1',
        credentialProvider: { resolve: () => ({ apiKey: 'YOUR_API_KEY' }) },
      };
      const request = registry.request(model).with({ endpoint: { fetch: mockFetch } });
      return { model, request, seenUrls };
    }

    it.each([
      ['extract_status=ready (201)', 201, { id: 'file_ready_1', extract_status: 'ready' }, 'file_ready_1'],
      ['status=ready (200)', 200, { id: 'file_ready_2', status: 'ready', status_details: '' }, 'file_ready_2'],
      ['status=ok (200)', 200, { id: 'file_ok_1', status: 'ok', status_details: '' }, 'file_ok_1'],
      ['status=processed (200)', 200, { id: 'file_proc_ok', status: 'processed' }, 'file_proc_ok'],
      ['status=uploaded with extract_status=ready (200)', 200, { id: 'file_up_ready', status: 'uploaded', extract_status: 'ready' }, 'file_up_ready'],
      ['minimal id-only payload (200)', 200, { id: 'file_min_1' }, 'file_min_1'],
    ])('accepts %s and returns an ms:// reference', async (_label, httpStatus, payload, expectedId) => {
      const { model, request, seenUrls } = kimiUploadRequest('openai', payload, httpStatus);
      const part = await uploadImage(model, request, {
        data: new Uint8Array([1, 2, 3]),
        mimeType: 'image/png',
        filename: 'sample.png',
      });
      expect(seenUrls).toEqual(['https://example.test/v1/files']);
      expect(part).toEqual({
        type: 'image_url',
        imageUrl: { url: `ms://${expectedId}`, id: expectedId },
      });
    });

    it.each([
      [
        'extract_status=error without details',
        'openai' as const,
        { id: 'file_err_1', extract_status: 'error' },
        /file_err_1.*extract_status=error/,
      ],
      [
        'extract_status=error with status_details on anthropic transport',
        'anthropic' as const,
        { id: 'file_err_2', extract_status: 'error', status_details: 'corrupted image stream' },
        /file_err_2.*extract_status=error.*corrupted image stream/,
      ],
      [
        'extract_status=error with nested error message on responses transport',
        'openai_responses' as const,
        { id: 'file_err_3', extract_status: 'error', error: { message: 'unsupported color profile' } },
        /file_err_3.*extract_status=error.*unsupported color profile/,
      ],
      [
        'status=error with status_details',
        'openai' as const,
        { id: 'file_err_4', status: 'error', status_details: 'invalid image format' },
        /file_err_4.*status=error.*invalid image format/,
      ],
      [
        'extract_status=error alongside status=uploaded',
        'openai' as const,
        { id: 'file_err_5', status: 'uploaded', extract_status: 'error' },
        /file_err_5.*extract_status=error/,
      ],
      [
        'status=error alongside extract_status=ready',
        'openai' as const,
        { id: 'file_err_6', status: 'error', extract_status: 'ready', status_details: 'decode failed' },
        /file_err_6.*status=error.*decode failed/,
      ],
      [
        'non-ready extract_status=processing',
        'openai' as const,
        { id: 'file_not_ready_1', extract_status: 'processing' },
        /file_not_ready_1.*not ready.*extract_status=processing/,
      ],
      [
        'non-ready status=uploaded without extract_status=ready',
        'openai' as const,
        { id: 'file_not_ready_up', status: 'uploaded' },
        /file_not_ready_up.*not ready.*status=uploaded/,
      ],
      [
        'non-ready status=processing',
        'openai' as const,
        { id: 'file_not_ready_2', status: 'processing' },
        /file_not_ready_2.*not ready.*status=processing/,
      ],
      [
        'empty file id',
        'openai' as const,
        { id: '', extract_status: 'ready' },
        /empty file id/,
      ],
    ])('rejects %s before creating an ms:// reference', async (_label, protocol, payload, expectedPattern) => {
      const { model, request, seenUrls } = kimiUploadRequest(protocol, payload, 200);
      await expect(
        uploadImage(model, request, {
          data: new Uint8Array([1, 2, 3]),
          mimeType: 'image/png',
          filename: 'sample.png',
        }),
      ).rejects.toThrow(expectedPattern);
      expect(seenUrls).toEqual(['https://example.test/v1/files']);
    });

    it('validates extract_status for video uploads as well', async () => {
      const failing = kimiUploadRequest('openai', {
        id: 'vid_err_1',
        extract_status: 'error',
        status_details: 'unsupported video codec',
      });
      await expect(
        uploadVideo(failing.model, failing.request, {
          data: new Uint8Array([1, 2, 3]),
          mimeType: 'video/mp4',
          filename: 'clip.mp4',
        }),
      ).rejects.toThrow(/vid_err_1.*extract_status=error.*unsupported video codec/);

      const ready = kimiUploadRequest(
        'openai',
        { id: 'vid_ready_1', extract_status: 'ready' },
        201,
      );
      const part = await uploadVideo(ready.model, ready.request, {
        data: new Uint8Array([1, 2, 3]),
        mimeType: 'video/mp4',
        filename: 'clip.mp4',
      });
      expect(part).toEqual({
        type: 'video_url',
        videoUrl: { url: 'ms://vid_ready_1', id: 'vid_ready_1' },
      });
    });
  });
});

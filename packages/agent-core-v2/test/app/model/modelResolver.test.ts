/**
 * `model` domain — `ModelResolverService` regression tests.
 *
 * Covers two resolver responsibilities:
 *  1. Auth shape — the resolved `Model` god-object drives real requests through
 *     kosong, which reads the bearer/api token from `ProviderRequestAuth.apiKey`
 *     (`requireProviderApiKey`). The resolver's `AuthProvider` must return the
 *     token as `apiKey` (not wrapped in `headers`), so a resolved Model can
 *     authenticate against its endpoint.
 *  2. Default thinking — the resolver reads the `thinking` config section and
 *     applies the same default effort the production agent
 *     path (via `profile`) does, so a plain `model.request()` behaves
 *     identically (some endpoints reject a request that omits thinking).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { DisposableStore } from '#/_base/di/lifecycle';
import { createServices, type TestInstantiationService } from '#/_base/di/test';
import { IOAuthService } from '#/app/auth/auth';
import { IConfigService } from '#/app/config/config';
import { APIStatusError } from '#/app/llmProtocol/errors';
import { type ModelConfig, IModelService } from '#/app/model/model';
import { HostRequestHeaders, IHostRequestHeaders } from '#/app/model/hostRequestHeaders';
import { IModelResolver } from '#/app/model/modelResolver';
import { ModelResolverService, resolveOutboundHeaders } from '#/app/model/modelResolverService';
import { type PlatformConfig, IPlatformService } from '#/app/platform/platform';
import { type ProviderConfig, IProviderService } from '#/app/provider/provider';
import { type ChatProvider } from '#/app/llmProtocol/provider';
import { IProtocolAdapterRegistry, type ProtocolAdapterConfig } from '#/app/protocol/protocol';

let generateImpl: ChatProvider['generate'];
let uploadVideoImpl: NonNullable<ChatProvider['uploadVideo']> | undefined;

describe('ModelResolverService', () => {
  let disposables: DisposableStore;
  let ix: TestInstantiationService;
  let providers: Record<string, ProviderConfig>;
  let platforms: Record<string, PlatformConfig>;
  let models: Record<string, ModelConfig>;
  let configValues: Record<string, unknown>;
  let resolveTokenProvider: ReturnType<typeof vi.fn>;
  let createdProtocolConfigs: Record<string, unknown>[];

  beforeEach(() => {
    disposables = new DisposableStore();
    providers = {};
    platforms = {};
    models = {};
    configValues = {};
    resolveTokenProvider = vi.fn();
    createdProtocolConfigs = [];
    generateImpl = async () => ({
      id: null,
      usage: null,
      finishReason: 'completed',
      rawFinishReason: null,
      async *[Symbol.asyncIterator]() {
        yield { type: 'text' as const, text: 'ok' };
      },
    });
    uploadVideoImpl = undefined;
    ix = createServices(disposables, {
      additionalServices: (reg) => {
        reg.definePartialInstance(IConfigService, {
          get: ((domain: string) => configValues[domain]) as unknown as IConfigService['get'],
        });
        reg.definePartialInstance(IProviderService, {
          get: ((name: string) => providers[name]) as IProviderService['get'],
          list: (() => providers) as IProviderService['list'],
        });
        reg.definePartialInstance(IPlatformService, {
          get: ((name: string) => platforms[name]) as IPlatformService['get'],
          list: (() => platforms) as IPlatformService['list'],
        });
        reg.definePartialInstance(IModelService, {
          get: ((id: string) => models[id]) as IModelService['get'],
          list: (() => models) as IModelService['list'],
        });
        reg.definePartialInstance(IOAuthService, {
          resolveTokenProvider: resolveTokenProvider as unknown as IOAuthService['resolveTokenProvider'],
        });
        reg.definePartialInstance(IProtocolAdapterRegistry, {
          supportedProtocols: () => [],
          createChatProvider: (input: ProtocolAdapterConfig) => {
            createdProtocolConfigs.push(input as unknown as Record<string, unknown>);
            return fakeChatProvider;
          },
        } as Partial<IProtocolAdapterRegistry> & {
          createChatProvider(input: ProtocolAdapterConfig): ChatProvider;
        });
        reg.define(IModelResolver, ModelResolverService);
        reg.defineInstance(IHostRequestHeaders, new HostRequestHeaders());
      },
    });
  });

  afterEach(() => disposables.dispose());

  async function resolveAndCreateProvider(modelId = 'm'): Promise<Record<string, unknown>> {
    const model = ix.get(IModelResolver).resolve(modelId);
    for await (const _event of model.request({ systemPrompt: '', tools: [], messages: [] })) {
      void _event;
    }
    expect(createdProtocolConfigs).toHaveLength(1);
    return createdProtocolConfigs[0]!;
  }

  it('returns the provider apiKey as ProviderRequestAuth.apiKey', async () => {
    providers['p'] = { type: 'kimi', baseUrl: 'https://example.test/v1', apiKey: 'sk-test' };
    models['m'] = { provider: 'p', model: 'wire-name', maxContextSize: 1000 };

    const auth = await ix.get(IModelResolver).resolve('m').authProvider.getAuth();

    expect(auth).toEqual({ apiKey: 'sk-test' });
  });

  it('falls back to defaultProvider when the model pins no provider', () => {
    providers['p'] = { type: 'kimi', baseUrl: 'https://example.test/v1', apiKey: 'sk-test' };
    models['m'] = { model: 'wire-name', maxContextSize: 1000 };
    configValues['defaultProvider'] = 'p';

    expect(ix.get(IModelResolver).resolve('m').providerName).toBe('p');
  });

  it('prefers an explicit model provider over defaultProvider', () => {
    providers['explicit'] = { type: 'kimi', baseUrl: 'https://example.test/v1', apiKey: 'sk' };
    providers['default'] = { type: 'openai', baseUrl: 'https://example.test/v1', apiKey: 'sk' };
    models['m'] = { provider: 'explicit', model: 'wire-name', maxContextSize: 1000 };
    configValues['defaultProvider'] = 'default';

    expect(ix.get(IModelResolver).resolve('m').providerName).toBe('explicit');
  });

  it('prefers a model-inline apiKey override as ProviderRequestAuth.apiKey', async () => {
    providers['p'] = { type: 'kimi', baseUrl: 'https://example.test/v1', apiKey: 'sk-provider' };
    models['m'] = {
      provider: 'p',
      model: 'wire-name',
      maxContextSize: 1000,
      apiKey: 'sk-model',
    };

    const auth = await ix.get(IModelResolver).resolve('m').authProvider.getAuth();

    expect(auth).toEqual({ apiKey: 'sk-model' });
  });

  it('forwards declared select_tools capability to the resolved model', () => {
    providers['p'] = { type: 'kimi', baseUrl: 'https://example.test/v1', apiKey: 'sk-test' };
    models['m'] = {
      provider: 'p',
      model: 'wire-name',
      maxContextSize: 1000,
      capabilities: ['select_tools'],
    };

    expect(ix.get(IModelResolver).resolve('m').capabilities.select_tools).toBe(true);
  });

  it('returns an OAuth access token as ProviderRequestAuth.apiKey', async () => {
    providers['p'] = {
      type: 'kimi',
      baseUrl: 'https://example.test/v1',
      oauth: { storage: 'file', key: 'oauth/test' },
    };
    models['m'] = { provider: 'p', model: 'wire-name', maxContextSize: 1000 };
    resolveTokenProvider.mockReturnValue({ getAccessToken: async () => 'oauth-token' });

    const auth = await ix.get(IModelResolver).resolve('m').authProvider.getAuth();

    expect(auth).toEqual({ apiKey: 'oauth-token' });
    expect(resolveTokenProvider).toHaveBeenCalledWith('p', { storage: 'file', key: 'oauth/test' });
  });

  it('throws login_required when an OAuth provider has no token provider', async () => {
    providers['p'] = {
      type: 'kimi',
      baseUrl: 'https://example.test/v1',
      oauth: { storage: 'file', key: 'oauth/test' },
    };
    models['m'] = { provider: 'p', model: 'wire-name', maxContextSize: 1000 };

    await expect(ix.get(IModelResolver).resolve('m').authProvider.getAuth()).rejects.toMatchObject({
      code: 'auth.login_required',
    });
  });

  it('throws login_required when an OAuth token provider returns an empty token', async () => {
    providers['p'] = {
      type: 'kimi',
      baseUrl: 'https://example.test/v1',
      oauth: { storage: 'file', key: 'oauth/test' },
    };
    models['m'] = { provider: 'p', model: 'wire-name', maxContextSize: 1000 };
    resolveTokenProvider.mockReturnValue({ getAccessToken: async () => '  ' });

    await expect(ix.get(IModelResolver).resolve('m').authProvider.getAuth()).rejects.toMatchObject({
      code: 'auth.login_required',
    });
  });


  it('returns undefined when the model carries no auth material', async () => {
    providers['p'] = { type: 'kimi', baseUrl: 'https://example.test/v1' };
    models['m'] = { provider: 'p', model: 'wire-name', maxContextSize: 1000 };

    const auth = await ix.get(IModelResolver).resolve('m').authProvider.getAuth();

    expect(auth).toBeUndefined();
  });

  it('falls through an empty-string provider apiKey to OAuth', async () => {
    providers['p'] = {
      type: 'kimi',
      baseUrl: 'https://example.test/v1',
      apiKey: '',
      oauth: { storage: 'file', key: 'oauth/test' },
    };
    models['m'] = { provider: 'p', model: 'wire-name', maxContextSize: 1000 };
    resolveTokenProvider.mockReturnValue({ getAccessToken: async () => 'oauth-token' });

    const auth = await ix.get(IModelResolver).resolve('m').authProvider.getAuth();

    expect(auth).toEqual({ apiKey: 'oauth-token' });
  });

  it.each([
    ['kimi', 'KIMI_API_KEY'],
    ['openai', 'OPENAI_API_KEY'],
    ['openai_responses', 'OPENAI_API_KEY'],
    ['anthropic', 'ANTHROPIC_API_KEY'],
    ['google-genai', 'GOOGLE_API_KEY'],
    ['vertexai', 'VERTEXAI_API_KEY'],
  ] as const)('uses %s provider env API key fallback', async (type, key) => {
    providers['p'] = {
      type,
      baseUrl: 'https://example.test/v1',
      env: { [key]: `${type}-token` },
    };
    models['m'] = { provider: 'p', model: 'wire-name', maxContextSize: 1000 };

    const auth = await ix.get(IModelResolver).resolve('m').authProvider.getAuth();

    expect(auth).toEqual({ apiKey: `${type}-token` });
  });

  it('uses GOOGLE_API_KEY as the Vertex API key fallback when VERTEXAI_API_KEY is absent', async () => {
    providers['p'] = {
      type: 'vertexai',
      baseUrl: 'https://example.test/v1',
      env: { GOOGLE_API_KEY: 'google-token' },
    };
    models['m'] = { provider: 'p', model: 'wire-name', maxContextSize: 1000 };

    const auth = await ix.get(IModelResolver).resolve('m').authProvider.getAuth();

    expect(auth).toEqual({ apiKey: 'google-token' });
  });

  it('uses platform auth env API key fallback before legacy provider auth', async () => {
    platforms['shared'] = { auth: { env: { OPENAI_API_KEY: 'platform-token' } } };
    providers['p'] = {
      type: 'openai',
      baseUrl: 'https://example.test/v1',
      platformId: 'shared',
      env: { OPENAI_API_KEY: 'provider-token' },
    };
    models['m'] = { provider: 'p', model: 'wire-name', maxContextSize: 1000 };

    const auth = await ix.get(IModelResolver).resolve('m').authProvider.getAuth();

    expect(auth).toEqual({ apiKey: 'platform-token' });
  });

  it('rejects provider oauth when an env API key also resolves', () => {
    providers['p'] = {
      type: 'kimi',
      baseUrl: 'https://example.test/v1',
      oauth: { storage: 'file', key: 'oauth/test' },
      env: { KIMI_API_KEY: 'env-token' },
    };
    models['m'] = { provider: 'p', model: 'wire-name', maxContextSize: 1000 };

    expect(() => ix.get(IModelResolver).resolve('m')).toThrow(
      'Provider "p" has both apiKey and oauth set in config.toml',
    );
  });

  it('rejects platform oauth when an env API key also resolves', () => {
    platforms['shared'] = {
      auth: {
        oauth: { storage: 'file', key: 'oauth/platform' },
        env: { OPENAI_API_KEY: 'platform-token' },
      },
    };
    providers['p'] = {
      type: 'openai',
      baseUrl: 'https://example.test/v1',
      platformId: 'shared',
    };
    models['m'] = { provider: 'p', model: 'wire-name', maxContextSize: 1000 };

    expect(() => ix.get(IModelResolver).resolve('m')).toThrow(
      'Platform "shared" has both apiKey and oauth set in config.toml',
    );
  });

  describe('OAuth refresh replay', () => {
    function configureOAuthModel(): void {
      providers['p'] = {
        type: 'kimi',
        baseUrl: 'https://example.test/v1',
        oauth: { storage: 'file', key: 'oauth/test' },
      };
      models['m'] = { provider: 'p', model: 'wire-name', maxContextSize: 1000 };
    }

    it('force-refreshes OAuth credentials and replays a request after 401', async () => {
      configureOAuthModel();
      const tokenCalls: Array<boolean | undefined> = [];
      const authKeys: string[] = [];
      resolveTokenProvider.mockReturnValue({
        getAccessToken: async (options?: { readonly force?: boolean }) => {
          tokenCalls.push(options?.force);
          return options?.force === true ? 'forced-refresh-token' : 'fresh-token';
        },
      });
      generateImpl = async (_system, _tools, _history, options) => {
        authKeys.push(options?.auth?.apiKey ?? '<missing>');
        if (authKeys.length === 1) {
          throw new APIStatusError(401, 'Unauthorized', 'req-401');
        }
        return {
          id: null,
          usage: null,
          finishReason: 'completed',
          rawFinishReason: null,
          async *[Symbol.asyncIterator]() {
            yield { type: 'text' as const, text: 'recovered' };
          },
        };
      };

      const events = [];
      for await (const event of ix.get(IModelResolver).resolve('m').request({
        systemPrompt: '',
        tools: [],
        messages: [],
      })) {
        events.push(event);
      }

      expect(authKeys).toEqual(['fresh-token', 'forced-refresh-token']);
      expect(tokenCalls).toEqual([undefined, true]);
      expect(events).toContainEqual({ type: 'part', part: { type: 'text', text: 'recovered' } });
    });

    it('throws provider auth error when force-refresh and replay both 401', async () => {
      configureOAuthModel();
      const authKeys: string[] = [];
      resolveTokenProvider.mockReturnValue({
        getAccessToken: async (options?: { readonly force?: boolean }) =>
          options?.force === true ? 'forced-refresh-token' : 'fresh-token',
      });
      generateImpl = async (_system, _tools, _history, options) => {
        authKeys.push(options?.auth?.apiKey ?? '<missing>');
        throw new APIStatusError(401, 'Unauthorized', 'req-401');
      };

      const events = ix.get(IModelResolver).resolve('m').request({
        systemPrompt: '',
        tools: [],
        messages: [],
      });
      await expect(async () => {
        for await (const _event of events) {
          void _event;
        }
      }).rejects.toMatchObject({
        code: 'provider.auth_error',
        name: 'APIStatusError',
        message: 'Unauthorized',
        details: {
          statusCode: 401,
          requestId: 'req-401',
        },
      });
      expect(authKeys).toEqual(['fresh-token', 'forced-refresh-token']);
    });

    it('translates a non-OAuth 401 into a coded provider error without OAuth replay', async () => {
      providers['p'] = { type: 'kimi', baseUrl: 'https://example.test/v1', apiKey: 'sk-test' };
      models['m'] = { provider: 'p', model: 'wire-name', maxContextSize: 1000 };
      generateImpl = async () => {
        throw new APIStatusError(401, 'Unauthorized', 'req-api-key-401');
      };

      const events = ix.get(IModelResolver).resolve('m').request({
        systemPrompt: '',
        tools: [],
        messages: [],
      });
      await expect(async () => {
        for await (const _event of events) {
          void _event;
        }
      }).rejects.toMatchObject({
        code: 'provider.auth_error',
        name: 'APIStatusError',
        details: { statusCode: 401, requestId: 'req-api-key-401' },
        cause: expect.objectContaining({
          name: 'APIStatusError',
          statusCode: 401,
          requestId: 'req-api-key-401',
        }),
      });
    });

    it('force-refreshes OAuth credentials and replays video upload after 401', async () => {
      configureOAuthModel();
      const tokenCalls: Array<boolean | undefined> = [];
      const authKeys: string[] = [];
      resolveTokenProvider.mockReturnValue({
        getAccessToken: async (options?: { readonly force?: boolean }) => {
          tokenCalls.push(options?.force);
          return options?.force === true ? 'forced-refresh-token' : 'fresh-token';
        },
      });
      uploadVideoImpl = async (_input, options) => {
        authKeys.push(options?.auth?.apiKey ?? '<missing>');
        if (authKeys.length === 1) {
          throw new APIStatusError(401, 'Unauthorized', 'req-upload-401');
        }
        return { type: 'video_url', videoUrl: { url: 'https://example.test/video' } };
      };

      const result = await ix.get(IModelResolver).resolve('m').uploadVideo?.('clip.mp4');

      expect(result).toEqual({
        type: 'video_url',
        videoUrl: { url: 'https://example.test/video' },
      });
      expect(authKeys).toEqual(['fresh-token', 'forced-refresh-token']);
      expect(tokenCalls).toEqual([undefined, true]);
    });
  });

  describe('provider headers', () => {
    it('passes provider customHeaders to protocol adapters as defaultHeaders', async () => {
      providers['p'] = {
        type: 'kimi',
        baseUrl: 'https://example.test/v1',
        apiKey: 'sk',
        customHeaders: { 'X-Test': '1' },
      };
      models['m'] = { provider: 'p', model: 'wire-name', maxContextSize: 1000 };

      const model = ix.get(IModelResolver).resolve('m');
      for await (const _event of model.request({ systemPrompt: '', tools: [], messages: [] })) {
        void _event;
      }

      expect(createdProtocolConfigs).toHaveLength(1);
      expect(createdProtocolConfigs[0]).toMatchObject({
        protocol: 'kimi',
        defaultHeaders: { 'X-Test': '1' },
      });
      expect(createdProtocolConfigs[0]).not.toHaveProperty('customHeaders');
    });

    it('merges KIMI_CODE_CUSTOM_HEADERS env headers below provider customHeaders', async () => {
      process.env['KIMI_CODE_CUSTOM_HEADERS'] = 'X-Env: env-val\nX-Shared: from-env';
      try {
        providers['p'] = {
          type: 'kimi',
          baseUrl: 'https://example.test/v1',
          apiKey: 'sk',
          customHeaders: { 'X-Shared': 'from-provider', 'X-Provider': 'p' },
        };
        models['m'] = { provider: 'p', model: 'wire-name', maxContextSize: 1000 };

        const model = ix.get(IModelResolver).resolve('m');
        for await (const _event of model.request({ systemPrompt: '', tools: [], messages: [] })) {
          void _event;
        }

        expect(createdProtocolConfigs).toHaveLength(1);
        expect(createdProtocolConfigs[0]).toMatchObject({
          defaultHeaders: {
            'X-Env': 'env-val',
            'X-Shared': 'from-provider',
            'X-Provider': 'p',
          },
        });
      } finally {
        delete process.env['KIMI_CODE_CUSTOM_HEADERS'];
      }
    });

    it('resolveOutboundHeaders: kimi provider gets full host headers, others get only User-Agent', () => {
      const saved = process.env['KIMI_CODE_CUSTOM_HEADERS'];
      delete process.env['KIMI_CODE_CUSTOM_HEADERS'];
      try {
        const host = { 'User-Agent': 'kimi-code-cli/1.0', 'X-Msh-Device-Id': 'dev' };

        expect(resolveOutboundHeaders('kimi', undefined, host)).toEqual({
          'User-Agent': 'kimi-code-cli/1.0',
          'X-Msh-Device-Id': 'dev',
        });
        expect(resolveOutboundHeaders('openai', undefined, host)).toEqual({
          'User-Agent': 'kimi-code-cli/1.0',
        });
        expect(resolveOutboundHeaders('anthropic', undefined, host)).toEqual({
          'User-Agent': 'kimi-code-cli/1.0',
        });
        expect(resolveOutboundHeaders('kimi', { 'User-Agent': 'custom' }, host)).toEqual({
          'User-Agent': 'custom',
          'X-Msh-Device-Id': 'dev',
        });
      } finally {
        if (saved === undefined) delete process.env['KIMI_CODE_CUSTOM_HEADERS'];
        else process.env['KIMI_CODE_CUSTOM_HEADERS'] = saved;
      }
    });
  });

  describe('provider options', () => {
    it('passes an OpenAI reasoningKey through to the protocol adapter', async () => {
      providers['p'] = { type: 'openai', baseUrl: 'https://example.test/v1', apiKey: 'sk' };
      models['m'] = {
        provider: 'p',
        model: 'deepseek-v4-flash',
        maxContextSize: 1000,
        reasoningKey: ' reasoning_content ',
      };

      const config = await resolveAndCreateProvider();

      expect(config).toMatchObject({
        protocol: 'openai',
        providerOptions: { reasoningKey: 'reasoning_content' },
      });
    });

    it('passes Anthropic max-output and thinking knobs through to the protocol adapter', async () => {
      providers['p'] = { type: 'anthropic', baseUrl: 'https://example.test/v1', apiKey: 'sk' };
      models['m'] = {
        provider: 'p',
        model: 'claude-opus-4-7',
        maxContextSize: 200000,
        maxOutputSize: 24000,
        adaptiveThinking: false,
        betaApi: true,
      };

      const config = await resolveAndCreateProvider();

      expect(config).toMatchObject({
        protocol: 'anthropic',
        providerOptions: {
          defaultMaxTokens: 24000,
          adaptiveThinking: false,
          betaApi: true,
        },
      });
    });

    it('passes Anthropic metadata through to the protocol adapter', async () => {
      providers['p'] = { type: 'anthropic', baseUrl: 'https://example.test/v1', apiKey: 'sk' };
      models['m'] = {
        provider: 'p',
        model: 'claude-sonnet-4-5',
        maxContextSize: 200000,
      };

      const model = ix.get(IModelResolver).resolve('m').withProviderOptions({
        metadata: { user_id: 'session-test' },
      });
      for await (const _event of model.request({ systemPrompt: '', tools: [], messages: [] })) {
        void _event;
      }

      expect(createdProtocolConfigs).toHaveLength(1);
      expect(createdProtocolConfigs[0]).toMatchObject({
        protocol: 'anthropic',
        providerOptions: { metadata: { user_id: 'session-test' } },
      });
    });

    it('passes Kimi supportEfforts through to the protocol adapter', async () => {
      providers['p'] = { type: 'kimi', baseUrl: 'https://example.test/v1', apiKey: 'sk' };
      models['m'] = {
        provider: 'p',
        model: 'kimi-for-coding',
        maxContextSize: 1000,
        supportEfforts: ['low', 'high', 'max'],
      };

      const config = await resolveAndCreateProvider();

      expect(config).toMatchObject({
        protocol: 'kimi',
        providerOptions: { supportEfforts: ['low', 'high', 'max'] },
      });
    });

    it('passes overridden Kimi supportEfforts through to the protocol adapter', async () => {
      providers['p'] = { type: 'kimi', baseUrl: 'https://example.test/v1', apiKey: 'sk' };
      models['m'] = {
        provider: 'p',
        model: 'kimi-for-coding',
        maxContextSize: 1000,
        supportEfforts: ['low', 'high', 'max'],
        overrides: { supportEfforts: ['low', 'high'] },
      };

      const config = await resolveAndCreateProvider();

      expect(config).toMatchObject({
        protocol: 'kimi',
        providerOptions: { supportEfforts: ['low', 'high'] },
      });
    });

    it('passes Vertex service-account options and derives location from the baseUrl', async () => {
      providers['p'] = {
        type: 'vertexai',
        baseUrl: 'https://us-central1-aiplatform.googleapis.com',
        env: { GOOGLE_CLOUD_PROJECT: 'my-project' },
      };
      models['m'] = {
        provider: 'p',
        model: 'gemini-1.5-pro',
        maxContextSize: 1000000,
      };

      const config = await resolveAndCreateProvider();

      expect(config).toMatchObject({
        protocol: 'vertexai',
        baseUrl: 'https://us-central1-aiplatform.googleapis.com',
        providerOptions: {
          vertexai: true,
          project: 'my-project',
          location: 'us-central1',
        },
      });
    });

    it('uses GOOGLE_VERTEX_BASE_URL as the structured Vertex provider baseUrl fallback', async () => {
      providers['p'] = {
        type: 'vertexai',
        env: {
          GOOGLE_CLOUD_PROJECT: 'my-project',
          GOOGLE_VERTEX_BASE_URL: 'https://europe-west4-aiplatform.googleapis.com',
        },
      };
      models['m'] = {
        provider: 'p',
        model: 'gemini-1.5-pro',
        maxContextSize: 1000000,
      };

      const config = await resolveAndCreateProvider();

      expect(config).toMatchObject({
        protocol: 'vertexai',
        baseUrl: 'https://europe-west4-aiplatform.googleapis.com',
        providerOptions: {
          vertexai: true,
          project: 'my-project',
          location: 'europe-west4',
        },
      });
    });
  });

  describe('capabilities', () => {
    it('merges every declared capability with the model context window', () => {
      providers['p'] = { type: 'kimi', baseUrl: 'https://example.test/v1', apiKey: 'sk' };
      models['m'] = {
        provider: 'p',
        model: 'wire-name',
        maxContextSize: 1000,
        capabilities: ['audio_in', 'thinking', 'always_thinking'],
      };

      expect(ix.get(IModelResolver).resolve('m').capabilities).toEqual({
        image_in: false,
        video_in: false,
        audio_in: true,
        thinking: true,
        tool_use: false,
        max_context_tokens: 1000,
        select_tools: false,
      });
    });

    it('detects catalogued provider/model capabilities like v1 ProviderManager', () => {
      providers['p'] = { type: 'openai', baseUrl: 'https://example.test/v1', apiKey: 'sk' };
      models['m'] = { provider: 'p', model: 'gpt-4o', maxContextSize: 128000 };

      expect(ix.get(IModelResolver).resolve('m').capabilities).toEqual({
        image_in: true,
        video_in: false,
        audio_in: false,
        thinking: false,
        tool_use: true,
        max_context_tokens: 128000,
        select_tools: false,
      });
    });
  });

  describe('default thinking', () => {
    function resolveEffort(capabilities?: string[]): string | null {
      providers['p'] = { type: 'kimi', baseUrl: 'https://example.test/v1', apiKey: 'sk' };
      models['m'] = {
        provider: 'p',
        model: 'wire-name',
        maxContextSize: 1000,
        ...(capabilities === undefined ? {} : { capabilities }),
      };
      return ix.get(IModelResolver).resolve('m').thinkingEffort;
    }

    it('defaults to off when the model does not declare thinking support', () => {
      expect(resolveEffort()).toBeNull();
    });

    it('defaults to boolean on when the model supports thinking without named efforts', () => {
      expect(resolveEffort(['thinking'])).toBe('on');
    });

    it('uses the model default effort when configured', () => {
      providers['p'] = { type: 'kimi', baseUrl: 'https://example.test/v1', apiKey: 'sk' };
      models['m'] = {
        provider: 'p',
        model: 'wire-name',
        maxContextSize: 1000,
        capabilities: ['thinking'],
        supportEfforts: ['low', 'medium', 'max'],
        defaultEffort: 'max',
      };

      expect(ix.get(IModelResolver).resolve('m').thinkingEffort).toBe('max');
    });

    it('uses the middle supported effort when no model default effort is configured', () => {
      providers['p'] = { type: 'kimi', baseUrl: 'https://example.test/v1', apiKey: 'sk' };
      models['m'] = {
        provider: 'p',
        model: 'wire-name',
        maxContextSize: 1000,
        capabilities: ['thinking'],
        supportEfforts: ['low', 'medium', 'max'],
      };

      expect(ix.get(IModelResolver).resolve('m').thinkingEffort).toBe('medium');
    });

    it('is off (null) when thinking.enabled is false', () => {
      configValues['thinking'] = { enabled: false };
      expect(resolveEffort()).toBeNull();
    });

    it('uses the configured thinking.effort', () => {
      configValues['thinking'] = { effort: 'medium' };
      expect(resolveEffort()).toBe('medium');
    });

    it('clamps an explicit off back to on for always_thinking models', () => {
      configValues['thinking'] = { enabled: false };
      expect(resolveEffort(['always_thinking'])).toBe('on');
    });
  });

  describe('baseUrl normalization', () => {
    it.each([
      ['kimi', 'KIMI_BASE_URL'],
      ['openai', 'OPENAI_BASE_URL'],
      ['openai_responses', 'OPENAI_BASE_URL'],
      ['anthropic', 'ANTHROPIC_BASE_URL'],
      ['google-genai', 'GOOGLE_GEMINI_BASE_URL'],
    ] as const)('uses %s provider env baseUrl fallback', (type, key) => {
      providers['p'] = {
        type,
        apiKey: 'sk',
        env: { [key]: `https://${type}.example.test/v1` },
      };
      models['m'] = { provider: 'p', model: 'wire-name', maxContextSize: 1000 };

      expect(ix.get(IModelResolver).resolve('m').baseUrl).toBe(
        `https://${type}.example.test/v1`,
      );
    });

    it('falls through an empty provider baseUrl to the provider env fallback', () => {
      providers['p'] = {
        type: 'kimi',
        baseUrl: '  ',
        apiKey: 'sk',
        env: { KIMI_BASE_URL: 'https://kimi-env.example.test/v1' },
      };
      models['m'] = { provider: 'p', model: 'wire-name', maxContextSize: 1000 };

      expect(ix.get(IModelResolver).resolve('m').baseUrl).toBe(
        'https://kimi-env.example.test/v1',
      );
    });

    function resolveBaseUrl(
      protocol: string,
      providerType: string,
      baseUrl: string,
    ): string | undefined {
      providers['p'] = { type: providerType, baseUrl, apiKey: 'sk' } as ProviderConfig;
      models['m'] = { provider: 'p', model: 'wire-name', maxContextSize: 1000, protocol } as ModelConfig;
      return ix.get(IModelResolver).resolve('m').baseUrl;
    }

    it('strips a trailing /v1 for the anthropic protocol', () => {
      expect(resolveBaseUrl('anthropic', 'kimi', 'https://example.test/coding/v1')).toBe(
        'https://example.test/coding',
      );
    });

    it('strips a trailing /v1/ (with slash) for the anthropic protocol', () => {
      expect(resolveBaseUrl('anthropic', 'kimi', 'https://example.test/coding/v1/')).toBe(
        'https://example.test/coding',
      );
    });

    it('does not strip /v1 from a native Anthropic provider when model.protocol is unset', () => {
      providers['p'] = {
        type: 'anthropic',
        baseUrl: 'https://api.anthropic.example/v1',
        apiKey: 'sk',
      };
      models['m'] = { provider: 'p', model: 'claude-sonnet', maxContextSize: 200000 };

      expect(ix.get(IModelResolver).resolve('m').baseUrl).toBe(
        'https://api.anthropic.example/v1',
      );
    });

    it('does not strip /v1 for non-anthropic protocols', () => {
      expect(resolveBaseUrl('kimi', 'kimi', 'https://example.test/coding/v1')).toBe(
        'https://example.test/coding/v1',
      );
    });

    it.each(['anthropic', 'openai', 'openai_responses', 'kimi', 'google-genai'] as const)(
      'resolves a %s provider without base_url to an undefined baseUrl (protocol default applies)',
      (type) => {
        providers['p'] = { type, apiKey: 'sk' };
        models['m'] = { provider: 'p', model: 'wire-name', maxContextSize: 1000 };

        expect(ix.get(IModelResolver).resolve('m').baseUrl).toBeUndefined();
      },
    );

    it('resolves an anthropic-protocol override without base_url without stripping', () => {
      providers['p'] = { type: 'kimi', apiKey: 'sk' };
      models['m'] = {
        provider: 'p',
        model: 'wire-name',
        maxContextSize: 1000,
        protocol: 'anthropic',
      };

      expect(ix.get(IModelResolver).resolve('m').baseUrl).toBeUndefined();
    });

    it('still rejects a flat model with neither providerId nor baseUrl', () => {
      models['m'] = { model: 'wire-name', maxContextSize: 1000 };

      expect(() => ix.get(IModelResolver).resolve('m')).toThrow(
        'Model "m" must set either providerId or baseUrl in config.toml.',
      );
    });
  });
});

const fakeChatProvider: ChatProvider = {
  name: 'fake',
  modelName: 'wire-name',
  thinkingEffort: null,
  generate(systemPrompt, tools, history, options) {
    return generateImpl(systemPrompt, tools, history, options);
  },
  uploadVideo(input, options) {
    if (uploadVideoImpl === undefined) throw new Error('uploadVideo not configured');
    return uploadVideoImpl(input, options);
  },
  withThinking() {
    return this;
  },
};

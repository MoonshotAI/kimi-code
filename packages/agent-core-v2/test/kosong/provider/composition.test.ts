/**
 * `kosong/provider` composition probes — the runtime invariants of the L2
 * layer, exercised through the real registry path with every base contrib and
 * the Kimi + canonical-vendor endpoint definitions registered:
 *
 *  1. Composing Kimi without a config apiKey and without env vars must NOT
 *     silently pick up `OPENAI_API_KEY` (the `apiKey ?? ''` suppression in
 *     the openai contrib factory).
 *  2. Config `defaultHeaders` always win over trait-declared headers (the
 *     trailing synthetic trait).
 *  4. `supportedProtocols()` is derived from the registered bases and never
 *     contains `kimi` — a vendor is not a protocol. It does not contain
 *     `vertexai` either: Vertex AI is a `providerOptions` mode of the
 *     google-genai base, exercised below (flag forwarding, and the
 *     `VERTEXAI_API_KEY` → `GOOGLE_API_KEY` endpoint chain the google-genai
 *     definition declares).
 *
 * Plus the registry resolution contract: `resolveAdapterIdentity` branches,
 * `resolveProviderBaseId`, the `resolveCapability` fallback chain, and the
 * composed-provider shape (`name` is the base's, `uploadVideo` is bound only
 * when a trait declares it).
 *
 * The final sections drive `generate` with mocked SDK clients and assert the
 * exact request params on the wire (the morph era asserted baked provider
 * state instead):
 *
 *  - the behavior probes for per-turn intent encoding (cacheKey / thinking /
 *     budget) on the Kimi, OpenAI, and Anthropic wires;
 *  - the per-base `responseFormat` encodings (re-added from the deleted
 *     llmProtocol structured-output suite; morph-seeded kwargs cases that no
 *     longer have a channel are noted where they dropped);
 *  - the Anthropic thinking-keep context-management overlay and max-tokens
 *     profile, and the OpenAI `reasoning_effort` auto-enable with its
 *     load-bearing kill switch (a `withThinking` hook disables it).
 *
 * Note: base/definition registries are module-level state shared across this
 * file, so the contribs and test-vendor definitions are imported/registered
 * exactly once here.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { isUnknownCapability, UNKNOWN_CAPABILITY } from '#/kosong/contract/capability';
import { APIConnectionError } from '#/kosong/contract/errors';
import type { Message } from '#/kosong/contract/message';
import type {
  ChatProvider,
  GenerateOptions,
  ResponseFormat,
  StreamedMessage,
} from '#/kosong/contract/provider';
import '#/kosong/provider/bases/anthropic/index';
import {
  AnthropicChatProvider,
  resolveDefaultMaxTokens,
} from '#/kosong/provider/bases/anthropic/anthropic';
import '#/kosong/provider/bases/google-genai/index';
import { GoogleGenAIChatProvider } from '#/kosong/provider/bases/google-genai/google-genai';
import '#/kosong/provider/bases/openai/index';
import { OpenAIResponsesChatProvider } from '#/kosong/provider/bases/openai/openai-responses';
import { OpenAILegacyChatProvider } from '#/kosong/provider/bases/openai/openai-legacy';
import { ProtocolAdapterRegistry } from '#/kosong/provider/protocolAdapterRegistry';
import {
  getProviderDefinition,
  getProviderDefinitions,
  hasProviderDefinition,
  registerProviderDefinition,
  resolveProviderEndpoint,
} from '#/kosong/provider/providerDefinition';
import '#/kosong/provider/providers/kimi/kimi.contrib';
import '#/kosong/provider/providers/standard.contrib';

registerProviderDefinition({
  id: 'header-vendor',
  baseProtocol: 'openai',
  traits: [
    {
      defaultHeaders: () => ({ 'x-shared': 'trait', 'x-trait-only': 'trait' }),
    },
  ],
});

registerProviderDefinition({
  id: 'cap-vendor',
  baseProtocol: 'openai',
  traits: [
    {
      capability: (modelName) =>
        modelName === 'special-model'
          ? {
              image_in: true,
              video_in: false,
              audio_in: false,
              thinking: false,
              tool_use: true,
              max_context_tokens: 0,
            }
          : undefined,
    },
  ],
});

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

const registry = new ProtocolAdapterRegistry();

describe('supportedProtocols (probe 4)', () => {
  it('is derived from the registered bases and contains neither kimi nor vertexai', () => {
    const protocols = registry.supportedProtocols();
    expect(protocols).toHaveLength(4);
    expect([...protocols].toSorted()).toEqual(
      ['anthropic', 'google-genai', 'openai', 'openai_responses'].toSorted(),
    );
    // A vendor is not a protocol, and Vertex AI is a providerOptions mode of
    // the google-genai base — neither may appear here.
    expect(protocols).not.toContain('kimi');
    expect(protocols).not.toContain('vertexai');
  });
});

describe('apiKey env suppression (probe 1)', () => {
  it('does not pick up OPENAI_API_KEY when composing kimi without any key', async () => {
    const provider = registry.createChatProvider({
      protocol: 'openai',
      providerType: 'kimi',
      modelName: 'kimi-k2',
    });
    await expect(provider.generate('sys', [], [])).rejects.toThrow(/apiKey is required/);

    // Even with a stray OPENAI_API_KEY in the environment, the composed Kimi
    // provider must not silently use it.
    process.env['OPENAI_API_KEY'] = 'sk-openai-must-not-leak';
    const withStrayEnv = registry.createChatProvider({
      protocol: 'openai',
      providerType: 'kimi',
      modelName: 'kimi-k2',
    });
    await expect(withStrayEnv.generate('sys', [], [])).rejects.toThrow(/apiKey is required/);
  });

  it('uses the KIMI_API_KEY env fallback when composing kimi', () => {
    process.env['KIMI_API_KEY'] = 'sk-kimi-from-env';
    process.env['OPENAI_API_KEY'] = 'sk-openai-must-not-win';
    const provider = registry.createChatProvider({
      protocol: 'openai',
      providerType: 'kimi',
      modelName: 'kimi-k2',
    });
    const apiKey = (provider as unknown as { _apiKey?: string })._apiKey;
    expect(apiKey).toBe('sk-kimi-from-env');
  });

  it('keeps the base env fallback for plain openai (no endpoint declared)', async () => {
    const noKey = registry.createChatProvider({ protocol: 'openai', modelName: 'gpt-4o' });
    await expect(noKey.generate('sys', [], [])).rejects.toThrow(/apiKey is required/);

    process.env['OPENAI_API_KEY'] = 'sk-openai-env';
    const withKey = registry.createChatProvider({
      protocol: 'openai',
      modelName: 'gpt-4o',
      baseUrl: 'http://127.0.0.1:9/v1',
    });
    // The request is attempted (key found via the base default) and fails on
    // the connection — not on a missing key.
    await expect(withKey.generate('sys', [], [])).rejects.toThrow(APIConnectionError);
  });

  it('prefers an explicit config apiKey over the env chain', () => {
    process.env['KIMI_API_KEY'] = 'sk-kimi-from-env';
    const provider = registry.createChatProvider({
      protocol: 'openai',
      providerType: 'kimi',
      modelName: 'kimi-k2',
      apiKey: 'sk-explicit-config',
    });
    const apiKey = (provider as unknown as { _apiKey?: string })._apiKey;
    expect(apiKey).toBe('sk-explicit-config');
  });
});

describe('config defaultHeaders win (probe 2)', () => {
  it('merges trait headers under config headers via the trailing synthetic trait', () => {
    const provider = registry.createChatProvider({
      protocol: 'openai',
      providerType: 'header-vendor',
      modelName: 'm',
      defaultHeaders: { 'x-shared': 'config', 'x-config-only': 'config' },
    });
    const headers = (provider as unknown as { _defaultHeaders?: Record<string, string> })
      ._defaultHeaders;
    expect(headers).toEqual({
      'x-shared': 'config',
      'x-trait-only': 'trait',
      'x-config-only': 'config',
    });
  });

  it('passes trait headers through when no config headers are set', () => {
    const provider = registry.createChatProvider({
      protocol: 'openai',
      providerType: 'header-vendor',
      modelName: 'm',
    });
    const headers = (provider as unknown as { _defaultHeaders?: Record<string, string> })
      ._defaultHeaders;
    expect(headers).toEqual({ 'x-shared': 'trait', 'x-trait-only': 'trait' });
  });
});

describe('resolveAdapterIdentity', () => {
  it('resolves the (kimi, openai) pair registration: its traits plus the trailing synthetic trait', () => {
    const identity = registry.resolveAdapterIdentity('openai', 'kimi');
    expect(identity.baseId).toBe('openai');
    expect(identity.traits).toHaveLength(2); // 1 vendor trait + synthetic
  });

  it('resolves the (kimi, anthropic) pair registration: only its own traits', () => {
    const identity = registry.resolveAdapterIdentity('anthropic', 'kimi');
    expect(identity.baseId).toBe('anthropic');
    expect(identity.traits).toHaveLength(2); // 1 pair trait + synthetic
  });

  it('resolves an unregistered (vendor, protocol) pair to no vendor traits', () => {
    // Kimi registers no google-genai definition — the pair contributes nothing.
    const identity = registry.resolveAdapterIdentity('google-genai', 'kimi');
    expect(identity.baseId).toBe('google-genai');
    expect(identity.traits).toHaveLength(1); // synthetic only
  });

  it('resolves the unregistered-vendor branch: protocol itself as base, no vendor traits', () => {
    const identity = registry.resolveAdapterIdentity('openai', 'no-such-vendor');
    expect(identity.baseId).toBe('openai');
    expect(identity.traits).toHaveLength(1); // synthetic only
  });

  it('resolves the no-providerType branch identically', () => {
    const identity = registry.resolveAdapterIdentity('openai');
    expect(identity.baseId).toBe('openai');
    expect(identity.traits).toHaveLength(1);
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
  it('lets the definition win outright — kimi is UNKNOWN even though the base knows gpt models', () => {
    expect(registry.resolveCapability('openai', 'gpt-4o', 'kimi')).toBe(UNKNOWN_CAPABILITY);
  });

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
});

describe('explainCapability', () => {
  it('reports the definition level when the pair declares a capability', () => {
    const { capability, source } = registry.explainCapability('openai', 'gpt-4o', 'kimi');
    expect(capability).toBe(UNKNOWN_CAPABILITY);
    expect(source.kind).toBe('builtin');
    expect(source.detail).toContain("'kimi'");
  });

  it('reports the trait level when a trait hook answers', () => {
    const { capability, source } = registry.explainCapability('openai', 'special-model', 'cap-vendor');
    expect(capability.image_in).toBe(true);
    expect(source.kind).toBe('builtin');
    expect(source.detail).toContain('trait');
  });

  it('reports the base catalog level', () => {
    const { capability, source } = registry.explainCapability('openai', 'gpt-4o');
    expect(capability.image_in).toBe(true);
    expect(source.kind).toBe('builtin');
    expect(source.detail).toContain('base');
  });

  it('reports none when nothing knows the model', () => {
    const { capability, source } = registry.explainCapability('openai', 'mystery-model');
    expect(isUnknownCapability(capability)).toBe(true);
    expect(source.kind).toBe('none');
  });
});

describe('createChatProvider', () => {
  it('composes kimi as the openai base with the upload capability bound', () => {
    const provider = registry.createChatProvider({
      protocol: 'openai',
      providerType: 'kimi',
      modelName: 'kimi-k2',
    });
    // The composed provider's name is the base's — there is no vendor name.
    expect(provider.name).toBe('openai');
    expect(provider.modelName).toBe('kimi-k2');
    expect(typeof provider.uploadVideo).toBe('function');
  });

  it('composes plain openai without the upload capability', () => {
    const provider = registry.createChatProvider({ protocol: 'openai', modelName: 'gpt-4o' });
    expect(provider.name).toBe('openai');
    expect(provider.uploadVideo).toBeUndefined();
  });
});

describe('google-genai vertex mode (providerOptions)', () => {
  it('forwards vertexai + project + location from providerOptions to the base', () => {
    const provider = registry.createChatProvider({
      protocol: 'google-genai',
      modelName: 'gemini-2.5-flash',
      providerOptions: { vertexai: true, project: 'my-project', location: 'us-central1' },
    });
    expect(provider.name).toBe('google_genai');
    expect(Reflect.get(provider, '_vertexai')).toBe(true);
    expect(Reflect.get(provider, '_project')).toBe('my-project');
    expect(Reflect.get(provider, '_location')).toBe('us-central1');
  });

  it('stays in plain Gemini mode without the providerOptions flag', () => {
    const provider = registry.createChatProvider({
      protocol: 'google-genai',
      modelName: 'gemini-2.5-flash',
      apiKey: 'sk-probe',
    });
    expect(Reflect.get(provider, '_vertexai')).toBe(false);
    expect(Reflect.get(provider, '_project')).toBeUndefined();
    expect(Reflect.get(provider, '_location')).toBeUndefined();
  });

  it('prefers VERTEXAI_API_KEY over GOOGLE_API_KEY through the definition endpoint chain', () => {
    process.env['VERTEXAI_API_KEY'] = 'vertex-env-key';
    process.env['GOOGLE_API_KEY'] = 'google-env-key';
    const provider = registry.createChatProvider({
      protocol: 'google-genai',
      providerType: 'google-genai',
      modelName: 'gemini-2.5-flash',
    });
    expect(Reflect.get(provider, '_apiKey')).toBe('vertex-env-key');
  });

  it('falls back to GOOGLE_API_KEY when no vertex key is set', () => {
    process.env['GOOGLE_API_KEY'] = 'google-env-key';
    const provider = registry.createChatProvider({
      protocol: 'google-genai',
      providerType: 'google-genai',
      modelName: 'gemini-2.5-flash',
    });
    expect(Reflect.get(provider, '_apiKey')).toBe('google-env-key');
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
    expect(native?.baseProtocol).toBe('openai');
    expect(native?.traits).toHaveLength(1);
    expect(anthropic?.baseProtocol).toBe('anthropic');
    expect(anthropic?.traits).toHaveLength(1);
    for (const definition of [native, anthropic]) {
      expect(definition?.endpoint).toEqual({
        apiKeyEnv: 'KIMI_API_KEY',
        baseUrlEnv: 'KIMI_BASE_URL',
        defaultBaseUrl: 'https://api.moonshot.ai/v1',
      });
      expect(definition?.hostHeaders).toBe('full');
      expect(definition?.modelSource).toBe('oauth-catalog');
      expect(definition?.capability).toBe(UNKNOWN_CAPABILITY);
    }
  });

  it('answers id-level queries and reports unregistered pairs', () => {
    // The id-level view is the first registration; vendor-level facts are
    // identical on both, so any of them answers an id-level query.
    expect(getProviderDefinition('kimi')?.baseProtocol).toBe('openai');
    expect(getProviderDefinitions('kimi')).toHaveLength(2);
    expect(hasProviderDefinition('kimi')).toBe(true);
    expect(hasProviderDefinition('no-such-vendor')).toBe(false);
    expect(getProviderDefinition('kimi', 'google-genai')).toBeUndefined();
  });

  it('allows the same id on several protocols but rejects a duplicate (id, baseProtocol) pair', () => {
    registerProviderDefinition({ id: 'pair-vendor', baseProtocol: 'openai', traits: [] });
    registerProviderDefinition({ id: 'pair-vendor', baseProtocol: 'anthropic', traits: [] });
    expect(getProviderDefinition('pair-vendor', 'openai')).toBeDefined();
    expect(getProviderDefinition('pair-vendor', 'anthropic')).toBeDefined();
    expect(() =>
      registerProviderDefinition({ id: 'pair-vendor', baseProtocol: 'openai', traits: [] }),
    ).toThrow(/already registered/);
    expect(() =>
      registerProviderDefinition({ id: 'kimi', baseProtocol: 'openai', traits: [] }),
    ).toThrow(/already registered/);
  });
});

// ---------------------------------------------------------------------------
// Wire-body probes: drive `generate` with a mocked SDK client and assert the
// exact params the base would send. Registry-composed providers always
// stream, so the mocks answer minimal valid streams; directly constructed
// bases use `stream: false` and answer plain responses.
// ---------------------------------------------------------------------------

const PROBE_HISTORY: Message[] = [
  { role: 'user', content: [{ type: 'text', text: 'Hi' }], toolCalls: [] },
];

const THINK_HISTORY: Message[] = [
  {
    role: 'assistant',
    content: [{ type: 'think', think: 'earlier reasoning' }],
    toolCalls: [],
  },
  { role: 'user', content: [{ type: 'text', text: 'Hi' }], toolCalls: [] },
];

async function drain(stream: StreamedMessage): Promise<void> {
  for await (const part of stream) void part;
}

function sdkClient(provider: ChatProvider): unknown {
  return Reflect.get(provider, '_client');
}

function isStreaming(provider: ChatProvider): boolean {
  return (Reflect.get(provider, '_stream') as boolean | undefined) !== false;
}

async function* openAIChunkStream(): AsyncIterable<unknown> {
  yield {
    id: 'chatcmpl-probe',
    choices: [{ index: 0, delta: { content: 'Hello' }, finish_reason: 'stop' }],
    usage: { prompt_tokens: 3, completion_tokens: 1, total_tokens: 4 },
  };
}

function chatCompletionResponse(): Record<string, unknown> {
  return {
    id: 'chatcmpl-probe',
    object: 'chat.completion',
    created: 1,
    model: 'probe',
    choices: [
      { index: 0, message: { role: 'assistant', content: 'Hello' }, finish_reason: 'stop' },
    ],
    usage: { prompt_tokens: 3, completion_tokens: 1, total_tokens: 4 },
  };
}

async function* anthropicEventStream(): AsyncIterable<unknown> {
  yield {
    type: 'message_start',
    message: { id: 'msg_probe', usage: { input_tokens: 3, output_tokens: 1 } },
  };
  yield { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } };
  yield { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Hello' } };
  yield { type: 'content_block_stop', index: 0 };
  yield { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 1 } };
}

function anthropicMessageResponse(): Record<string, unknown> {
  return {
    id: 'msg_probe',
    type: 'message',
    role: 'assistant',
    model: 'probe',
    content: [{ type: 'text', text: 'Hello' }],
    stop_reason: 'end_turn',
    usage: { input_tokens: 3, output_tokens: 1 },
  };
}

async function* responsesEventStream(): AsyncIterable<unknown> {
  yield { type: 'response.created', response: { id: 'resp_probe' } };
  yield { type: 'response.output_text.delta', delta: 'Hello' };
  yield {
    type: 'response.completed',
    response: {
      id: 'resp_probe',
      status: 'completed',
      usage: { input_tokens: 3, output_tokens: 1, total_tokens: 4 },
    },
  };
}

async function captureOpenAIBody(
  provider: ChatProvider,
  options?: GenerateOptions,
  history: Message[] = PROBE_HISTORY,
): Promise<Record<string, unknown>> {
  let captured: Record<string, unknown> | undefined;
  const client = sdkClient(provider) as { chat: { completions: { create: unknown } } };
  client.chat.completions.create = vi.fn().mockImplementation((params: unknown) => {
    captured = params as Record<string, unknown>;
    return {
      withResponse: () =>
        Promise.resolve({
          data: isStreaming(provider) ? openAIChunkStream() : chatCompletionResponse(),
          response: { headers: new Headers() },
        }),
    };
  });
  await drain(await provider.generate('', [], history, options));
  if (captured === undefined) throw new Error('expected chat.completions.create to be called');
  return captured;
}

async function captureAnthropicBody(
  provider: ChatProvider,
  options?: GenerateOptions,
): Promise<{
  readonly params: Record<string, unknown>;
  readonly requestOptions: Record<string, unknown> | undefined;
  readonly via: 'beta' | 'standard';
}> {
  let capturedParams: Record<string, unknown> | undefined;
  let capturedRequestOptions: Record<string, unknown> | undefined;
  let via: 'beta' | 'standard' | undefined;
  const client = sdkClient(provider) as {
    messages: { create: unknown };
    beta: { messages: { create: unknown } };
  };
  const create = (channel: 'beta' | 'standard') =>
    vi.fn().mockImplementation((params: unknown, requestOptions: unknown) => {
      via = channel;
      capturedParams = params as Record<string, unknown>;
      capturedRequestOptions = requestOptions as Record<string, unknown> | undefined;
      return Promise.resolve(
        isStreaming(provider) ? anthropicEventStream() : anthropicMessageResponse(),
      );
    });
  client.messages.create = create('standard');
  client.beta.messages.create = create('beta');
  await drain(await provider.generate('', [], PROBE_HISTORY, options));
  if (capturedParams === undefined || via === undefined) {
    throw new Error('expected messages.create to be called');
  }
  return { params: capturedParams, requestOptions: capturedRequestOptions, via };
}

async function captureGoogleBody(
  provider: ChatProvider,
  options?: GenerateOptions,
): Promise<Record<string, unknown>> {
  let captured: Record<string, unknown> | undefined;
  const client = sdkClient(provider) as { models: { generateContent: unknown } };
  client.models.generateContent = vi.fn().mockImplementation((params: unknown) => {
    captured = params as Record<string, unknown>;
    return Promise.resolve({
      candidates: [
        { content: { parts: [{ text: 'Hello' }], role: 'model' }, finishReason: 'STOP' },
      ],
      usageMetadata: { promptTokenCount: 3, candidatesTokenCount: 1, totalTokenCount: 4 },
      modelVersion: 'probe',
    });
  });
  await drain(await provider.generate('', [], PROBE_HISTORY, options));
  if (captured === undefined) throw new Error('expected models.generateContent to be called');
  return captured;
}

async function captureResponsesBody(
  provider: ChatProvider,
  options?: GenerateOptions,
): Promise<Record<string, unknown>> {
  let captured: Record<string, unknown> | undefined;
  const client = sdkClient(provider) as { responses: { create: unknown } };
  client.responses.create = vi.fn().mockImplementation((params: unknown) => {
    captured = params as Record<string, unknown>;
    return Promise.resolve(responsesEventStream());
  });
  await drain(await provider.generate('', [], PROBE_HISTORY, options));
  if (captured === undefined) throw new Error('expected responses.create to be called');
  return captured;
}

describe('per-turn intent wire encoding (behavior probes)', () => {
  it('encodes cacheKey + thinking + budget on the Kimi wire as prompt_cache_key + expanded thinking, never reasoning_effort', async () => {
    const provider = registry.createChatProvider({
      protocol: 'openai',
      providerType: 'kimi',
      modelName: 'kimi-k2',
      apiKey: 'sk-probe',
    });

    const body = await captureOpenAIBody(provider, {
      cacheKey: 'session-probe',
      thinking: { effort: 'high', keep: 'all' },
      maxCompletionTokens: 5000,
    });

    expect(body['prompt_cache_key']).toBe('session-probe');
    // kimiOpenAITrait.buildParams expands extra_body into the top-level params.
    expect(body['thinking']).toEqual({ type: 'enabled', effort: 'high', keep: 'all' });
    expect(body).not.toHaveProperty('extra_body');
    // The Kimi trait takes over the token field (no max_tokens backfill left).
    expect(body['max_completion_tokens']).toBe(5000);
    expect(body).not.toHaveProperty('max_tokens');
    // A trait took thinking over — the base must not add reasoning_effort.
    expect(body).not.toHaveProperty('reasoning_effort');
  });

  it('encodes cacheKey on plain OpenAI as the native prompt_cache_key', async () => {
    const provider = registry.createChatProvider({
      protocol: 'openai',
      modelName: 'gpt-4o',
      apiKey: 'sk-probe',
    });

    const body = await captureOpenAIBody(provider, { cacheKey: 'session-probe' });

    expect(body['prompt_cache_key']).toBe('session-probe');
  });

  it('encodes cacheKey on Anthropic as metadata.user_id', async () => {
    const provider = registry.createChatProvider({
      protocol: 'anthropic',
      modelName: 'claude-opus-4-6',
      apiKey: 'sk-probe',
    });

    const { params, via } = await captureAnthropicBody(provider, { cacheKey: 'session-probe' });

    expect(via).toBe('standard');
    expect(params['metadata']).toEqual({ user_id: 'session-probe' });
  });

  it('encodes thinking for Kimi over the Anthropic transport through the pair trait only', async () => {
    const provider = registry.createChatProvider({
      protocol: 'anthropic',
      providerType: 'kimi',
      modelName: 'kimi-for-coding',
      apiKey: 'sk-probe',
    });

    const { params, requestOptions, via } = await captureAnthropicBody(provider, {
      thinking: { effort: 'high' },
    });

    expect(via).toBe('standard');
    expect(params['thinking']).toEqual({ type: 'enabled' });
    expect(params['output_config']).toEqual({ effort: 'high' });
    // The (kimi, anthropic) trait strips the interleaved-thinking beta and
    // adds nothing else: no beta header reaches the wire at all.
    expect(requestOptions).toBeUndefined();
  });
});

const CONTACT_SCHEMA = {
  type: 'object',
  properties: { name: { type: 'string' } },
  required: ['name'],
  additionalProperties: false,
};

const JSON_SCHEMA_FORMAT: ResponseFormat = {
  type: 'json_schema',
  jsonSchema: { name: 'contact', schema: CONTACT_SCHEMA, strict: true },
};

describe('responseFormat wire encoding (per base)', () => {
  it('maps json_schema to the OpenAI Chat Completions response_format', async () => {
    const provider = new OpenAILegacyChatProvider({
      model: 'gpt-4.1',
      apiKey: 'sk-probe',
      stream: false,
    });

    const body = await captureOpenAIBody(provider, { responseFormat: JSON_SCHEMA_FORMAT });

    expect(body['response_format']).toEqual({
      type: 'json_schema',
      json_schema: {
        name: 'contact',
        schema: CONTACT_SCHEMA,
        strict: true,
        description: undefined,
      },
    });
  });

  it('keeps response_format intact through the Kimi buildParams pipeline', async () => {
    const provider = registry.createChatProvider({
      protocol: 'openai',
      providerType: 'kimi',
      modelName: 'kimi-k2',
      apiKey: 'sk-probe',
    });

    const body = await captureOpenAIBody(provider, { responseFormat: JSON_SCHEMA_FORMAT });

    expect(body['response_format']).toEqual({
      type: 'json_schema',
      json_schema: {
        name: 'contact',
        schema: CONTACT_SCHEMA,
        strict: true,
        description: undefined,
      },
    });
  });

  it('maps json_schema to Anthropic output_config.format, merged over the per-turn effort', async () => {
    const provider = new AnthropicChatProvider({
      model: 'claude-opus-4-6',
      apiKey: 'sk-probe',
      stream: false,
    });

    const { params } = await captureAnthropicBody(provider, {
      thinking: { effort: 'medium' },
      responseFormat: JSON_SCHEMA_FORMAT,
    });

    // The morph era seeded `output_config.effort` via withGenerationKwargs;
    // the per-turn thinking intent is the channel now, and the format merges
    // into the same output_config object.
    expect(params['output_config']).toEqual({
      effort: 'medium',
      format: { type: 'json_schema', schema: CONTACT_SCHEMA },
    });
  });

  it('rejects json_object for Anthropic because the provider requires a schema', async () => {
    const provider = new AnthropicChatProvider({
      model: 'claude-opus-4-6',
      apiKey: 'sk-probe',
      stream: false,
    });

    await expect(
      provider.generate('', [], PROBE_HISTORY, { responseFormat: { type: 'json_object' } }),
    ).rejects.toThrow('Anthropic provider requires a JSON schema for structured response output.');
  });

  it('maps json_schema to the Google GenAI response config', async () => {
    const provider = new GoogleGenAIChatProvider({
      model: 'gemini-2.5-flash',
      apiKey: 'sk-probe',
      stream: false,
    });

    const body = await captureGoogleBody(provider, { responseFormat: JSON_SCHEMA_FORMAT });
    const config = body['config'] as Record<string, unknown>;

    expect(config['responseMimeType']).toBe('application/json');
    expect(config['responseJsonSchema']).toEqual(CONTACT_SCHEMA);
    // The deleted suite's "replaces conflicting native schema config" case is
    // unreachable now: the morph kwargs channel is gone, so a conflicting
    // `responseSchema` can never be seeded (the base still deletes both keys
    // defensively before applying the format).
  });

  it('maps json_schema to the OpenAI Responses text.format', async () => {
    const provider = new OpenAIResponsesChatProvider({ model: 'gpt-4.1', apiKey: 'sk-probe' });

    const body = await captureResponsesBody(provider, { responseFormat: JSON_SCHEMA_FORMAT });

    expect(body['text']).toEqual({
      format: {
        type: 'json_schema',
        name: 'contact',
        schema: CONTACT_SCHEMA,
        strict: true,
        description: undefined,
      },
    });
    // The deleted suite's "preserves existing text options" case is
    // unreachable now: no channel seeds `text.verbosity` (the per-request
    // merge in the base still stands, but only per-turn formats reach it).
  });
});

describe('Anthropic thinking keep (context-management overlay)', () => {
  it('overlays the clear-thinking edit and forces the beta endpoint when keep is set', async () => {
    const provider = new AnthropicChatProvider({
      model: 'claude-opus-4-6',
      apiKey: 'sk-probe',
      stream: false,
    });

    const { params, via } = await captureAnthropicBody(provider, {
      thinking: { effort: 'high', keep: 'all' },
    });

    expect(via).toBe('beta');
    expect(params['context_management']).toEqual({
      edits: [{ type: 'clear_thinking_20251015', keep: 'all' }],
    });
    expect(params['betas']).toContain('context-management-2025-06-27');
  });

  it('never duplicates the edit or the beta across turns on the same provider', async () => {
    const provider = new AnthropicChatProvider({
      model: 'claude-opus-4-6',
      apiKey: 'sk-probe',
      stream: false,
    });
    const keepAll: GenerateOptions = { thinking: { effort: 'high', keep: 'all' } };

    const first = await captureAnthropicBody(provider, keepAll);
    const second = await captureAnthropicBody(provider, keepAll);

    for (const { params } of [first, second]) {
      const edits = (params['context_management'] as { edits: unknown[] }).edits;
      expect(edits).toEqual([{ type: 'clear_thinking_20251015', keep: 'all' }]);
      const betas = params['betas'] as string[];
      expect(betas.filter((beta) => beta === 'context-management-2025-06-27')).toHaveLength(1);
    }
  });

  it('sends no context-management and stays on the standard endpoint without keep', async () => {
    const provider = new AnthropicChatProvider({
      model: 'claude-opus-4-6',
      apiKey: 'sk-probe',
      stream: false,
    });

    const { params, via } = await captureAnthropicBody(provider, {
      thinking: { effort: 'high' },
    });

    expect(via).toBe('standard');
    expect(params).not.toHaveProperty('context_management');
    expect(params).not.toHaveProperty('betas');
  });
});

describe('Anthropic max-tokens profile', () => {
  it('returns per-version Messages-API caps for known Claude models', () => {
    expect(resolveDefaultMaxTokens('claude-fable-5')).toBe(128000);
    expect(resolveDefaultMaxTokens('claude-opus-4-8')).toBe(128000);
    expect(resolveDefaultMaxTokens('claude-opus-4-7')).toBe(128000);
    expect(resolveDefaultMaxTokens('claude-opus-4-6')).toBe(128000);
    expect(resolveDefaultMaxTokens('claude-opus-4-5-20251101')).toBe(64000);
    expect(resolveDefaultMaxTokens('claude-sonnet-4-6')).toBe(128000);
    expect(resolveDefaultMaxTokens('claude-haiku-4-5')).toBe(64000);
  });

  it('matches dotted version separators', () => {
    expect(resolveDefaultMaxTokens('claude-opus-4.8')).toBe(128000);
    expect(resolveDefaultMaxTokens('claude-opus-4.7')).toBe(128000);
    expect(resolveDefaultMaxTokens('claude-sonnet-4.6')).toBe(128000);
  });

  it('falls back to the nearest lower catalogued minor for unknown minors', () => {
    // Uncatalogued minors inherit at least their predecessor's cap.
    expect(resolveDefaultMaxTokens('claude-opus-4-9')).toBe(128000);
    expect(resolveDefaultMaxTokens('claude-opus-4-10')).toBe(128000);
    expect(resolveDefaultMaxTokens('claude-sonnet-4-9')).toBe(128000);
    expect(resolveDefaultMaxTokens('claude-haiku-4-9')).toBe(64000);
    // A gap between catalogued minors resolves to the nearest lower one.
    expect(resolveDefaultMaxTokens('claude-opus-4-3')).toBe(32000);
  });

  it('honors a lower override, clamps an override above the ceiling, and defaults unknown models to 128000', () => {
    expect(resolveDefaultMaxTokens('claude-opus-4-7', 200)).toBe(200);
    expect(resolveDefaultMaxTokens('claude-opus-4-7', 999999)).toBe(128000);
    expect(resolveDefaultMaxTokens('unknown-model', 12345)).toBe(12345);
    expect(resolveDefaultMaxTokens('totally-unknown-model')).toBe(128000);
  });

  it('sends the profile default as max_tokens when no explicit defaultMaxTokens is set', async () => {
    const provider = new AnthropicChatProvider({
      model: 'claude-opus-4-7',
      apiKey: 'sk-probe',
      stream: false,
    });

    const { params } = await captureAnthropicBody(provider);

    expect(params['max_tokens']).toBe(128000);
  });

  it('sends an explicit defaultMaxTokens unclamped, even above the model ceiling', async () => {
    const provider = new AnthropicChatProvider({
      model: 'claude-opus-4-7',
      apiKey: 'sk-probe',
      stream: false,
      defaultMaxTokens: 999999,
    });

    const { params } = await captureAnthropicBody(provider);

    expect(params['max_tokens']).toBe(999999);
  });

  it('clamps the per-turn budget against the model ceiling', async () => {
    const provider = new AnthropicChatProvider({
      model: 'claude-opus-4-7',
      apiKey: 'sk-probe',
      stream: false,
    });

    const within = await captureAnthropicBody(provider, { maxCompletionTokens: 5000 });
    expect(within.params['max_tokens']).toBe(5000);
    const above = await captureAnthropicBody(provider, { maxCompletionTokens: 999999 });
    expect(above.params['max_tokens']).toBe(128000);
  });

  it('lets an explicit constructor defaultMaxTokens win over the per-turn budget', async () => {
    const provider = new AnthropicChatProvider({
      model: 'claude-opus-4-7',
      apiKey: 'sk-probe',
      stream: false,
      defaultMaxTokens: 999999,
    });

    const { params } = await captureAnthropicBody(provider, { maxCompletionTokens: 5000 });

    expect(params['max_tokens']).toBe(999999);
  });
});

describe('OpenAI reasoning_effort path (issue #1616)', () => {
  it('auto-enables reasoning_effort=medium from think-part history when no withThinking hook exists', async () => {
    const provider = new OpenAILegacyChatProvider({
      model: 'gpt-4.1',
      apiKey: 'sk-probe',
      stream: false,
    });

    const body = await captureOpenAIBody(provider, undefined, THINK_HISTORY);

    expect(body['reasoning_effort']).toBe('medium');
  });

  it('maps an explicit concrete effort to reasoning_effort', async () => {
    const provider = new OpenAILegacyChatProvider({
      model: 'gpt-4.1',
      apiKey: 'sk-probe',
      stream: false,
    });

    const body = await captureOpenAIBody(provider, { thinking: { effort: 'high' } });

    expect(body['reasoning_effort']).toBe('high');
  });

  it('suppresses the auto-enable on an explicit off, even with think-part history', async () => {
    const provider = new OpenAILegacyChatProvider({
      model: 'gpt-4.1',
      apiKey: 'sk-probe',
      stream: false,
    });

    const body = await captureOpenAIBody(provider, { thinking: { effort: 'off' } }, THINK_HISTORY);

    expect(body).not.toHaveProperty('reasoning_effort');
  });

  it('encodes an explicit off as the configured offEffort for models that reason by default', async () => {
    const provider = new OpenAILegacyChatProvider({
      model: 'grok-4',
      apiKey: 'sk-probe',
      stream: false,
      offEffort: 'none',
    });

    const body = await captureOpenAIBody(provider, { thinking: { effort: 'off' } }, THINK_HISTORY);

    expect(body['reasoning_effort']).toBe('none');
  });

  it('encodes an explicit off as the configured offEffort on the Responses wire', async () => {
    const provider = new OpenAIResponsesChatProvider({
      model: 'grok-4',
      apiKey: 'sk-probe',
      offEffort: 'none',
    });

    const body = await captureResponsesBody(provider, { thinking: { effort: 'off' } });

    expect(body['reasoning']).toEqual({ effort: 'none', summary: 'auto' });
  });

  it('disables the auto-enable entirely once a withThinking hook exists (load-bearing)', async () => {
    // A hook that defers (returns undefined) still counts as "a trait took
    // thinking over": the base's history scan must not fire, but an explicit
    // effort still falls through to the base's own reasoning_effort encoding.
    const provider = new OpenAILegacyChatProvider({
      model: 'gpt-4.1',
      apiKey: 'sk-probe',
      stream: false,
      hooks: { withThinking: () => undefined },
    });

    const scanned = await captureOpenAIBody(provider, undefined, THINK_HISTORY);
    expect(scanned).not.toHaveProperty('reasoning_effort');

    const explicit = await captureOpenAIBody(provider, { thinking: { effort: 'low' } });
    expect(explicit['reasoning_effort']).toBe('low');
  });
});

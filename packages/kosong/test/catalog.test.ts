import { describe, expect, it } from 'vitest';

import {
  adaptBaseUrlForWire,
  catalogBaseUrl,
  catalogModelToCapability,
  catalogProviderModels,
  inferWireType,
  resolveCatalogImport,
  type CatalogModelEntry,
} from '../src/catalog';

describe('inferWireType (deprecated compatibility wrapper)', () => {
  it('answers only the wire, or undefined when the entry is not importable', () => {
    expect(inferWireType({ id: 'xai', npm: '@ai-sdk/xai' })).toBe('openai');
    expect(inferWireType({ id: 'x', type: 'openai_responses' })).toBe('openai_responses');
    expect(inferWireType({ id: 'amazon-bedrock', npm: '@ai-sdk/amazon-bedrock' })).toBeUndefined();
    expect(inferWireType({ id: 'cohere', npm: '@ai-sdk/cohere' })).toBeUndefined();
    expect(inferWireType({ id: 'x', type: 'kokub', npm: '@ai-sdk/openai-compatible' })).toBeUndefined();
  });
});

describe('resolveCatalogImport — wire resolution', () => {
  it('honors an explicit valid type', () => {
    // Explicit type with no npm/api: the wire is honored, but the endpoint
    // cannot default to the vendor host — it must be asked for.
    expect(resolveCatalogImport({ id: 'x', type: 'openai_responses' })).toEqual({
      kind: 'needs-base-url',
      wire: 'openai_responses',
      guessed: false,
    });
  });

  it('infers anthropic from npm or id', () => {
    expect(resolveCatalogImport({ id: 'anthropic', npm: '@ai-sdk/anthropic' })).toMatchObject({
      kind: 'ok',
      wire: 'anthropic',
      guessed: false,
    });
    expect(resolveCatalogImport({ id: 'my-claude' })).toMatchObject({
      kind: 'needs-base-url',
      wire: 'anthropic',
      guessed: false,
    });
  });

  it('infers google-genai and vertexai', () => {
    expect(resolveCatalogImport({ id: 'gemini', npm: '@ai-sdk/google' })).toMatchObject({
      kind: 'ok',
      wire: 'google-genai',
    });
    expect(resolveCatalogImport({ id: 'google-vertex' })).toMatchObject({
      kind: 'ok',
      wire: 'vertexai',
    });
  });

  it('refuses an explicit but unrecognized type instead of guessing', () => {
    expect(resolveCatalogImport({ id: 'x', type: 'not-a-wire' })).toEqual({
      kind: 'invalid',
      reason: 'unknown-explicit-type',
    });
    // … even when npm/id would have been inferable: the explicit declaration
    // is authoritative, so a future catalog protocol is never miswired.
    expect(
      resolveCatalogImport({ id: 'x', type: 'kokub', npm: '@ai-sdk/openai-compatible' }),
    ).toEqual({ kind: 'invalid', reason: 'unknown-explicit-type' });
  });

  it('falls back to openai for vendor-specific SDKs models.dev does not type', () => {
    // xai shape: vendor npm, no explicit type, no api → guessed, needs a URL.
    expect(resolveCatalogImport({ id: 'xai', npm: '@ai-sdk/xai' })).toEqual({
      kind: 'needs-base-url',
      wire: 'openai',
      guessed: true,
    });
    // openrouter shape: vendor npm with its own api — guessed but usable.
    expect(
      resolveCatalogImport({
        id: 'openrouter',
        npm: '@openrouter/ai-sdk-provider',
        api: 'https://openrouter.ai/api/v1',
      }),
    ).toEqual({
      kind: 'ok',
      wire: 'openai',
      guessed: true,
      baseUrl: 'https://openrouter.ai/api/v1',
    });
    // Recognized SDKs are never guesses.
    expect(
      resolveCatalogImport({
        id: 'zenmux',
        npm: '@ai-sdk/openai-compatible',
        api: 'https://zenmux.example.test/api/v1',
      }),
    ).toMatchObject({ kind: 'ok', wire: 'openai', guessed: false });
    expect(resolveCatalogImport({ id: 'x', type: 'openai_responses' })).toMatchObject({
      guessed: false,
    });
  });

  it('refuses SDKs known to be proprietary instead of guessing', () => {
    expect(resolveCatalogImport({ id: 'amazon-bedrock', npm: '@ai-sdk/amazon-bedrock' })).toEqual({
      kind: 'invalid',
      reason: 'proprietary-sdk',
    });
    expect(resolveCatalogImport({ id: 'cohere', npm: '@ai-sdk/cohere' })).toEqual({
      kind: 'invalid',
      reason: 'proprietary-sdk',
    });
  });
});

describe('resolveCatalogImport — endpoint resolution', () => {
  it('resolves without asking for official SDKs and env-resolved wires', () => {
    expect(resolveCatalogImport({ id: 'openai', npm: '@ai-sdk/openai' })).toEqual({
      kind: 'ok',
      wire: 'openai',
      guessed: false,
    });
    expect(resolveCatalogImport({ id: 'anthropic', npm: '@ai-sdk/anthropic' })).toMatchObject({
      kind: 'ok',
      wire: 'anthropic',
    });
    expect(
      resolveCatalogImport({ id: 'google-vertex', npm: '@ai-sdk/google-vertex' }),
    ).toMatchObject({ kind: 'ok', wire: 'vertexai' });
  });

  it('needs a URL for non-official vendors without one', () => {
    // google-vertex-anthropic shape: Anthropic wire, vendor npm, no api —
    // without a prompt the key would be sent to api.anthropic.com.
    expect(
      resolveCatalogImport({ id: 'google-vertex-anthropic', npm: '@ai-sdk/google-vertex/anthropic' }),
    ).toEqual({ kind: 'needs-base-url', wire: 'anthropic', guessed: false });
    // kimi-for-coding declares a concrete api — no prompt needed.
    expect(
      resolveCatalogImport({
        id: 'kimi-for-coding',
        npm: '@ai-sdk/anthropic',
        api: 'https://api.kimi.com/coding/v1',
      }),
    ).toEqual({
      kind: 'ok',
      wire: 'anthropic',
      guessed: false,
      baseUrl: 'https://api.kimi.com/coding',
    });
  });

  it('needs a URL when the catalog api is an env placeholder', () => {
    expect(
      resolveCatalogImport({ id: 'neon', npm: '@ai-sdk/openai-compatible', api: '${NEON_BASE_URL}/v1' }),
    ).toEqual({ kind: 'needs-base-url', wire: 'openai', guessed: false });
    expect(
      resolveCatalogImport({
        id: 'azure-claude',
        npm: '@ai-sdk/azure/anthropic',
        api: 'https://${AZURE_RESOURCE_NAME}.example.test/anthropic/v1',
      }),
    ).toEqual({ kind: 'needs-base-url', wire: 'anthropic', guessed: false });
  });

  it('needs a URL whenever the declared endpoint is a placeholder, official SDK or not', () => {
    expect(
      resolveCatalogImport({ id: 'openai', npm: '@ai-sdk/openai', api: '${OPENAI_BASE_URL}/v1' }),
    ).toEqual({ kind: 'needs-base-url', wire: 'openai', guessed: false });
    expect(
      resolveCatalogImport({ id: 'anthropic', npm: '@ai-sdk/anthropic', api: '${ANTHROPIC_BASE_URL}' }),
    ).toEqual({ kind: 'needs-base-url', wire: 'anthropic', guessed: false });
    // A concrete endpoint on the official SDK still resolves without asking.
    expect(
      resolveCatalogImport({ id: 'openai', npm: '@ai-sdk/openai', api: 'https://api.openai.com/v1' }),
    ).toMatchObject({ kind: 'ok', wire: 'openai' });
  });

  it('adapts a user-supplied URL to the wire (Anthropic strips a trailing /v1)', () => {
    expect(
      resolveCatalogImport({ id: 'xai', npm: '@ai-sdk/xai' }, 'https://api.x.ai/v1'),
    ).toEqual({ kind: 'ok', wire: 'openai', guessed: true, baseUrl: 'https://api.x.ai/v1' });
    expect(
      resolveCatalogImport(
        { id: 'google-vertex-anthropic', npm: '@ai-sdk/google-vertex/anthropic' },
        'https://gateway.example.test/v1',
      ),
    ).toEqual({
      kind: 'ok',
      wire: 'anthropic',
      guessed: false,
      baseUrl: 'https://gateway.example.test',
    });
  });

  it('lets a user-supplied URL override the catalog endpoint', () => {
    expect(
      resolveCatalogImport(
        { id: 'openai', npm: '@ai-sdk/openai', api: 'https://api.openai.com/v1' },
        'https://proxy.example.test/v1',
      ),
    ).toEqual({
      kind: 'ok',
      wire: 'openai',
      guessed: false,
      baseUrl: 'https://proxy.example.test/v1',
    });
  });

  it('rejects blank and placeholder user URLs', () => {
    expect(resolveCatalogImport({ id: 'xai', npm: '@ai-sdk/xai' }, '   ')).toEqual({
      kind: 'invalid',
      reason: 'empty-base-url',
    });
    expect(resolveCatalogImport({ id: 'xai', npm: '@ai-sdk/xai' }, '${XAI_BASE_URL}/v1')).toEqual({
      kind: 'invalid',
      reason: 'placeholder-base-url',
    });
  });
});

describe('catalogBaseUrl', () => {
  it('strips a trailing /v1 for anthropic so the official SDK does not double it', () => {
    expect(catalogBaseUrl({ id: 'k', api: 'https://api.kimi.com/coding/v1' }, 'anthropic')).toBe(
      'https://api.kimi.com/coding',
    );
    expect(catalogBaseUrl({ id: 'k', api: 'https://api.kimi.com/coding/v1/' }, 'anthropic')).toBe(
      'https://api.kimi.com/coding',
    );
  });

  it('leaves anthropic base URLs without a bare /v1 suffix untouched', () => {
    expect(catalogBaseUrl({ id: 'a', api: 'https://api.anthropic.com' }, 'anthropic')).toBe(
      'https://api.anthropic.com',
    );
    expect(catalogBaseUrl({ id: 'a', api: 'https://host/v1beta' }, 'anthropic')).toBe(
      'https://host/v1beta',
    );
  });

  it('passes openai-family base URLs through unchanged (SDK appends /chat/completions)', () => {
    expect(catalogBaseUrl({ id: 'o', api: 'https://api.openai.com/v1' }, 'openai')).toBe(
      'https://api.openai.com/v1',
    );
  });

  it('returns undefined for a missing or empty api', () => {
    expect(catalogBaseUrl({ id: 'x' }, 'anthropic')).toBeUndefined();
    expect(catalogBaseUrl({ id: 'x', api: '' }, 'openai')).toBeUndefined();
  });

  it('returns undefined for env-placeholder URLs the config cannot express', () => {
    expect(catalogBaseUrl({ id: 'neon', api: '${NEON_BASE_URL}/v1' }, 'openai')).toBeUndefined();
    expect(
      catalogBaseUrl({ id: 'azure', api: 'https://${AZURE_RESOURCE_NAME}.example.test/anthropic/v1' }, 'anthropic'),
    ).toBeUndefined();
  });

  it('adaptBaseUrlForWire strips a trailing /v1 only for the Anthropic wire', () => {
    expect(adaptBaseUrlForWire('https://gateway.example.test/v1', 'anthropic')).toBe(
      'https://gateway.example.test',
    );
    expect(adaptBaseUrlForWire('https://gateway.example.test/v1/', 'anthropic')).toBe(
      'https://gateway.example.test',
    );
    expect(adaptBaseUrlForWire('https://gateway.example.test/v1', 'openai')).toBe(
      'https://gateway.example.test/v1',
    );
    expect(adaptBaseUrlForWire('https://host/v1beta', 'anthropic')).toBe('https://host/v1beta');
  });
});

describe('catalogModelToCapability', () => {
  it('maps modalities and limits into a ModelCapability', () => {
    expect(
      catalogModelToCapability({
        id: 'm',
        name: 'M',
        limit: { context: 200000, output: 64000 },
        tool_call: true,
        reasoning: true,
        modalities: { input: ['text', 'image'], output: ['text'] },
      }),
    ).toEqual({
      id: 'm',
      name: 'M',
      maxOutputSize: 64000,
      capability: {
        image_in: true,
        video_in: false,
        audio_in: false,
        thinking: true,
        tool_use: true,
        max_context_tokens: 200000,
        dynamically_loaded_tools: false,
      },
    });
  });

  it('defaults tool_use to true and skips models without a positive context', () => {
    expect(catalogModelToCapability({ id: 'm', limit: { context: 1000 } })?.capability.tool_use).toBe(
      true,
    );
    expect(catalogModelToCapability({ id: 'm' })).toBeUndefined();
    expect(catalogModelToCapability({ id: 'm', limit: { context: 0 } })).toBeUndefined();
  });

  it('skips embedding and non-text-output models that cannot serve as chat defaults', () => {
    expect(
      catalogModelToCapability({
        id: 'text-embedding-3-large',
        name: 'text-embedding-3-large',
        family: 'text-embedding',
        limit: { context: 8192, output: 1536 },
        modalities: { input: ['text'], output: ['text'] },
      }),
    ).toBeUndefined();
    expect(
      catalogModelToCapability({
        id: 'grok-imagine-image',
        name: 'Grok Imagine Image',
        family: 'grok',
        limit: { context: 8000 },
        modalities: { input: ['text', 'image'], output: ['image', 'pdf'] },
      }),
    ).toBeUndefined();
    expect(
      catalogModelToCapability({
        id: 'mimo-v2-tts',
        name: 'MiMo-V2-TTS',
        family: 'mimo',
        limit: { context: 8192, output: 16384 },
        modalities: { input: ['text'], output: ['audio'] },
      }),
    ).toBeUndefined();
  });

  it.each<[CatalogModelEntry['interleaved'], string | undefined]>([
    [undefined, undefined],
    // `true` carries no field name; the provider's default multi-field scan
    // is the correct (and wider) behavior, so no key is pinned.
    [true, undefined],
    [false, undefined],
    [{}, undefined],
    [{ field: '' }, undefined],
    [{ field: 'reasoning_content' }, 'reasoning_content'],
    [{ field: 'reasoning_details' }, 'reasoning_details'],
    [{ field: '  reasoning_content  ' }, 'reasoning_content'],
  ])('derives reasoningKey from interleaved=%j → %j', (interleaved, expected) => {
    const model = catalogModelToCapability({ id: 'm', limit: { context: 1000 }, interleaved });
    expect(model?.reasoningKey).toBe(expected);
  });

  it('extracts declared effort levels from reasoning_options', () => {
    // The models.dev `kimi-for-coding`/`k3` shape: toggle plus effort values.
    const model = catalogModelToCapability({
      id: 'k3',
      reasoning: true,
      reasoning_options: [
        { type: 'toggle' },
        { type: 'effort', values: ['low', 'high', 'max'] },
      ],
      limit: { context: 1048576 },
    });
    expect(model?.supportEfforts).toEqual(['low', 'high', 'max']);
    expect(model?.capability.thinking).toBe(true);
  });

  it("reads the 'none' entry as the off encoding, not a selectable level", () => {
    const model = catalogModelToCapability({
      id: 'grok',
      reasoning: true,
      reasoning_options: [{ type: 'effort', values: ['none', 'low', 'medium', 'high'] }],
      limit: { context: 1000 },
    });
    expect(model?.supportEfforts).toEqual(['low', 'medium', 'high']);
    expect(model?.offEffort).toBe('none');
    expect(model?.alwaysThinking).toBeUndefined();
    expect(model?.capability.thinking).toBe(true);

    const upper = catalogModelToCapability({
      id: 'grok',
      reasoning_options: [{ type: 'effort', values: ['None', 'high'] }],
      limit: { context: 1000 },
    });
    expect(upper?.supportEfforts).toEqual(['high']);
    expect(upper?.offEffort).toBe('None');
  });

  it('treats a JSON null tier as the none off encoding (sarvam shape)', () => {
    const model = catalogModelToCapability({
      id: 'sarvam-105b',
      reasoning: true,
      reasoning_options: [{ type: 'effort', values: [null, 'low', 'medium', 'high'] }],
      limit: { context: 1000 },
    });
    expect(model?.supportEfforts).toEqual(['low', 'medium', 'high']);
    expect(model?.offEffort).toBe('none');
    expect(model?.alwaysThinking).toBeUndefined();
    expect(model?.capability.thinking).toBe(true);
  });

  it('marks effort models with no toggle and no none value as always-thinking', () => {
    // gpt-5 shape: levels exist but reasoning cannot be disabled.
    const model = catalogModelToCapability({
      id: 'gpt-5',
      reasoning: true,
      reasoning_options: [{ type: 'effort', values: ['low', 'medium', 'high'] }],
      limit: { context: 400000 },
    });
    expect(model?.supportEfforts).toEqual(['low', 'medium', 'high']);
    expect(model?.offEffort).toBeUndefined();
    expect(model?.alwaysThinking).toBe(true);

    // A toggle entry makes thinking disable-able again (the k3 shape).
    const toggleable = catalogModelToCapability({
      id: 'k3',
      reasoning: true,
      reasoning_options: [
        { type: 'toggle' },
        { type: 'effort', values: ['low', 'high', 'max'] },
      ],
      limit: { context: 1000 },
    });
    expect(toggleable?.alwaysThinking).toBeUndefined();
    expect(toggleable?.offEffort).toBeUndefined();
  });

  it('strips the always-thinking inference only where the wire encodes a true off', () => {
    // Claude on the Anthropic wire: off is natively encodable
    // (`thinking: {type: 'disabled'}`), so the no-toggle/no-none inference
    // must NOT mark it always-on even though models.dev declares levels only.
    const anthropic = catalogProviderModels({
      id: 'anthropic',
      npm: '@ai-sdk/anthropic',
      api: 'https://api.anthropic.com',
      models: {
        'claude-opus-4-6': {
          id: 'claude-opus-4-6',
          reasoning: true,
          reasoning_options: [{ type: 'effort', values: ['low', 'medium', 'high', 'max'] }],
          limit: { context: 200000 },
        },
      },
    });
    expect(anthropic[0]?.alwaysThinking).toBeUndefined();
    expect(anthropic[0]?.supportEfforts).toEqual(['low', 'medium', 'high', 'max']);

    // The Kimi wire shares the same protocol-level disable
    // (`thinking: {type: 'disabled'}`), so the marker is stripped there too.
    const kimi = catalogProviderModels({
      id: 'kimi-entry',
      type: 'kimi',
      models: {
        'kimi-model': {
          id: 'kimi-model',
          reasoning: true,
          reasoning_options: [{ type: 'effort', values: ['low', 'high', 'max'] }],
          limit: { context: 262144 },
        },
      },
    });
    expect(kimi[0]?.alwaysThinking).toBeUndefined();

    // The same shape on the OpenAI wire keeps the marker (gpt-5-class
    // models really cannot be turned off).
    const openai = catalogProviderModels({
      id: 'openai',
      npm: '@ai-sdk/openai',
      models: {
        'gpt-5': {
          id: 'gpt-5',
          reasoning: true,
          reasoning_options: [{ type: 'effort', values: ['minimal', 'low', 'medium', 'high'] }],
          limit: { context: 400000, input: 272000 },
        },
      },
    });
    expect(openai[0]?.alwaysThinking).toBe(true);

    // Gemini 3 on the Google wires also keeps the marker: its floor is
    // `thinkingLevel: 'MINIMAL'` with suppressed thoughts — still reasoning,
    // so an "off" option would be a lie.
    for (const type of ['google-genai', 'vertexai'] as const) {
      const google = catalogProviderModels({
        id: `google-${type}`,
        type,
        models: {
          'gemini-3-pro-preview': {
            id: 'gemini-3-pro-preview',
            reasoning: true,
            reasoning_options: [{ type: 'effort', values: ['low', 'high'] }],
            limit: { context: 1048576 },
          },
        },
      });
      expect(google[0]?.alwaysThinking).toBe(true);
    }

    // A Claude model materialized onto the Anthropic wire through a gateway
    // override loses the marker with the protocol change.
    const gateway = catalogProviderModels({
      id: 'gateway',
      npm: '@ai-sdk/openai-compatible',
      api: 'https://gateway.example.test/v1',
      models: {
        'vendor/claude-model': {
          id: 'vendor/claude-model',
          reasoning: true,
          reasoning_options: [{ type: 'effort', values: ['low', 'medium', 'high'] }],
          limit: { context: 200000 },
          provider: { npm: '@ai-sdk/anthropic', api: 'https://gateway.example.test/anthropic/v1' },
        },
      },
    });
    expect(gateway[0]?.protocol).toBe('anthropic');
    expect(gateway[0]?.alwaysThinking).toBeUndefined();
  });

  it('yields no effort list for toggle-only, budget_tokens, or empty reasoning_options', () => {
    for (const reasoning_options of [
      [{ type: 'toggle' }],
      [{ type: 'budget_tokens', min: 1024, max: 32768 }],
      [],
    ] as const) {
      const model = catalogModelToCapability({
        id: 'm',
        reasoning: true,
        reasoning_options,
        limit: { context: 1000 },
      });
      expect(model?.supportEfforts).toBeUndefined();
      expect(model?.capability.thinking).toBe(true);
    }
  });

  it('treats declared effort levels as thinking support when reasoning is absent', () => {
    const model = catalogModelToCapability({
      id: 'm',
      reasoning_options: [{ type: 'effort', values: ['low', 'high'] }],
      limit: { context: 1000 },
    });
    expect(model?.supportEfforts).toEqual(['low', 'high']);
    expect(model?.capability.thinking).toBe(true);
  });

  it('tracks limit.input separately from the total context window', () => {
    // The gpt-5 shape on models.dev: 400k total window, 272k input cap. The
    // total window stays the context budget (completion clamping needs it);
    // the input cap is tracked for prompt-budget checks (compaction).
    const model = catalogModelToCapability({ id: 'gpt-5', limit: { context: 400000, input: 272000 } });
    expect(model?.capability.max_context_tokens).toBe(400000);
    expect(model?.capability.max_input_tokens).toBe(272000);
    // A bogus or inconsistent input limit never exceeds the total window.
    const weird = catalogModelToCapability({ id: 'm', limit: { context: 1000, input: 5000 } });
    expect(weird?.capability.max_context_tokens).toBe(1000);
    expect(weird?.capability.max_input_tokens).toBe(1000);
    // No declared input limit: the total window is the only ceiling.
    const plain = catalogModelToCapability({ id: 'm', limit: { context: 1000 } });
    expect(plain?.capability.max_context_tokens).toBe(1000);
    expect(plain?.capability.max_input_tokens).toBeUndefined();
    const zero = catalogModelToCapability({ id: 'm', limit: { context: 1000, input: 0 } });
    expect(zero?.capability.max_input_tokens).toBeUndefined();
  });

  it('skips deprecated and alpha models but keeps beta ones', () => {
    expect(
      catalogModelToCapability({ id: 'old', status: 'deprecated', limit: { context: 1000 } }),
    ).toBeUndefined();
    expect(
      catalogModelToCapability({ id: 'pre', status: 'alpha', limit: { context: 1000 } }),
    ).toBeUndefined();
    expect(
      catalogModelToCapability({ id: 'new', status: 'beta', limit: { context: 1000 } })?.id,
    ).toBe('new');
  });
});

describe('catalogProviderModels', () => {
  it('extracts only valid models from a provider entry', () => {
    const models = catalogProviderModels({
      id: 'p',
      models: {
        good: { id: 'good', limit: { context: 1000 } },
        bad: { id: 'bad' },
      },
    });
    expect(models).toHaveLength(1);
    expect(models[0]?.id).toBe('good');
  });

  it('materializes a per-model Anthropic override with its own endpoint (zenmux shape)', () => {
    const models = catalogProviderModels({
      id: 'zenmux',
      npm: '@ai-sdk/openai-compatible',
      api: 'https://zenmux.example.test/api/v1',
      models: {
        'vendor/claude-model': {
          id: 'vendor/claude-model',
          limit: { context: 200000 },
          provider: { npm: '@ai-sdk/anthropic', api: 'https://zenmux.example.test/api/anthropic/v1' },
        },
        'vendor/plain-model': { id: 'vendor/plain-model', limit: { context: 1000 } },
      },
    });
    expect(models[0]).toMatchObject({
      id: 'vendor/claude-model',
      protocol: 'anthropic',
      baseUrl: 'https://zenmux.example.test/api/anthropic',
    });
    expect(models[1]).toMatchObject({ id: 'vendor/plain-model' });
    expect(models[1]?.protocol).toBeUndefined();
    expect(models[1]?.baseUrl).toBeUndefined();
  });

  it('falls back to the provider api when the override declares only npm (opencode shape)', () => {
    const models = catalogProviderModels({
      id: 'opencode',
      npm: '@ai-sdk/openai-compatible',
      api: 'https://opencode.example.test/zen/v1',
      models: {
        'vendor/claude-model': {
          id: 'vendor/claude-model',
          limit: { context: 200000 },
          provider: { npm: '@ai-sdk/anthropic' },
        },
      },
    });
    expect(models[0]).toMatchObject({
      protocol: 'anthropic',
      baseUrl: 'https://opencode.example.test/zen',
    });
  });

  it('skips models whose override targets a different wire it cannot express', () => {
    // freemodel shape: provider is Anthropic, model override targets OpenAI —
    // importing under the provider wire would be the wrong protocol.
    const reverse = catalogProviderModels({
      id: 'freemodel',
      npm: '@ai-sdk/anthropic',
      api: 'https://freemodel.example.test/v1',
      models: {
        'vendor/gpt': {
          id: 'vendor/gpt',
          limit: { context: 1000 },
          provider: { npm: '@ai-sdk/openai-compatible' },
        },
      },
    });
    expect(reverse).toHaveLength(0);

    // google-vertex shape: Claude models need Anthropic-over-Vertex, which the
    // vertexai (Gemini-mode) wire is not — skipped, not mis-wired.
    const noEndpoint = catalogProviderModels({
      id: 'google-vertex',
      npm: '@ai-sdk/google-vertex',
      models: {
        'claude-model': {
          id: 'claude-model',
          limit: { context: 200000 },
          provider: { npm: '@ai-sdk/google-vertex/anthropic' },
        },
      },
    });
    expect(noEndpoint).toHaveLength(0);

    // Env-placeholder URLs are SDK-side interpolations the config cannot express.
    const placeholder = catalogProviderModels({
      id: 'neon',
      npm: '@ai-sdk/openai-compatible',
      api: '${NEON_BASE_URL}/v1',
      models: {
        'vendor/claude-model': {
          id: 'vendor/claude-model',
          limit: { context: 200000 },
          provider: { npm: '@ai-sdk/anthropic', api: '${NEON_BASE_URL}/anthropic/v1' },
        },
      },
    });
    expect(placeholder).toHaveLength(0);
  });

  it('keeps models whose override matches the provider wire', () => {
    // vivgrid shape: provider and model override are both OpenAI-family.
    const models = catalogProviderModels({
      id: 'vivgrid',
      npm: '@ai-sdk/openai',
      api: 'https://api.vivgrid.com/v1',
      models: {
        'gpt-5.4': {
          id: 'gpt-5.4',
          limit: { context: 400000 },
          provider: { npm: '@ai-sdk/openai-compatible' },
        },
      },
    });
    expect(models).toHaveLength(1);
    expect(models[0]?.protocol).toBeUndefined();
  });

  it('carries a same-wire override endpoint that differs from the provider api', () => {
    const models = catalogProviderModels({
      id: 'gateway',
      npm: '@ai-sdk/openai-compatible',
      api: 'https://gateway.example.test/v1',
      models: {
        'tenant-model': {
          id: 'tenant-model',
          limit: { context: 1000 },
          provider: { npm: '@ai-sdk/openai-compatible', api: 'https://tenant.example.test/v1' },
        },
        // Same endpoint as the provider — nothing to carry.
        'shared-model': {
          id: 'shared-model',
          limit: { context: 1000 },
          provider: { npm: '@ai-sdk/openai-compatible', api: 'https://gateway.example.test/v1' },
        },
      },
    });
    expect(models[0]).toMatchObject({ baseUrl: 'https://tenant.example.test/v1' });
    expect(models[0]?.protocol).toBeUndefined();
    expect(models[1]?.baseUrl).toBeUndefined();
  });

  it('carries a same-wire Anthropic override endpoint, adapted to the SDK convention', () => {
    const models = catalogProviderModels({
      id: 'claude-gw',
      npm: '@ai-sdk/anthropic',
      api: 'https://gw.example.test',
      models: {
        'tenant-claude': {
          id: 'tenant-claude',
          limit: { context: 200000 },
          provider: { npm: '@ai-sdk/anthropic', api: 'https://tenant.example.test/v1' },
        },
      },
    });
    expect(models[0]).toMatchObject({ baseUrl: 'https://tenant.example.test' });
    expect(models[0]?.protocol).toBeUndefined();
  });

  it('honors api-only overrides as same-wire endpoint changes', () => {
    const models = catalogProviderModels({
      id: 'gateway',
      npm: '@ai-sdk/openai-compatible',
      api: 'https://gateway.example.test/v1',
      models: {
        'tenant-model': {
          id: 'tenant-model',
          limit: { context: 1000 },
          provider: { api: 'https://tenant.example.test/v1' },
        },
        'plain-model': { id: 'plain-model', limit: { context: 1000 } },
      },
    });
    expect(models[0]).toMatchObject({ baseUrl: 'https://tenant.example.test/v1' });
    expect(models[0]?.protocol).toBeUndefined();
    expect(models[1]?.baseUrl).toBeUndefined();
  });

  it('skips overrides targeting another known wire the alias cannot express', () => {
    // A google-genai model on an OpenAI gateway: the override explicitly
    // requires a different protocol — imported under OpenAI it would just fail.
    const models = catalogProviderModels({
      id: 'gateway',
      npm: '@ai-sdk/openai-compatible',
      api: 'https://gateway.example.test/v1',
      models: {
        'google/gemini-x': {
          id: 'google/gemini-x',
          limit: { context: 1000 },
          provider: { npm: '@ai-sdk/google' },
        },
      },
    });
    expect(models).toHaveLength(0);
  });

  it('skips same-wire models whose declared endpoint is an env placeholder', () => {
    const models = catalogProviderModels({
      id: 'gateway',
      npm: '@ai-sdk/openai-compatible',
      api: 'https://gateway.example.test/v1',
      models: {
        'tenant-model': {
          id: 'tenant-model',
          limit: { context: 1000 },
          provider: { api: '${TENANT_BASE_URL}/v1' },
        },
      },
    });
    expect(models).toHaveLength(0);
  });

  it('refuses known proprietary override SDKs instead of falling back to OpenAI', () => {
    for (const npm of ['@ai-sdk/cohere', '@ai-sdk/amazon-bedrock']) {
      const models = catalogProviderModels({
        id: 'gateway',
        npm: '@ai-sdk/openai-compatible',
        api: 'https://gateway.example.test/v1',
        models: {
          'vendor-model': {
            id: 'vendor-model',
            limit: { context: 1000 },
            provider: { npm, api: 'https://tenant.example.test/v1' },
          },
        },
      });
      expect(models).toHaveLength(0);
    }
  });

  it('falls back to the OpenAI wire for unrecognized override SDKs, preserving a concrete endpoint', () => {
    // xai-flavored model on an OpenAI-compatible gateway: the npm is unknown
    // but the endpoint is concrete — carry it (same-wire), do not drop it.
    const models = catalogProviderModels({
      id: 'gateway',
      npm: '@ai-sdk/openai-compatible',
      api: 'https://gateway.example.test/v1',
      models: {
        'tenant-model': {
          id: 'tenant-model',
          limit: { context: 1000 },
          provider: { npm: '@ai-sdk/xai', api: 'https://tenant.example.test/v1' },
        },
      },
    });
    expect(models[0]).toMatchObject({ baseUrl: 'https://tenant.example.test/v1' });
    expect(models[0]?.protocol).toBeUndefined();
  });

  it('skips unrecognized-wire overrides when the provider speaks another wire', () => {
    const models = catalogProviderModels({
      id: 'claude-gw',
      npm: '@ai-sdk/anthropic',
      api: 'https://gw.example.test',
      models: {
        'vendor-model': {
          id: 'vendor-model',
          limit: { context: 1000 },
          provider: { npm: '@ai-sdk/xai', api: 'https://tenant.example.test/v1' },
        },
      },
    });
    expect(models).toHaveLength(0);
  });
});

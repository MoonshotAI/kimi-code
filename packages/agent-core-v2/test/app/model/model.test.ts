/**
 * `model` domain tests — covers `effectiveModelConfig`, the `models` config
 * section registration + TOML transforms (now owned by the app/kosongConfig
 * persistence wrapper), and the `KIMI_MODEL_*` env overlay.
 *
 * The registry itself (`ModelService`) is a pure in-memory store covered by
 * `test/kosong/model/modelService.test.ts`; persistence through the config
 * bridge is covered by `test/app/kosongConfig/kosongConfigService.test.ts`.
 */

import { describe, expect, it } from 'vitest';

import { ConfigRegistry } from '#/app/config/configService';
import { ErrorCodes, Error2 } from '#/errors';
import { kimiModelEnvOverlay, ENV_MODEL_ALIAS_KEY } from '#/app/kosongConfig/envOverlay';
import {
  ENV_MODEL_PROVIDER_KEY,
  MODELS_SECTION,
  ModelsSectionSchema,
  modelsFromToml,
  modelsToToml,
} from '#/app/kosongConfig/configSection';
import { type ModelRecord } from '#/kosong/model/model';
import { effectiveModelConfig } from '#/kosong/model/modelAuth';

// Side-effect registrations: endpoint defaults and the trait-driven-thinking
// verdict (`drivesThinkingThroughTraits`) answer through the provider-definition registry.
import '#/kosong/provider/providers/kimi/kimi.contrib';
import '#/kosong/provider/providers/standard.contrib';

describe('effectiveModelConfig', () => {
  it('clamps the input cap to the effective total window without mutating the source', () => {
    const record = {
      provider: 'custom',
      model: 'gpt-5',
      maxContextSize: 128000,
      maxInputSize: 272000,
    };

    const effective = effectiveModelConfig(record);
    expect(effective.maxInputSize).toBe(128000);
    expect(record.maxInputSize).toBe(272000);

    const withOverrides = {
      provider: 'custom',
      model: 'gpt-5',
      maxContextSize: 400000,
      maxInputSize: 272000,
      overrides: { maxContextSize: 128000 },
    };
    const effectiveOverride = effectiveModelConfig(withOverrides);
    expect(effectiveOverride.maxContextSize).toBe(128000);
    expect(effectiveOverride.maxInputSize).toBe(128000);
    expect(withOverrides.maxInputSize).toBe(272000);
  });

  it('derives the official effort metadata from a Claude model name', () => {
    expect(
      effectiveModelConfig({
        provider: 'anthropic',
        model: 'claude-opus-4-6',
        maxContextSize: 200000,
      }),
    ).toMatchObject({
      capabilities: ['thinking'],
      supportEfforts: ['low', 'medium', 'high', 'max'],
      defaultEffort: 'high',
    });
  });

  it('infers Anthropic effort metadata for an unknown Claude-marked model on a non-Kimi Anthropic provider', () => {
    expect(
      effectiveModelConfig(
        {
          provider: 'custom',
          model: 'custom-claude-model',
          maxContextSize: 200000,
          protocol: 'anthropic',
        },
        'anthropic',
      ),
    ).toMatchObject({
      capabilities: ['thinking'],
      supportEfforts: ['low', 'medium', 'high', 'xhigh', 'max'],
      defaultEffort: 'high',
    });
  });

  it('infers Anthropic effort metadata for a bare Claude family alias on a non-Kimi Anthropic provider', () => {
    expect(
      effectiveModelConfig(
        {
          provider: 'custom',
          model: 'sonnet-latest',
          maxContextSize: 200000,
          protocol: 'anthropic',
        },
        'anthropic',
      ),
    ).toMatchObject({
      capabilities: ['thinking'],
      supportEfforts: ['low', 'medium', 'high', 'xhigh', 'max'],
      defaultEffort: 'high',
    });
  });

  it('does not infer Anthropic effort metadata for a clearly non-Claude model on a non-Kimi Anthropic provider', () => {
    expect(
      effectiveModelConfig(
        {
          provider: 'custom',
          model: 'custom-anthropic-model',
          maxContextSize: 200000,
          protocol: 'anthropic',
        },
        'anthropic',
      ),
    ).toEqual({
      provider: 'custom',
      model: 'custom-anthropic-model',
      maxContextSize: 200000,
      protocol: 'anthropic',
    });
  });

  it('does not infer Anthropic effort metadata for a Kimi provider routed through the Anthropic protocol', () => {
    const model: ModelRecord = {
      provider: 'managed:kimi-code',
      model: 'kimi-for-coding',
      maxContextSize: 262144,
      capabilities: ['thinking', 'always_thinking'],
      protocol: 'anthropic',
      adaptiveThinking: true,
    };

    expect(effectiveModelConfig(model, 'kimi')).toEqual(model);
  });

  it('does not infer the fallback profile without provider context', () => {
    const model: ModelRecord = {
      provider: 'custom',
      model: 'custom-anthropic-model',
      maxContextSize: 200000,
      protocol: 'anthropic',
    };

    expect(effectiveModelConfig(model)).toEqual(model);
  });

  it('limits an adaptive_thinking=false model to budget efforts', () => {
    expect(
      effectiveModelConfig(
        {
          provider: 'custom',
          model: 'custom-claude-model',
          maxContextSize: 200000,
          protocol: 'anthropic',
          adaptiveThinking: false,
        },
        'anthropic',
      ),
    ).toMatchObject({
      capabilities: ['thinking'],
      supportEfforts: ['low', 'medium', 'high'],
      defaultEffort: 'high',
    });
  });

  it('does not infer Anthropic effort metadata for an unknown model without an Anthropic protocol', () => {
    const model = {
      provider: 'custom',
      model: 'custom-anthropic-model',
      maxContextSize: 200000,
    };

    expect(effectiveModelConfig(model)).toEqual(model);
  });

  it('marks official always-on models while preserving explicit effort metadata', () => {
    expect(
      effectiveModelConfig({
        provider: 'anthropic',
        model: 'claude-fable-5',
        maxContextSize: 200000,
        supportEfforts: ['high', 'max'],
        defaultEffort: 'max',
      }),
    ).toMatchObject({
      capabilities: ['always_thinking'],
      supportEfforts: ['high', 'max'],
      defaultEffort: 'max',
    });
  });
});

describe('models config section', () => {
  it('self-registers the models section schema', () => {
    expect(new ConfigRegistry().getSection(MODELS_SECTION)).toBeDefined();
  });
});

describe('models TOML transforms', () => {
  it('camelCases nested model overrides from TOML', () => {
    expect(
      modelsFromToml({
        kimi: {
          provider: 'p',
          model: 'm',
          max_context_size: 1000,
          support_efforts: ['low', 'high', 'max'],
          overrides: {
            max_context_size: 500,
            support_efforts: ['low', 'high'],
          },
        },
      }),
    ).toEqual({
      kimi: {
        provider: 'p',
        model: 'm',
        maxContextSize: 1000,
        supportEfforts: ['low', 'high', 'max'],
        overrides: {
          maxContextSize: 500,
          supportEfforts: ['low', 'high'],
        },
      },
    });
  });

  it('snakeCases nested model overrides for TOML', () => {
    expect(
      modelsToToml(
        {
          kimi: {
            provider: 'p',
            model: 'm',
            maxContextSize: 1000,
            overrides: {
              maxContextSize: 500,
              supportEfforts: ['low', 'high'],
            },
          },
        },
        {},
      ),
    ).toEqual({
      kimi: {
        provider: 'p',
        model: 'm',
        max_context_size: 1000,
        overrides: {
          max_context_size: 500,
          support_efforts: ['low', 'high'],
        },
      },
    });
  });
});

type EnvMap = Readonly<Record<string, string | undefined>>;

function applyKimiModelEnvOverlay(
  env: EnvMap,
  effective: Record<string, unknown> = {},
): { readonly changed: readonly string[]; readonly effective: Record<string, unknown> } {
  const changed = kimiModelEnvOverlay.apply(
    effective,
    (name) => env[name],
    (domain, value) => {
      if (domain === MODELS_SECTION) return ModelsSectionSchema.parse(value);
      return value;
    },
  );
  return { changed, effective };
}

function expectConfigInvalid(fn: () => unknown): void {
  try {
    fn();
  } catch (error) {
    expect(error).toBeInstanceOf(Error2);
    expect((error as Error2).code).toBe(ErrorCodes.CONFIG_INVALID);
    return;
  }
  throw new Error('expected config.invalid');
}

describe('kimiModelEnvOverlay', () => {
  it('does nothing when KIMI_MODEL_NAME is absent', () => {
    const effective = {
      models: {
        existing: { provider: 'p', model: 'm', maxContextSize: 1000 },
      },
      defaultModel: 'existing',
    };

    const result = applyKimiModelEnvOverlay({}, effective);

    expect(result.changed).toEqual([]);
    expect(result.effective).toEqual(effective);
  });

  it('applies request overrides when KIMI_MODEL_NAME is absent', () => {
    const { changed, effective } = applyKimiModelEnvOverlay({
      KIMI_MODEL_TEMPERATURE: '0.3',
      KIMI_MODEL_THINKING_KEEP: 'all',
    });

    expect(changed).toEqual(['modelOverrides']);
    expect(effective['modelOverrides']).toEqual({
      temperature: 0.3,
      thinkingKeep: 'all',
    });
  });

  it('synthesizes an env model alias and default model from the minimal env set', () => {
    const { changed, effective } = applyKimiModelEnvOverlay({
      KIMI_MODEL_NAME: 'kimi-for-coding',
    });

    expect(changed).toEqual(['models', 'providers', 'defaultModel']);
    expect(effective['defaultModel']).toBe(ENV_MODEL_ALIAS_KEY);
    expect(effective['models']).toEqual({
      [ENV_MODEL_ALIAS_KEY]: {
        provider: ENV_MODEL_PROVIDER_KEY,
        model: 'kimi-for-coding',
        maxContextSize: 262144,
        capabilities: ['image_in', 'thinking'],
      },
    });
    expect(effective['providers']).toEqual({
      [ENV_MODEL_PROVIDER_KEY]: { type: 'kimi', baseUrl: 'https://api.moonshot.ai/v1' },
    });
  });

  it('omits baseUrl for openai so the base SDK default applies at construction', () => {
    const { effective } = applyKimiModelEnvOverlay(
      { KIMI_MODEL_NAME: 'env-model' },
      { providers: { [ENV_MODEL_PROVIDER_KEY]: { type: 'openai' } } },
    );

    // The registry declares no `defaultBaseUrl` for the canonical vendors
    // (standard.contrib): construction-time defaults stay inside the bases /
    // their SDKs, so the overlay leaves baseUrl out — exactly like anthropic.
    expect(effective['providers']).toEqual({
      [ENV_MODEL_PROVIDER_KEY]: { type: 'openai' },
    });
  });

  it('omits baseUrl for anthropic so the SDK picks its default', () => {
    const { effective } = applyKimiModelEnvOverlay(
      { KIMI_MODEL_NAME: 'env-model' },
      { providers: { [ENV_MODEL_PROVIDER_KEY]: { type: 'anthropic' } } },
    );

    expect(effective['providers']).toEqual({
      [ENV_MODEL_PROVIDER_KEY]: { type: 'anthropic' },
    });
  });

  it('honors an explicit baseUrl over the type default', () => {
    const { effective } = applyKimiModelEnvOverlay(
      { KIMI_MODEL_NAME: 'env-model' },
      {
        providers: {
          [ENV_MODEL_PROVIDER_KEY]: { type: 'openai', baseUrl: 'https://api.example.com/v1' },
        },
      },
    );

    expect(effective['providers']).toEqual({
      [ENV_MODEL_PROVIDER_KEY]: { type: 'openai', baseUrl: 'https://api.example.com/v1' },
    });
  });

  it('keeps an explicit env provider type instead of the kimi default', () => {
    const { changed, effective } = applyKimiModelEnvOverlay(
      { KIMI_MODEL_NAME: 'env-model' },
      { providers: { [ENV_MODEL_PROVIDER_KEY]: { type: 'openai', baseUrl: 'http://x' } } },
    );

    expect(changed).toEqual(['models', 'defaultModel']);
    expect(effective['providers']).toEqual({
      [ENV_MODEL_PROVIDER_KEY]: { type: 'openai', baseUrl: 'http://x' },
    });
  });

  it('preserves configured aliases while adding the env alias', () => {
    const existing = { provider: 'p', model: 'm', maxContextSize: 1000 };
    const { effective } = applyKimiModelEnvOverlay(
      { KIMI_MODEL_NAME: 'env-model' },
      { models: { existing } },
    );

    expect(effective['models']).toMatchObject({
      existing,
      [ENV_MODEL_ALIAS_KEY]: { model: 'env-model' },
    });
  });

  it('maps extended model metadata and request overrides', () => {
    const { changed, effective } = applyKimiModelEnvOverlay({
      KIMI_MODEL_NAME: 'env-model',
      KIMI_MODEL_MAX_CONTEXT_SIZE: '1000000',
      KIMI_MODEL_MAX_OUTPUT_SIZE: '8192',
      KIMI_MODEL_CAPABILITIES: 'Image_In, thinking , tool_use',
      KIMI_MODEL_DISPLAY_NAME: 'Custom Model',
      KIMI_MODEL_REASONING_KEY: 'reasoning',
      KIMI_MODEL_ADAPTIVE_THINKING: 'true',
      KIMI_MODEL_TEMPERATURE: '0.3',
      KIMI_MODEL_TOP_P: ' 0.95 ',
      KIMI_MODEL_THINKING_KEEP: 'all',
      KIMI_MODEL_MAX_COMPLETION_TOKENS: '4096',
      KIMI_MODEL_MAX_TOKENS: '2048',
    });

    expect(changed).toEqual(['models', 'providers', 'defaultModel', 'modelOverrides']);
    expect(
      (effective['models'] as Record<string, unknown>)[ENV_MODEL_ALIAS_KEY],
    ).toEqual({
      provider: ENV_MODEL_PROVIDER_KEY,
      model: 'env-model',
      maxContextSize: 1000000,
      maxOutputSize: 8192,
      capabilities: ['image_in', 'thinking', 'tool_use'],
      displayName: 'Custom Model',
      reasoningKey: 'reasoning',
      adaptiveThinking: true,
    });
    expect(effective['modelOverrides']).toEqual({
      temperature: 0.3,
      topP: 0.95,
      thinkingKeep: 'all',
      maxCompletionTokens: 4096,
    });
  });

  it('falls back to legacy KIMI_MODEL_MAX_TOKENS for completion overrides', () => {
    const { effective } = applyKimiModelEnvOverlay({
      KIMI_MODEL_NAME: 'env-model',
      KIMI_MODEL_MAX_TOKENS: '2048',
    });

    expect(effective['modelOverrides']).toEqual({ maxCompletionTokens: 2048 });
  });

  it.each([
    ['KIMI_MODEL_MAX_CONTEXT_SIZE', '0'],
    ['KIMI_MODEL_MAX_CONTEXT_SIZE', '1.5'],
    ['KIMI_MODEL_MAX_OUTPUT_SIZE', 'nope'],
    ['KIMI_MODEL_ADAPTIVE_THINKING', 'maybe'],
    ['KIMI_MODEL_TEMPERATURE', 'abc'],
    ['KIMI_MODEL_TEMPERATURE', '1.2.3'],
    ['KIMI_MODEL_TOP_P', 'NaN'],
  ])('throws config.invalid for invalid %s=%s', (key, value) => {
    expectConfigInvalid(() =>
      applyKimiModelEnvOverlay({ KIMI_MODEL_NAME: 'env-model', [key]: value }),
    );
  });

  it('strips env-only model values before write-back', () => {
    expect(
      kimiModelEnvOverlay.strip?.(
        'models',
        {
          user: { provider: 'p', model: 'm', maxContextSize: 1000 },
          [ENV_MODEL_ALIAS_KEY]: {
            provider: ENV_MODEL_PROVIDER_KEY,
            model: 'env-model',
            maxContextSize: 262144,
          },
        },
        {},
      ),
    ).toEqual({
      user: { provider: 'p', model: 'm', maxContextSize: 1000 },
    });

    expect(
      kimiModelEnvOverlay.strip?.('defaultModel', ENV_MODEL_ALIAS_KEY, {
        default_model: 'user',
      }),
    ).toBe('user');
    expect(kimiModelEnvOverlay.strip?.('modelOverrides', { temperature: 0.3 }, {})).toBeUndefined();
  });

  it('self-registers into ConfigRegistry without ModelService instantiation', () => {
    const freshRegistry = new ConfigRegistry();
    expect(freshRegistry.listEffectiveOverlays()).toContain(kimiModelEnvOverlay);
  });
});

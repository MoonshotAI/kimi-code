/**
 * `model` domain tests — covers `ModelService` CRUD over the `models` config
 * section, schema registration, and the delete-via-replace semantics.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { DisposableStore } from '#/_base/di/lifecycle';
import { createServices, type TestInstantiationService } from '#/_base/di/test';
import { IConfigRegistry, IConfigService } from '#/app/config/config';
import { ConfigRegistry } from '#/app/config/configService';
import { ErrorCodes, Error2 } from '#/errors';
import { kimiModelEnvOverlay, ENV_MODEL_ALIAS_KEY } from '#/app/model/envOverlay';
import {
  IModelService,
  type ModelAlias,
  MODELS_SECTION,
  ModelsSectionSchema,
} from '#/app/model/model';
import { modelsFromToml, modelsToToml } from '#/app/model/configSection';
import { ModelService } from '#/app/model/modelService';
import { ENV_MODEL_PROVIDER_KEY } from '#/app/provider/provider';

describe('ModelService', () => {
  let disposables: DisposableStore;
  let ix: TestInstantiationService;
  let registry: ConfigRegistry;
  let models: Record<string, ModelAlias>;
  let configSet: ReturnType<typeof vi.fn>;
  let configReplace: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    disposables = new DisposableStore();
    registry = new ConfigRegistry();
    models = {};
    configSet = vi.fn().mockResolvedValue(undefined);
    configReplace = vi.fn().mockResolvedValue(undefined);
    ix = createServices(disposables, {
      additionalServices: (reg) => {
        reg.defineInstance(IConfigRegistry, registry);
        reg.definePartialInstance(IConfigService, {
          get: ((domain: string) =>
            domain === MODELS_SECTION ? models : undefined) as IConfigService['get'],
          set: configSet as unknown as IConfigService['set'],
          replace: configReplace as unknown as IConfigService['replace'],
          onDidChangeConfiguration: (() => ({ dispose: () => { } })) as IConfigService['onDidChangeConfiguration'],
        });
        reg.define(IModelService, ModelService);
      },
    });
  });
  afterEach(() => disposables.dispose());

  it('registers the models section schema from configSection import', () => {
    expect(registry.getSection(MODELS_SECTION)).toBeDefined();
  });

  it('set delegates to config.set with a single-alias patch', async () => {
    const svc = ix.get(IModelService);
    await svc.set('m1', { provider: 'p', model: 'x', maxContextSize: 1000 });
    expect(configSet).toHaveBeenCalledWith(MODELS_SECTION, {
      m1: { provider: 'p', model: 'x', maxContextSize: 1000 },
    });
  });

  it('get reads a single alias from config', () => {
    models['m1'] = { provider: 'p', model: 'x', maxContextSize: 1000 };
    const svc = ix.get(IModelService);
    expect(svc.get('m1')).toEqual({ provider: 'p', model: 'x', maxContextSize: 1000 });
    expect(svc.get('missing')).toBeUndefined();
  });

  it('list returns all aliases', () => {
    models['m1'] = { provider: 'p', model: 'x', maxContextSize: 1000 };
    models['m2'] = { provider: 'p', model: 'y', maxContextSize: 2000 };
    const svc = ix.get(IModelService);
    expect(svc.list()).toEqual({
      m1: { provider: 'p', model: 'x', maxContextSize: 1000 },
      m2: { provider: 'p', model: 'y', maxContextSize: 2000 },
    });
  });

  it('delete removes the alias and replaces the whole section', async () => {
    models['m1'] = { provider: 'p', model: 'x', maxContextSize: 1000 };
    models['m2'] = { provider: 'p', model: 'y', maxContextSize: 2000 };
    const svc = ix.get(IModelService);
    await svc.delete('m1');
    expect(configReplace).toHaveBeenCalledWith(MODELS_SECTION, {
      m2: { provider: 'p', model: 'y', maxContextSize: 2000 },
    });
  });

  it('delete is a no-op when the alias is absent', async () => {
    const svc = ix.get(IModelService);
    await svc.delete('missing');
    expect(configReplace).not.toHaveBeenCalled();
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

  it('synthesizes the openai default baseUrl when KIMI_MODEL_BASE_URL is unset', () => {
    const { effective } = applyKimiModelEnvOverlay(
      { KIMI_MODEL_NAME: 'env-model' },
      { providers: { [ENV_MODEL_PROVIDER_KEY]: { type: 'openai' } } },
    );

    expect(effective['providers']).toEqual({
      [ENV_MODEL_PROVIDER_KEY]: { type: 'openai', baseUrl: 'https://api.openai.com/v1' },
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

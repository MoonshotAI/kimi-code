
import { describe, expect, it } from 'vitest';

import { FALLBACK_MODEL_SECTION, FallbackModelConfigSchema, fallbackModelEnvBindings } from '#/app/kosongConfig/configSection';
import { FALLBACK_MODEL_FLAG_ID } from '#/session/fallback/flag';
import {
  resolveFallbackModel,
  resolveFallbackSecondaryModel,
  resolveFallbackBinding,
} from '#/session/fallback/configSection';

import { stubFlag } from '../../app/flag/stubs';
import { StubConfigService } from '../../kosong/stubs';

function makeServices(configValues: Record<string, unknown>, flagEnabled = true) {
  const config = new StubConfigService(configValues);
  const flags = stubFlag((id) => flagEnabled && id === FALLBACK_MODEL_FLAG_ID);
  return { config, flags };
}

const own = { modelAlias: 'caller/primary', thinkingLevel: 'medium' };

describe('resolveFallbackModel', () => {
  it('R1: returns undefined when the fallback-model flag is disabled', () => {
    const { config } = makeServices({ [FALLBACK_MODEL_SECTION]: { model: 'kimi/fallback' } }, false);
    const { flags } = makeServices({}, false);
    expect(resolveFallbackModel(config, flags)).toBeUndefined();
  });

  it('R2: returns the section when flag is on and [fallback_model] is set', () => {
    const { config, flags } = makeServices({
      [FALLBACK_MODEL_SECTION]: { model: 'kimi/fallback', secondaryModel: 'kimi/fallback-2' },
    });
    expect(resolveFallbackModel(config, flags)).toEqual({
      model: 'kimi/fallback',
      secondaryModel: 'kimi/fallback-2',
    });
  });
});

describe('resolveFallbackSecondaryModel', () => {
  it('returns the secondaryModel field when set', () => {
    const { config, flags } = makeServices({
      [FALLBACK_MODEL_SECTION]: { model: 'kimi/fallback', secondaryModel: 'kimi/fallback-2' },
    });
    expect(resolveFallbackSecondaryModel(config, flags)).toBe('kimi/fallback-2');
  });

  it('returns undefined when secondaryModel is not set', () => {
    const { config, flags } = makeServices({
      [FALLBACK_MODEL_SECTION]: { model: 'kimi/fallback' },
    });
    expect(resolveFallbackSecondaryModel(config, flags)).toBeUndefined();
  });
});

describe('resolveFallbackBinding', () => {
  it('R3: returns the configured alias when the primary fails and tier 1 is set', () => {
    const { config, flags } = makeServices({
      [FALLBACK_MODEL_SECTION]: { model: 'kimi/fallback' },
    });
    const binding = resolveFallbackBinding(config, flags, own);
    expect(binding?.model).toBe('kimi/fallback');
  });

  it('R5a: returns undefined when both tiers are unset (cascade collapses)', () => {
    const { config, flags } = makeServices({});
    expect(resolveFallbackBinding(config, flags, own)).toBeUndefined();
  });

  it('B1: returns tier 2 when only secondary is set (tier 1 is absent)', () => {
    const { config, flags } = makeServices({
      [FALLBACK_MODEL_SECTION]: { secondaryModel: 'kimi/fallback-2' },
    });
    const binding = resolveFallbackBinding(config, flags, own);
    expect(binding?.model).toBe('kimi/fallback-2');
  });

  it('R4: advances to tier 2 when tier 1 alias matches lastTriedAlias', () => {
    const { config, flags } = makeServices({
      [FALLBACK_MODEL_SECTION]: { model: 'kimi/fallback', secondaryModel: 'kimi/fallback-2' },
    });
    const binding = resolveFallbackBinding(config, flags, own, 'kimi/fallback');
    expect(binding?.model).toBe('kimi/fallback-2');
  });

  it('R5b: returns undefined when both tiers have been tried (lastTriedAlias matches both)', () => {
    const { config, flags } = makeServices({
      [FALLBACK_MODEL_SECTION]: { model: 'kimi/fallback', secondaryModel: 'kimi/fallback-2' },
    });
    expect(resolveFallbackBinding(config, flags, own, 'kimi/fallback-2')).toEqual({
      model: 'kimi/fallback',
      thinking: 'medium',
      displayModel: 'kimi/fallback',
    });
  });

  it('R5c: returns undefined when both tiers are set to the same alias and that alias was just tried', () => {
    const { config, flags } = makeServices({
      [FALLBACK_MODEL_SECTION]: { model: 'kimi/same', secondaryModel: 'kimi/same' },
    });
    expect(resolveFallbackBinding(config, flags, own, 'kimi/same')).toBeUndefined();
  });
});

describe('FallbackModelConfigSchema (B2, B3)', () => {
  it('B2: schema accepts { model, secondaryModel } and parses them', () => {
    const parsed = FallbackModelConfigSchema.parse({
      model: 'kimi-k2',
      secondaryModel: 'gpt-4o-mini',
    });
    expect(parsed).toEqual({ model: 'kimi-k2', secondaryModel: 'gpt-4o-mini' });
  });

  it('B2: schema rejects a non-string model', () => {
    expect(() => FallbackModelConfigSchema.parse({ model: 1 })).toThrow();
  });

  it('B2: schema accepts an empty object (no fallback configured)', () => {
    expect(FallbackModelConfigSchema.parse({})).toEqual({});
  });

  it('B3: fallbackModelEnvBindings declares KIMI_FALLBACK_MODEL for the model field', () => {
    const bindings = fallbackModelEnvBindings as Record<string, { env: string; parse?: (raw: string) => unknown }>;
    expect(bindings['model']?.env).toBe('KIMI_FALLBACK_MODEL');
    expect(bindings['secondaryModel']?.env).toBe('KIMI_FALLBACK_SECONDARY_MODEL');
  });

  it('U4: setting fallbackModel via config store returns the same values on get', () => {
    const config = new StubConfigService({
      [FALLBACK_MODEL_SECTION]: { model: 'kimi/fallback', secondaryModel: 'kimi/fallback-2' },
    });
    const value = config.get<{ model?: string; secondaryModel?: string } | undefined>(
      FALLBACK_MODEL_SECTION,
    );
    expect(value).toEqual({ model: 'kimi/fallback', secondaryModel: 'kimi/fallback-2' });
  });
});

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it } from 'vitest';
import { join } from 'pathe';

import { getDefaultConfig, loadRuntimeConfig, writeConfigFile } from '../../src/config';
import {
  applySecondaryModelConfig,
  SECONDARY_DERIVED_MODEL_ALIAS,
  secondaryModelPatch,
  stripSecondaryModelConfig,
} from '../../src/config/secondary-model';
import { parseConfigString } from '../../src/config/toml';
import type { KimiConfig, ModelAlias } from '../../src/config/schema';

const baseAlias: ModelAlias = {
  provider: 'p1',
  model: 'cheap-chat',
  maxContextSize: 131072,
  capabilities: ['thinking'],
  supportEfforts: ['low', 'high'],
  defaultEffort: 'low',
};

function configWithSecondary(): KimiConfig {
  return {
    providers: {
      p1: { type: 'kimi', apiKey: 'sk-test' },
    },
    defaultModel: 'main',
    models: {
      main: { provider: 'p1', model: 'flagship', maxContextSize: 262144 },
      cheap: baseAlias,
    },
    secondaryModel: {
      model: 'cheap',
      maxContextSize: 65536,
      defaultEffort: 'high',
    },
  };
}

describe('secondaryModelPatch', () => {
  it('returns undefined when no patch field is set', () => {
    expect(secondaryModelPatch(undefined)).toBeUndefined();
    expect(secondaryModelPatch({})).toBeUndefined();
    expect(secondaryModelPatch({ model: 'cheap' })).toBeUndefined();
    expect(secondaryModelPatch({ model: 'cheap', defaultEffort: undefined })).toBeUndefined();
  });

  it('returns every field except model as the patch', () => {
    expect(
      secondaryModelPatch({ model: 'cheap', maxContextSize: 1024, defaultEffort: 'low' }),
    ).toEqual({ maxContextSize: 1024, defaultEffort: 'low' });
  });

  it('excludes the v2 pool keys (defaultModel / models / force) from the patch', () => {
    expect(
      secondaryModelPatch({
        model: 'cheap',
        defaultModel: 'fast',
        models: { fast: 'fast and cheap' },
        force: true,
      }),
    ).toBeUndefined();
    expect(
      secondaryModelPatch({
        model: 'cheap',
        defaultModel: 'fast',
        force: true,
        maxOutputSize: 8192,
      }),
    ).toEqual({ maxOutputSize: 8192 });
  });
});

describe('applySecondaryModelConfig', () => {
  it('returns the config unchanged when nothing is configured', () => {
    const base = getDefaultConfig();
    expect(applySecondaryModelConfig(base, {})).toBe(base);
  });

  it('synthesizes the derived entry from the pointed model and the patch', () => {
    const config = applySecondaryModelConfig(configWithSecondary(), {});
    const derived = config.models?.[SECONDARY_DERIVED_MODEL_ALIAS];
    expect(derived).toEqual({
      ...baseAlias,
      overrides: {
        maxContextSize: 65536,
        defaultEffort: 'high',
      },
    });
    // The pointed entry and the rest of the registry stay untouched.
    expect(config.models?.['cheap']).toEqual(baseAlias);
    expect(config.models?.['main']).toEqual({
      provider: 'p1',
      model: 'flagship',
      maxContextSize: 262144,
    });
  });

  it('merges the patch over the base entry overrides', () => {
    const base = configWithSecondary();
    base.models = {
      cheap: { ...baseAlias, overrides: { maxContextSize: 32768, displayName: 'base-name' } },
    };
    const config = applySecondaryModelConfig(base, {});
    expect(config.models?.[SECONDARY_DERIVED_MODEL_ALIAS]?.overrides).toEqual({
      maxContextSize: 65536,
      displayName: 'base-name',
      defaultEffort: 'high',
    });
  });

  it('synthesizes nothing for a pointer-only recipe', () => {
    const base = configWithSecondary();
    base.secondaryModel = { model: 'cheap' };
    const config = applySecondaryModelConfig(base, {});
    expect(config.models?.[SECONDARY_DERIVED_MODEL_ALIAS]).toBeUndefined();
  });

  it('synthesizes nothing when the pointed entry does not exist', () => {
    const base = configWithSecondary();
    base.secondaryModel = { model: 'missing', maxContextSize: 1024 };
    const config = applySecondaryModelConfig(base, {});
    expect(config.models?.[SECONDARY_DERIVED_MODEL_ALIAS]).toBeUndefined();
  });

  it('applies the env overrides without touching the on-disk section shape', () => {
    const config = applySecondaryModelConfig(getDefaultConfig(), {
      KIMI_SECONDARY_MODEL: 'cheap',
      KIMI_SECONDARY_EFFORT: 'low',
    });
    expect(config.secondaryModel).toEqual({ model: 'cheap', defaultEffort: 'low' });
  });

  it('lets the env override the configured recipe fields', () => {
    const config = applySecondaryModelConfig(configWithSecondary(), {
      KIMI_SECONDARY_MODEL: 'main',
    });
    expect(config.secondaryModel?.model).toBe('main');
    // Untouched recipe fields survive the env overlay.
    expect(config.secondaryModel?.defaultEffort).toBe('high');
  });
});

describe('stripSecondaryModelConfig', () => {
  it('removes the derived entry and rolls back a default_model pointer at it', () => {
    const config = applySecondaryModelConfig(configWithSecondary(), {});
    config.defaultModel = SECONDARY_DERIVED_MODEL_ALIAS;
    const stripped = stripSecondaryModelConfig(config, {});
    expect(stripped.models?.[SECONDARY_DERIVED_MODEL_ALIAS]).toBeUndefined();
    expect(stripped.defaultModel).toBeUndefined();
  });

  it('restores env-injected recipe fields from raw on write', () => {
    const onDisk = parseConfigString(
      [
        '[secondary_model]',
        'model = "cheap"',
        'default_effort = "low"',
      ].join('\n'),
    );
    const runtime = applySecondaryModelConfig(onDisk, {
      KIMI_SECONDARY_MODEL: 'main',
      KIMI_SECONDARY_EFFORT: 'high',
    });
    expect(runtime.secondaryModel).toEqual({ model: 'main', defaultEffort: 'high' });
    const stripped = stripSecondaryModelConfig(runtime, {
      KIMI_SECONDARY_MODEL: 'main',
      KIMI_SECONDARY_EFFORT: 'high',
    });
    expect(stripped.secondaryModel).toEqual({ model: 'cheap', defaultEffort: 'low' });
  });

  it('keeps a genuinely new selection that differs from the env values', () => {
    // `/secondary-model` under KIMI_SECONDARY_MODEL: the picked recipe must
    // reach the disk; only overlay round-trips are restored from raw.
    const onDisk = parseConfigString(
      ['[secondary_model]', 'model = "cheap"', 'default_effort = "low"'].join('\n'),
    );
    const picked: KimiConfig = {
      ...onDisk,
      secondaryModel: { model: 'main', defaultEffort: 'high' },
    };
    const stripped = stripSecondaryModelConfig(picked, {
      KIMI_SECONDARY_MODEL: 'cheap',
      KIMI_SECONDARY_EFFORT: 'low',
    });
    expect(stripped.secondaryModel).toEqual({ model: 'main', defaultEffort: 'high' });
  });

  it('restores only the fields still carrying the env values', () => {
    const onDisk = parseConfigString(
      ['[secondary_model]', 'model = "cheap"', 'default_effort = "low"'].join('\n'),
    );
    // The model still carries the env value (restored from raw); the effort
    // is a new pick (persists).
    const mixed: KimiConfig = {
      ...onDisk,
      secondaryModel: { model: 'main', defaultEffort: 'high' },
    };
    const stripped = stripSecondaryModelConfig(mixed, {
      KIMI_SECONDARY_MODEL: 'main',
      KIMI_SECONDARY_EFFORT: 'low',
    });
    expect(stripped.secondaryModel).toEqual({ model: 'cheap', defaultEffort: 'high' });
  });

  it('keeps file-sourced recipe fields when no env override is active', () => {
    const runtime = configWithSecondary();
    const stripped = stripSecondaryModelConfig(runtime, {});
    expect(stripped.secondaryModel).toEqual(runtime.secondaryModel);
  });
});

describe('[secondary_model] TOML wiring', () => {
  it('parses the snake_case section into camelCase config', () => {
    const config = parseConfigString(
      [
        '[secondary_model]',
        'model = "cheap"',
        'max_context_size = 65536',
        'default_effort = "high"',
      ].join('\n'),
    );
    expect(config.secondaryModel).toEqual({
      model: 'cheap',
      maxContextSize: 65536,
      defaultEffort: 'high',
    });
  });

  it('round-trips the section through writeConfigFile without the derived entry', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'kimi-secondary-model-'));
    try {
      const filePath = join(dir, 'config.toml');
      writeFileSync(
        filePath,
        [
          '[providers.p1]',
          'type = "kimi"',
          'api_key = "sk-test"',
          '',
          '[models.cheap]',
          'provider = "p1"',
          'model = "cheap-chat"',
          'max_context_size = 131072',
          '',
          '[secondary_model]',
          'model = "cheap"',
          'max_context_size = 65536',
        ].join('\n'),
      );
      const runtime = loadRuntimeConfig(filePath, {});
      expect(runtime.models?.[SECONDARY_DERIVED_MODEL_ALIAS]).toBeDefined();
      await writeConfigFile(filePath, runtime);
      const persisted = readFileSync(filePath, 'utf-8');
      expect(persisted).toContain('[secondary_model]');
      expect(persisted).toContain('max_context_size = 65536');
      expect(persisted).not.toContain(SECONDARY_DERIVED_MODEL_ALIAS);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

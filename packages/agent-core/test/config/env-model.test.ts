import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { describe, expect, it } from 'vitest';
import { join } from 'pathe';

import {
  applyEnvModelConfig,
  ENV_MODEL_ALIAS_KEY,
  ENV_MODEL_PROVIDER_KEY,
  stripEnvModelConfig,
} from '../../src/config/env-model';
import { getDefaultConfig, loadRuntimeConfig, readConfigFile, writeConfigFile } from '../../src/config';
import { KimiError } from '../../src/errors';

function apply(env: Record<string, string | undefined>) {
  return applyEnvModelConfig(getDefaultConfig(), env);
}

function expectConfigInvalid(fn: () => unknown): void {
  try {
    fn();
  } catch (error) {
    expect(error).toBeInstanceOf(KimiError);
    expect((error as KimiError).code).toBe('config.invalid');
    return;
  }
  throw new Error('expected function to throw');
}

const MIN = {
  KIMI_MODEL_NAME: 'kimi-for-coding',
  KIMI_MODEL_API_KEY: 'sk-test',
  KIMI_MODEL_MAX_CONTEXT_SIZE: '262144',
} as const;

describe('applyEnvModelConfig', () => {
  it('returns the config unchanged when KIMI_MODEL_NAME is absent', () => {
    const base = getDefaultConfig();
    expect(applyEnvModelConfig(base, {})).toBe(base);
  });

  it('throws when KIMI_MODEL_NAME is set but API key is missing', () => {
    expectConfigInvalid(() => apply({ KIMI_MODEL_NAME: 'm' }));
  });

  it('defaults max_context_size to 262144 (256K) when unset', () => {
    expect(
      apply({ KIMI_MODEL_NAME: 'm', KIMI_MODEL_API_KEY: 'k' })
        .models?.[ENV_MODEL_ALIAS_KEY]?.maxContextSize,
    ).toBe(262144);
  });

  it.each(['abc', '0', '1.5', '-1'])(
    'throws when max_context_size is %s',
    (value) => {
      expectConfigInvalid(() =>
        apply({ ...MIN, KIMI_MODEL_MAX_CONTEXT_SIZE: value }),
      );
    },
  );

  it('synthesizes a kimi provider and model from the minimal set', () => {
    const config = apply({ ...MIN });
    expect(config.providers[ENV_MODEL_PROVIDER_KEY]).toEqual({
      type: 'kimi',
      apiKey: 'sk-test',
      baseUrl: 'https://api.moonshot.ai/v1',
    });
    expect(config.models?.[ENV_MODEL_ALIAS_KEY]).toEqual({
      provider: ENV_MODEL_PROVIDER_KEY,
      model: 'kimi-for-coding',
      maxContextSize: 262144,
      capabilities: ['image_in', 'thinking'],
    });
    expect(config.defaultModel).toBe(ENV_MODEL_ALIAS_KEY);
  });

  it('applies provider type and its default base url', () => {
    expect(apply({ ...MIN, KIMI_MODEL_PROVIDER_TYPE: 'openai' })
      .providers[ENV_MODEL_PROVIDER_KEY]).toMatchObject({
      type: 'openai',
      baseUrl: 'https://api.openai.com/v1',
    });
    const anthropic = apply({ ...MIN, KIMI_MODEL_PROVIDER_TYPE: 'anthropic' })
      .providers[ENV_MODEL_PROVIDER_KEY];
    expect(anthropic).toBeDefined();
    expect(anthropic?.type).toBe('anthropic');
    expect(anthropic?.baseUrl).toBeUndefined();
  });

  it('rejects unsupported provider types', () => {
    expectConfigInvalid(() =>
      apply({ ...MIN, KIMI_MODEL_PROVIDER_TYPE: 'google-genai' }),
    );
  });

  it('lets an explicit base url override the default', () => {
    expect(
      apply({ ...MIN, KIMI_MODEL_BASE_URL: 'https://api.example.com/v1' })
        .providers[ENV_MODEL_PROVIDER_KEY]?.baseUrl,
    ).toBe('https://api.example.com/v1');
  });

  it('parses comma-separated capabilities (trimmed, lowercased)', () => {
    expect(
      apply({ ...MIN, KIMI_MODEL_CAPABILITIES: 'Image_In, thinking ,' })
        .models?.[ENV_MODEL_ALIAS_KEY]?.capabilities,
    ).toEqual(['image_in', 'thinking']);
  });

  it('sets display_name only when provided', () => {
    const withoutName = apply({ ...MIN }).models?.[ENV_MODEL_ALIAS_KEY];
    expect(withoutName).toBeDefined();
    expect(withoutName?.displayName).toBeUndefined();
    expect(
      apply({ ...MIN, KIMI_MODEL_DISPLAY_NAME: 'Custom Model' })
        .models?.[ENV_MODEL_ALIAS_KEY]?.displayName,
    ).toBe('Custom Model');
  });

  it('writes type-specific fields and validates max_output_size', () => {
    const alias = apply({
      ...MIN,
      KIMI_MODEL_PROVIDER_TYPE: 'anthropic',
      KIMI_MODEL_MAX_OUTPUT_SIZE: '8192',
      KIMI_MODEL_REASONING_KEY: 'reasoning',
    }).models?.[ENV_MODEL_ALIAS_KEY];
    expect(alias?.maxOutputSize).toBe(8192);
    expect(alias?.reasoningKey).toBe('reasoning');
    expectConfigInvalid(() =>
      apply({ ...MIN, KIMI_MODEL_MAX_OUTPUT_SIZE: 'nope' }),
    );
  });

  it('maps the thinking effort variable', () => {
    const config = apply({
      ...MIN,
      KIMI_MODEL_THINKING_EFFORT: 'high',
    });
    expect(config.thinking).toMatchObject({ effort: 'high' });
    expect(config.thinking?.enabled).toBeUndefined();
  });

  it('maps KIMI_MODEL_ADAPTIVE_THINKING onto the alias', () => {
    expect(
      apply({ ...MIN, KIMI_MODEL_ADAPTIVE_THINKING: 'true' })
        .models?.[ENV_MODEL_ALIAS_KEY]?.adaptiveThinking,
    ).toBe(true);
    expect(
      apply({ ...MIN, KIMI_MODEL_ADAPTIVE_THINKING: 'false' })
        .models?.[ENV_MODEL_ALIAS_KEY]?.adaptiveThinking,
    ).toBe(false);
    expect(
      apply({ ...MIN }).models?.[ENV_MODEL_ALIAS_KEY]?.adaptiveThinking,
    ).toBeUndefined();
  });

  it('rejects an invalid KIMI_MODEL_ADAPTIVE_THINKING', () => {
    expectConfigInvalid(() =>
      apply({ ...MIN, KIMI_MODEL_ADAPTIVE_THINKING: 'maybe' }),
    );
  });

  it('preserves unrelated config fields', () => {
    const base = getDefaultConfig();
    base.defaultPermissionMode = 'auto';
    const config = applyEnvModelConfig(base, { ...MIN });
    expect(config.defaultPermissionMode).toBe('auto');
  });
});

describe('loadRuntimeConfig vs readConfigFile (write-back isolation)', () => {
  it('injects the env model into runtime config but readConfigFile stays clean', () => {
    const dir = mkdtempSync(join(tmpdir(), 'kimi-env-model-'));
    const path = join(dir, 'config.toml');
    writeFileSync(
      path,
      'default_model = "x"\n[providers.x]\ntype = "kimi"\napi_key = "k"\n[models.x]\nprovider = "x"\nmodel = "x"\nmax_context_size = 1000\n',
    );
    try {
      const env = { ...MIN };
      // Write-back path uses readConfigFile: no synthesized entries.
      const onDisk = readConfigFile(path);
      expect(onDisk.providers[ENV_MODEL_PROVIDER_KEY]).toBeUndefined();
      expect(onDisk.defaultModel).toBe('x');
      // Runtime path uses loadRuntimeConfig: synthesized entries present.
      const runtime = loadRuntimeConfig(path, env);
      expect(runtime.providers[ENV_MODEL_PROVIDER_KEY]).toBeDefined();
      expect(runtime.defaultModel).toBe(ENV_MODEL_ALIAS_KEY);
      // Existing config is preserved alongside the synthesized model.
      expect(runtime.providers['x']).toBeDefined();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('stripEnvModelConfig (write-back guard)', () => {
  it('removes synthesized env provider/model and clears the env default_model', () => {
    const runtime = applyEnvModelConfig(getDefaultConfig(), { ...MIN });
    const stripped = stripEnvModelConfig(runtime);
    expect(stripped.providers[ENV_MODEL_PROVIDER_KEY]).toBeUndefined();
    expect(stripped.models?.[ENV_MODEL_ALIAS_KEY]).toBeUndefined();
    expect(stripped.defaultModel).toBeUndefined();
  });

  it('keeps user providers/models and a non-env default_model', () => {
    const config = getDefaultConfig();
    config.providers['kimi'] = { type: 'kimi', apiKey: 'k', baseUrl: 'https://x/v1' };
    config.providers[ENV_MODEL_PROVIDER_KEY] = { type: 'kimi', apiKey: 'env-key' };
    config.models = {
      'my-model': { provider: 'kimi', model: 'm', maxContextSize: 1000 },
      [ENV_MODEL_ALIAS_KEY]: { provider: ENV_MODEL_PROVIDER_KEY, model: 'x', maxContextSize: 1000 },
    };
    config.defaultModel = 'my-model';
    const stripped = stripEnvModelConfig(config);
    expect(stripped.providers['kimi']).toBeDefined();
    expect(stripped.models?.['my-model']).toBeDefined();
    expect(stripped.defaultModel).toBe('my-model');
    expect(stripped.providers[ENV_MODEL_PROVIDER_KEY]).toBeUndefined();
    expect(stripped.models?.[ENV_MODEL_ALIAS_KEY]).toBeUndefined();
  });
});

describe('writeConfigFile never persists the env model', () => {
  it('strips env entries (incl. thinking) when a runtime config is written back', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'kimi-env-write-'));
    const path = join(dir, 'config.toml');
    writeFileSync(
      path,
      'default_model = "x"\n[thinking]\neffort = "medium"\n[providers.x]\ntype = "kimi"\napi_key = "k"\n[models.x]\nprovider = "x"\nmodel = "x"\nmax_context_size = 1000\n',
    );
    try {
      // Reproduces the /login round-trip: a runtime config carrying the env
      // model AND env thinking overrides is written back and must persist none.
      const runtime = loadRuntimeConfig(path, {
        ...MIN,
        KIMI_MODEL_THINKING_EFFORT: 'high',
      });
      // Sanity: env overrides are active at runtime.
      expect(runtime.providers[ENV_MODEL_PROVIDER_KEY]).toBeDefined();
      expect(runtime.thinking?.effort).toBe('high');

      await writeConfigFile(path, runtime);
      const onDisk = readConfigFile(path);
      // Env provider/model are gone; the user's stay; default_model is restored.
      expect(onDisk.providers[ENV_MODEL_PROVIDER_KEY]).toBeUndefined();
      expect(onDisk.models?.[ENV_MODEL_ALIAS_KEY]).toBeUndefined();
      expect(onDisk.providers['x']).toBeDefined();
      expect(onDisk.models?.['x']).toBeDefined();
      expect(onDisk.defaultModel).toBe('x');
      // Thinking is restored to the on-disk original, not the env override.
      expect(onDisk.thinking?.effort).toBe('medium');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('output never contains env-injected identifiers', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'kimi-env-write2-'));
    const path = join(dir, 'config.toml');
    writeFileSync(
      path,
      'default_model = "x"\n[providers.x]\ntype = "kimi"\napi_key = "k"\n[models.x]\nprovider = "x"\nmodel = "x"\nmax_context_size = 1000\n',
    );
    try {
      const runtime = loadRuntimeConfig(path, {
        ...MIN,
        KIMI_MODEL_THINKING_EFFORT: 'low',
      });
      await writeConfigFile(path, runtime);
      const text = readFileSync(path, 'utf-8');
      // Hard invariant: no env-synthesized identifiers ever reach config.toml.
      expect(text).not.toContain(ENV_MODEL_PROVIDER_KEY);
      expect(text).not.toContain(ENV_MODEL_ALIAS_KEY);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});


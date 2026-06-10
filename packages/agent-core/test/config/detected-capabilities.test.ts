import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { describe, expect, it } from 'vitest';
import { join } from 'pathe';

import {
  applyDetectedModelCapabilities,
  stripDetectedModelCapabilities,
} from '../../src/config/detected-capabilities';
import { getDefaultConfig, loadRuntimeConfig } from '../../src/config';
import type { KimiConfig, ModelAlias } from '../../src/config';

function configWith(model: Partial<ModelAlias> & { model: string }): KimiConfig {
  return {
    ...getDefaultConfig(),
    providers: {
      anthropic: { type: 'anthropic', apiKey: 'sk-test' },
    },
    models: {
      main: { provider: 'anthropic', maxContextSize: 1000000, ...model },
    },
  };
}

describe('applyDetectedModelCapabilities', () => {
  it('injects thinking + always_thinking for models kosong knows cannot turn thinking off', () => {
    const result = applyDetectedModelCapabilities(configWith({ model: 'claude-fable-5' }));
    expect(result.models?.['main']?.capabilities).toEqual(['thinking', 'always_thinking']);
  });

  it('appends only the missing capabilities without duplicating', () => {
    const appended = applyDetectedModelCapabilities(
      configWith({ model: 'claude-fable-5', capabilities: ['image_in', 'thinking'] }),
    );
    expect(appended.models?.['main']?.capabilities).toEqual([
      'image_in',
      'thinking',
      'always_thinking',
    ]);

    const declared = configWith({
      model: 'claude-fable-5',
      capabilities: ['thinking', 'always_thinking'],
    });
    expect(applyDetectedModelCapabilities(declared)).toBe(declared);
  });

  it('leaves toggleable-thinking models untouched and returns the same config object', () => {
    const config = configWith({ model: 'claude-opus-4-6' });
    expect(applyDetectedModelCapabilities(config)).toBe(config);
    expect(config.models?.['main']?.capabilities).toBeUndefined();
  });

  it('skips models whose provider is missing instead of failing config load', () => {
    const config = configWith({ model: 'claude-fable-5' });
    config.models = { main: { ...config.models!['main']!, provider: 'gone' } };
    expect(applyDetectedModelCapabilities(config)).toBe(config);
  });
});

describe('stripDetectedModelCapabilities', () => {
  it('strips detected capabilities written back from an enriched getConfig snapshot', () => {
    const disk = configWith({ model: 'claude-fable-5' });
    const runtime = applyDetectedModelCapabilities(disk);

    const stripped = stripDetectedModelCapabilities({ models: runtime.models }, disk);
    // The whole capabilities array came from detection — it must not persist.
    expect(stripped.models?.['main']?.capabilities).toBeUndefined();
  });

  it('preserves capabilities the user declared on disk, even detected ones', () => {
    const disk = configWith({
      model: 'claude-fable-5',
      capabilities: ['thinking', 'always_thinking'],
    });
    const patch = { models: applyDetectedModelCapabilities(disk).models };
    expect(stripDetectedModelCapabilities(patch, disk)).toBe(patch);
  });

  it('preserves declarations detection cannot reproduce (catalog-declared kimi models)', () => {
    const disk: KimiConfig = {
      ...getDefaultConfig(),
      providers: { kimi: { type: 'kimi', apiKey: 'sk-test' } },
      models: {},
    };
    // A catalog-added always-reasoning kimi model lands as a brand-new alias
    // in the patch; kosong has no built-in knowledge for kimi models, so the
    // declaration must survive verbatim.
    const patch = {
      models: {
        'kimi-next': {
          provider: 'kimi',
          model: 'kimi-next-thinking',
          maxContextSize: 262144,
          capabilities: ['thinking', 'always_thinking'],
        },
      },
    };
    expect(stripDetectedModelCapabilities(patch, disk)).toBe(patch);
  });

  it('strips only the detected entries from a mixed declared + detected array', () => {
    const disk = configWith({ model: 'claude-fable-5', capabilities: ['image_in'] });
    const runtime = applyDetectedModelCapabilities(disk);
    expect(runtime.models?.['main']?.capabilities).toEqual([
      'image_in',
      'thinking',
      'always_thinking',
    ]);

    const stripped = stripDetectedModelCapabilities({ models: runtime.models }, disk);
    expect(stripped.models?.['main']?.capabilities).toEqual(['image_in']);
  });

  it('resolves the provider from the patch when the alias is new', () => {
    const disk: KimiConfig = { ...getDefaultConfig(), providers: {}, models: {} };
    const patch = {
      providers: { anthropic: { type: 'anthropic' as const, apiKey: 'sk' } },
      models: {
        fable: {
          provider: 'anthropic',
          model: 'claude-fable-5',
          maxContextSize: 1000000,
          capabilities: ['thinking', 'always_thinking'],
        },
      },
    };
    const stripped = stripDetectedModelCapabilities(patch, disk);
    expect(stripped.models?.['fable']?.capabilities).toBeUndefined();
  });
});

describe('loadRuntimeConfig capability detection', () => {
  it('exposes detected capabilities on runtime config loaded from disk', () => {
    const dir = mkdtempSync(join(tmpdir(), 'kimi-detected-caps-'));
    try {
      const file = join(dir, 'config.toml');
      writeFileSync(
        file,
        [
          'default_model = "main"',
          '',
          '[providers.anthropic]',
          'type = "anthropic"',
          'api_key = "sk-test"',
          '',
          '[models.main]',
          'provider = "anthropic"',
          'model = "claude-fable-5"',
          'max_context_size = 1000000',
        ].join('\n'),
      );
      const config = loadRuntimeConfig(file, {});
      expect(config.models?.['main']?.capabilities).toEqual(['thinking', 'always_thinking']);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

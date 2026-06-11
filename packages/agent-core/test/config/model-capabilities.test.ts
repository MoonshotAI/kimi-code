import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { describe, expect, it } from 'vitest';
import { join } from 'pathe';

import { loadRuntimeConfig, resolveAliasCapabilities } from '../../src/config';
import type { ModelAlias } from '../../src/config';

const fable: ModelAlias = {
  provider: 'anthropic',
  model: 'claude-fable-5',
  maxContextSize: 1_000_000,
};

describe('resolveAliasCapabilities', () => {
  it('detects always-thinking models from kosong knowledge without a declaration', () => {
    const resolved = resolveAliasCapabilities('anthropic', fable);
    expect(resolved.always_thinking).toBe(true);
    expect(resolved.thinking).toBe(true);
    expect(resolved.image_in).toBe(true);
    expect(resolved.max_context_tokens).toBe(1_000_000);
  });

  it('leaves toggleable models without always_thinking', () => {
    const resolved = resolveAliasCapabilities('anthropic', {
      ...fable,
      model: 'claude-opus-4-6',
    });
    expect(resolved.thinking).toBe(true);
    expect(resolved.always_thinking).toBeUndefined();
  });

  it('honors declared strings case-insensitively when detection knows nothing', () => {
    // An uncatalogued model name resolves to UNKNOWN_CAPABILITY, so only the
    // declared strings can produce capabilities here.
    const resolved = resolveAliasCapabilities('anthropic', {
      provider: 'custom',
      model: 'uncatalogued-model',
      maxContextSize: 262144,
      capabilities: [' Always_Thinking '],
    });
    expect(resolved.always_thinking).toBe(true);
    // always_thinking implies thinking even when only the lone string is declared.
    expect(resolved.thinking).toBe(true);
  });

  it('resolves declared-only when the provider type is unknown', () => {
    const resolved = resolveAliasCapabilities(undefined, {
      ...fable,
      capabilities: ['image_in'],
    });
    expect(resolved.image_in).toBe(true);
    expect(resolved.thinking).toBe(false);
    expect(resolved.always_thinking).toBeUndefined();
  });
});

describe('loadRuntimeConfig stays a pure declaration snapshot', () => {
  it('does not materialize detected capabilities into model aliases', () => {
    const dir = mkdtempSync(join(tmpdir(), 'kimi-model-caps-'));
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
      // Detection is resolved at read time via resolveAliasCapabilities, never
      // by mutating the runtime config — getConfig→setConfig round-trips must
      // persist snapshots verbatim (no strip step on the write path).
      expect(config.models?.['main']?.capabilities).toBeUndefined();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

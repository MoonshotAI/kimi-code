import { describe, expect, it } from 'vitest';

import type { KimiHarness, ModelAlias } from '@moonshot-ai/kimi-code-sdk';

import {
  deriveAlwaysThinking,
  deriveDefaultThinkingEffort,
  deriveThinkingSupported,
  listModelsFromHarness,
} from '../src/model-catalog';

function alias(model: string, capabilities?: readonly string[]): ModelAlias {
  return {
    model,
    ...(capabilities !== undefined ? { capabilities } : {}),
  } as unknown as ModelAlias;
}

describe('deriveThinkingSupported', () => {
  it('treats a declared always_thinking capability as thinking-supported', () => {
    expect(deriveThinkingSupported(alias('custom-model', ['always_thinking']))).toBe(true);
  });

  it('keeps the existing thinking-capability and name-heuristic triggers', () => {
    expect(deriveThinkingSupported(alias('custom-model', ['thinking']))).toBe(true);
    expect(deriveThinkingSupported(alias('some-thinking-model'))).toBe(true);
    expect(deriveThinkingSupported(alias('plain-model'))).toBe(false);
  });
});

describe('deriveAlwaysThinking', () => {
  it('reads the declared always_thinking capability', () => {
    expect(deriveAlwaysThinking(alias('custom-model', ['thinking', 'always_thinking']))).toBe(true);
    expect(deriveAlwaysThinking(alias('custom-model', ['thinking']))).toBe(false);
  });

  it('does not infer always-thinking from the model name', () => {
    // Name heuristics keep working for thinkingSupported, but only the
    // server-declared capability may lock the toggle to on.
    expect(deriveAlwaysThinking(alias('some-thinking-model'))).toBe(false);
  });
});

describe('deriveDefaultThinkingEffort', () => {
  it('uses overridden supportEfforts and defaultEffort', () => {
    expect(
      deriveDefaultThinkingEffort({
        ...alias('custom-model', ['thinking']),
        supportEfforts: ['low', 'high', 'max'],
        defaultEffort: 'max',
        overrides: { supportEfforts: ['low', 'high'], defaultEffort: 'high' },
      }),
    ).toBe('high');
  });
});

describe('listModelsFromHarness', () => {
  it('advertises thinking with a high default for an unknown model using the Anthropic protocol', async () => {
    const harness = {
      getConfig: async () => ({
        providers: {
          custom: { type: 'anthropic' },
        },
        models: {
          custom: {
            provider: 'custom',
            model: 'custom-anthropic-model',
            maxContextSize: 200000,
            protocol: 'anthropic',
          },
        },
      }),
    } as unknown as KimiHarness;

    await expect(listModelsFromHarness(harness)).resolves.toEqual([
      {
        id: 'custom',
        name: 'custom-anthropic-model',
        thinkingSupported: true,
        alwaysThinking: false,
        defaultThinkingEffort: 'high',
      },
    ]);
  });

  it('advertises thinking for a flat providerless model using the Anthropic protocol', async () => {
    const harness = {
      getConfig: async () => ({
        models: {
          custom: {
            model: 'custom-anthropic-model',
            maxContextSize: 200000,
            protocol: 'anthropic',
          },
        },
      }),
    } as unknown as KimiHarness;

    await expect(listModelsFromHarness(harness)).resolves.toEqual([
      {
        id: 'custom',
        name: 'custom-anthropic-model',
        thinkingSupported: true,
        alwaysThinking: false,
        defaultThinkingEffort: 'high',
      },
    ]);
  });

  it('does not advertise thinking for an unknown model on a Kimi provider using the Anthropic protocol', async () => {
    const harness = {
      getConfig: async () => ({
        providers: {
          'managed:kimi-code': { type: 'kimi' },
        },
        models: {
          custom: {
            provider: 'managed:kimi-code',
            model: 'custom-anthropic-model',
            maxContextSize: 200000,
            protocol: 'anthropic',
          },
        },
      }),
    } as unknown as KimiHarness;

    await expect(listModelsFromHarness(harness)).resolves.toEqual([
      {
        id: 'custom',
        name: 'custom-anthropic-model',
        thinkingSupported: false,
        alwaysThinking: false,
        defaultThinkingEffort: 'on',
      },
    ]);
  });

  it('derives thinking support from the provider type when the alias omits protocol', async () => {
    // Same shape the runtime sees for `[providers.compat] type = "anthropic"`
    // + a custom-named model with no alias-level protocol: the provider
    // context must make the catalog agree with ProviderManager, which infers
    // the latest Anthropic profile (thinking-capable, default effort high).
    const harness = {
      getConfig: async () => ({
        defaultProvider: 'compat',
        providers: {
          compat: { type: 'anthropic', apiKey: 'test-key', baseUrl: 'https://api.example.test' },
        },
        models: {
          custom: {
            provider: 'compat',
            model: 'joint-model-0714-vibe',
            maxContextSize: 200000,
          },
        },
      }),
    } as unknown as KimiHarness;

    await expect(listModelsFromHarness(harness)).resolves.toEqual([
      {
        id: 'custom',
        name: 'joint-model-0714-vibe',
        thinkingSupported: true,
        alwaysThinking: false,
        defaultThinkingEffort: 'high',
      },
    ]);
  });
});

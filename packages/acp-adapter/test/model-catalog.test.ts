import { describe, expect, it } from 'vitest';

import type { KimiHarness, ModelAlias } from '@moonshot-ai/kimi-code-sdk';

import {
  deriveAlwaysThinking,
  deriveDefaultThinkingEffort,
  deriveSupportEfforts,
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

describe('deriveSupportEfforts', () => {
  it('returns the declared efforts after override resolution', () => {
    expect(
      deriveSupportEfforts({
        ...alias('custom-model', ['thinking']),
        supportEfforts: ['low', 'high', 'max'],
        overrides: { supportEfforts: ['low', 'high'] },
      }),
    ).toEqual(['low', 'high']);
  });

  it('drops blank entries and yields an empty list for boolean models', () => {
    expect(
      deriveSupportEfforts({ ...alias('custom-model', ['thinking']), supportEfforts: [''] }),
    ).toEqual([]);
    expect(deriveSupportEfforts(alias('custom-model', ['thinking']))).toEqual([]);
  });
});

describe('listModelsFromHarness', () => {
  it('advertises thinking with a high default for an unknown Claude-marked model using the Anthropic protocol', async () => {
    const harness = {
      getConfig: async () => ({
        providers: {
          custom: { type: 'anthropic' },
        },
        models: {
          custom: {
            provider: 'custom',
            model: 'custom-claude-model',
            maxContextSize: 200000,
            protocol: 'anthropic',
          },
        },
      }),
    } as unknown as KimiHarness;

    await expect(listModelsFromHarness(harness)).resolves.toEqual([
      {
        id: 'custom',
        name: 'custom-claude-model',
        thinkingSupported: true,
        alwaysThinking: false,
        supportEfforts: ['low', 'medium', 'high', 'xhigh', 'max'],
        defaultThinkingEffort: 'high',
      },
    ]);
  });

  it('does not advertise thinking for a clearly non-Claude model using the Anthropic protocol', async () => {
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
        thinkingSupported: false,
        alwaysThinking: false,
        supportEfforts: [],
        defaultThinkingEffort: 'on',
      },
    ]);
  });

  it('advertises thinking for a flat providerless Claude-marked model using the Anthropic protocol', async () => {
    const harness = {
      getConfig: async () => ({
        models: {
          custom: {
            model: 'custom-claude-model',
            maxContextSize: 200000,
            protocol: 'anthropic',
          },
        },
      }),
    } as unknown as KimiHarness;

    await expect(listModelsFromHarness(harness)).resolves.toEqual([
      {
        id: 'custom',
        name: 'custom-claude-model',
        thinkingSupported: true,
        alwaysThinking: false,
        supportEfforts: ['low', 'medium', 'high', 'xhigh', 'max'],
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
        supportEfforts: [],
        defaultThinkingEffort: 'on',
      },
    ]);
  });

  it('derives thinking support from the provider type when the alias omits protocol', async () => {
    // Same shape the runtime sees for `[providers.compat] type = "anthropic"`
    // + a Claude-marked custom model with no alias-level protocol: the
    // provider context must make the catalog agree with ProviderManager,
    // which infers the latest Anthropic profile (thinking-capable, default
    // effort high). Clearly non-Claude names get no inferred profile.
    const harness = {
      getConfig: async () => ({
        defaultProvider: 'compat',
        providers: {
          compat: { type: 'anthropic', apiKey: 'test-key', baseUrl: 'https://api.example.test' },
        },
        models: {
          custom: {
            provider: 'compat',
            model: 'joint-claude-0714-vibe',
            maxContextSize: 200000,
          },
        },
      }),
    } as unknown as KimiHarness;

    await expect(listModelsFromHarness(harness)).resolves.toEqual([
      {
        id: 'custom',
        name: 'joint-claude-0714-vibe',
        thinkingSupported: true,
        alwaysThinking: false,
        supportEfforts: ['low', 'medium', 'high', 'xhigh', 'max'],
        defaultThinkingEffort: 'high',
      },
    ]);
  });
});

import { describe, expect, it, vi } from 'vitest';

import type { KimiHarness } from '@moonshot-ai/kimi-code-sdk';

import {
  buildModelOption,
  buildModeOption,
  buildSessionConfigOptions,
  buildThinkingOption,
} from '../src/config-options';
import type { AcpModelEntry } from '../src/model-catalog';

function makeHarnessWithModels(
  entries: ReadonlyArray<{
    id: string;
    model?: string;
    displayName?: string;
    capabilities?: readonly string[];
    protocol?: 'anthropic';
    providerType?: 'anthropic' | 'kimi' | 'openai';
  }>,
): { harness: KimiHarness; getConfig: ReturnType<typeof vi.fn> } {
  // Mirror the `listAvailableModels` derivation: `id` is the config map
  // key, `model` defaults to id, `displayName` to model. The test fixtures
  // below pick names that exercise the three thinkingSupported triggers
  // (name regex, capabilities array, toggleable allow-list). Entries with a
  // `providerType` also get a backing provider so provider-aware derivation
  // (e.g. the Anthropic fallback profile) can resolve the provider's type.
  const models: Record<string, {
    provider?: string;
    model: string;
    displayName?: string;
    capabilities?: readonly string[];
    protocol?: 'anthropic';
  }> = {};
  const providers: Record<string, { type: string }> = {};
  for (const entry of entries) {
    const providerName = `provider-${entry.id}`;
    models[entry.id] = {
      ...(entry.providerType !== undefined ? { provider: providerName } : {}),
      model: entry.model ?? entry.id,
      ...(entry.displayName !== undefined ? { displayName: entry.displayName } : {}),
      ...(entry.capabilities !== undefined ? { capabilities: entry.capabilities } : {}),
      protocol: entry.protocol,
    };
    if (entry.providerType !== undefined) {
      providers[providerName] = { type: entry.providerType };
    }
  }
  const getConfig = vi.fn(async () => ({ models, providers }));
  return { harness: { getConfig } as unknown as KimiHarness, getConfig };
}

describe('buildModelOption', () => {
  it('emits exactly one option per catalog row (Phase 15: no inlined `,thinking` variant rows)', () => {
    const models: readonly AcpModelEntry[] = [
      { id: 'alpha', name: 'Alpha', thinkingSupported: true, defaultThinkingEffort: 'on' },
      { id: 'beta', name: 'Beta', thinkingSupported: false, defaultThinkingEffort: 'on' },
    ];

    const option = buildModelOption(models, 'alpha');

    expect(option.id).toBe('model');
    expect(option.category).toBe('model');
    expect(option.name).toBe('Model');
    if (option.type !== 'select') {
      throw new Error('expected a SessionConfigSelect option');
    }
    expect(option.currentValue).toBe('alpha');
    expect(option.options).toHaveLength(2);
    const projected = option.options.map((entry) =>
      'value' in entry ? { value: entry.value, name: entry.name } : null,
    );
    expect(projected).toEqual([
      { value: 'alpha', name: 'Alpha' },
      { value: 'beta', name: 'Beta' },
    ]);
  });

  it('treats `currentValue` as the bare base model id — Phase 15 keeps the snapshot suffix-free', () => {
    const models: readonly AcpModelEntry[] = [
      { id: 'kimi-v2', name: 'Kimi v2', thinkingSupported: true, defaultThinkingEffort: 'on' },
    ];

    const option = buildModelOption(models, 'kimi-v2');
    if (option.type !== 'select') {
      throw new Error('expected a SessionConfigSelect option');
    }
    expect(option.currentValue).toBe('kimi-v2');
    expect(option.options.map((o) => ('value' in o ? o.value : ''))).toEqual(['kimi-v2']);
  });

  it('handles an empty catalog without emitting any options', () => {
    const option = buildModelOption([], '');
    if (option.type !== 'select') {
      throw new Error('expected a SessionConfigSelect option');
    }
    expect(option.options).toHaveLength(0);
    expect(option.currentValue).toBe('');
  });
});

describe('buildThinkingOption', () => {
  it('produces a `type:"select"` `category:"thought_level"` option with `off`/`on` entries for binary models', () => {
    const on = buildThinkingOption('on', undefined);
    expect(on.type).toBe('select');
    expect(on.id).toBe('thinking');
    expect(on.category).toBe('thought_level');
    expect(on.name).toBe('Thinking');
    if (on.type !== 'select') throw new Error('expected SessionConfigSelect');
    expect(on.currentValue).toBe('on');
    expect(on.options.map((o) => ('value' in o ? o.value : ''))).toEqual(['off', 'on']);
    expect(on.options.map((o) => ('name' in o ? o.name : ''))).toEqual(['Off', 'On']);

    const off = buildThinkingOption('off', undefined);
    if (off.type !== 'select') throw new Error('expected SessionConfigSelect');
    expect(off.currentValue).toBe('off');
  });

  it('exposes effort levels when the model advertises supportEfforts', () => {
    const option = buildThinkingOption('medium', ['low', 'medium', 'high']);
    if (option.type !== 'select') throw new Error('expected SessionConfigSelect');
    expect(option.currentValue).toBe('medium');
    expect(option.options.map((o) => ('value' in o ? o.value : ''))).toEqual([
      'off',
      'low',
      'medium',
      'high',
    ]);
    expect(option.options.map((o) => ('name' in o ? o.name : ''))).toEqual([
      'Off',
      'Low',
      'Medium',
      'High',
    ]);
  });

  it('falls back to `off` when the current effort is not in supportEfforts', () => {
    const option = buildThinkingOption('xhigh', ['low', 'medium', 'high']);
    if (option.type !== 'select') throw new Error('expected SessionConfigSelect');
    expect(option.currentValue).toBe('off');
  });

  it('collapses to a single locked "on" entry for always-thinking models without effort lists', () => {
    const locked = buildThinkingOption('on', undefined, true);
    if (locked.type !== 'select') throw new Error('expected SessionConfigSelect');
    expect(locked.currentValue).toBe('on');
    expect(locked.options.map((o) => ('value' in o ? o.value : ''))).toEqual(['on']);
    expect(locked.options.map((o) => ('name' in o ? o.name : ''))).toEqual(['On']);
  });

  it('shows effort choices without an off entry for always-thinking models with supportEfforts', () => {
    const locked = buildThinkingOption('high', ['low', 'medium', 'high'], true);
    if (locked.type !== 'select') throw new Error('expected SessionConfigSelect');
    expect(locked.currentValue).toBe('high');
    expect(locked.options.map((o) => ('value' in o ? o.value : ''))).toEqual([
      'low',
      'medium',
      'high',
    ]);
    expect(locked.options.map((o) => ('name' in o ? o.name : ''))).toEqual([
      'Low',
      'Medium',
      'High',
    ]);
  });

  it('falls back to the first effort for always-thinking models when the current effort is unsupported', () => {
    const locked = buildThinkingOption('xhigh', ['low', 'medium', 'high'], true);
    if (locked.type !== 'select') throw new Error('expected SessionConfigSelect');
    expect(locked.currentValue).toBe('low');
  });
});

describe('buildModeOption', () => {
  it('returns the locked 4-mode taxonomy in order (default → plan → auto → yolo) with description carried through', () => {
    const option = buildModeOption('plan');

    expect(option.id).toBe('mode');
    expect(option.category).toBe('mode');
    expect(option.name).toBe('Mode');
    if (option.type !== 'select') {
      throw new Error('expected a SessionConfigSelect option');
    }
    expect(option.currentValue).toBe('plan');
    expect(option.options).toHaveLength(4);
    const ids = option.options.map((o) => ('value' in o ? o.value : ''));
    expect(ids).toEqual(['default', 'plan', 'auto', 'yolo']);
    for (const entry of option.options) {
      if ('value' in entry) {
        expect(typeof entry.name).toBe('string');
        expect(entry.name.length).toBeGreaterThan(0);
        expect(typeof entry.description).toBe('string');
        expect((entry.description ?? '').length).toBeGreaterThan(0);
      }
    }
  });
});

describe('buildSessionConfigOptions', () => {
  it('composes [model, thinking, mode] when current model supports thinking and calls getConfig exactly once', async () => {
    // `kimi-for-coding` is on the toggleable allow-list so its derived
    // thinkingSupported is true even without explicit capabilities.
    const { harness, getConfig } = makeHarnessWithModels([
      { id: 'kimi-coder', model: 'kimi-for-coding', displayName: 'Kimi Coder' },
    ]);

    const result = await buildSessionConfigOptions(harness, 'kimi-coder', 'off', 'default');

    expect(getConfig).toHaveBeenCalledTimes(1);
    expect(result).toHaveLength(3);
    expect(result.map((o) => o.id)).toEqual(['model', 'thinking', 'mode']);

    if (result[0]!.type === 'select') {
      expect(result[0]!.currentValue).toBe('kimi-coder');
    }
    if (result[1]!.type === 'select' && result[1]!.id === 'thinking') {
      expect(result[1]!.currentValue).toBe('off');
      expect(result[1]!.category).toBe('thought_level');
    } else {
      throw new Error('expected thinking select at index 1');
    }
    if (result[2]!.type === 'select') {
      expect(result[2]!.currentValue).toBe('default');
    }
  });

  it('shows the thinking control for an unknown model using the Anthropic protocol', async () => {
    const { harness } = makeHarnessWithModels([
      {
        id: 'custom',
        model: 'custom-anthropic-model',
        protocol: 'anthropic',
        providerType: 'anthropic',
      },
    ]);

    const result = await buildSessionConfigOptions(harness, 'custom', 'off', 'default');

    expect(result.map((option) => option.id)).toEqual(['model', 'thinking', 'mode']);
  });

  it('hides the thinking control for an unknown model on a Kimi provider using the Anthropic protocol', async () => {
    const { harness } = makeHarnessWithModels([
      {
        id: 'custom',
        model: 'custom-anthropic-model',
        protocol: 'anthropic',
        providerType: 'kimi',
      },
    ]);

    const result = await buildSessionConfigOptions(harness, 'custom', 'off', 'default');

    expect(result.map((option) => option.id)).toEqual(['model', 'mode']);
  });

  it('omits the thinking toggle when current model is non-thinking-supported', async () => {
    const { harness } = makeHarnessWithModels([
      { id: 'kimi-coder', model: 'kimi-for-coding', displayName: 'Kimi Coder' },
      { id: 'kimi-plain', model: 'qwen-2.5-coder', displayName: 'Kimi Plain' },
    ]);

    const result = await buildSessionConfigOptions(harness, 'kimi-plain', 'off', 'default');

    expect(result.map((o) => o.id)).toEqual(['model', 'mode']);
  });

  it('reflects the thinking toggle currentValue from the explicit argument', async () => {
    const { harness } = makeHarnessWithModels([
      { id: 'kimi-coder', model: 'kimi-for-coding', displayName: 'Kimi Coder' },
    ]);

    const result = await buildSessionConfigOptions(harness, 'kimi-coder', 'on', 'default');
    const toggle = result.find((o) => o.id === 'thinking');
    if (!toggle || toggle.type !== 'select') throw new Error('expected thinking select toggle');
    expect(toggle.currentValue).toBe('on');
  });

  it('renders an effort dropdown for models that advertise supportEfforts', async () => {
    const { harness } = makeHarnessWithModels([
      {
        id: 'claude',
        model: 'claude-sonnet-4-20250514',
        displayName: 'Claude Sonnet 4',
        protocol: 'anthropic',
        providerType: 'anthropic',
      },
    ]);

    const result = await buildSessionConfigOptions(harness, 'claude', 'low', 'default');
    const toggle = result.find((o) => o.id === 'thinking');
    if (!toggle || toggle.type !== 'select') throw new Error('expected thinking select toggle');
    expect(toggle.currentValue).toBe('low');
    expect(toggle.options.map((o) => ('value' in o ? o.value : ''))).toEqual([
      'off',
      'low',
      'medium',
      'high',
    ]);
  });

  it('maps a carried unsupported effort to the target model default effort', async () => {
    // Switching from a model with `max` to a model whose catalog only
    // declares `['low', 'high']` should show `high` (the default), not `off`.
    const harness = {
      getConfig: async () => ({
        providers: {},
        models: {
          'custom-reasoner': {
            model: 'custom-reasoner',
            capabilities: ['thinking'],
            supportEfforts: ['low', 'high'],
            defaultEffort: 'high',
          },
        },
      }),
    } as unknown as KimiHarness;

    const result = await buildSessionConfigOptions(harness, 'custom-reasoner', 'max', 'default');
    const toggle = result.find((o) => o.id === 'thinking');
    if (!toggle || toggle.type !== 'select') throw new Error('expected thinking select toggle');
    expect(toggle.currentValue).toBe('high');
  });

  it('locks the thinking toggle to on for always-thinking models even when the session state says off', async () => {
    const { harness } = makeHarnessWithModels([
      {
        id: 'kimi-deep',
        model: 'kimi-deep-coder',
        displayName: 'Kimi Deep',
        capabilities: ['thinking', 'always_thinking'],
      },
    ]);

    const result = await buildSessionConfigOptions(harness, 'kimi-deep', 'off', 'default');

    const toggle = result.find((o) => o.id === 'thinking');
    if (!toggle || toggle.type !== 'select') throw new Error('expected thinking select toggle');
    expect(toggle.currentValue).toBe('on');
    expect(toggle.options.map((o) => ('value' in o ? o.value : ''))).toEqual(['on']);
  });

  it('omits the thinking toggle when the current base model id is not in the catalog (defensive)', async () => {
    const { harness } = makeHarnessWithModels([
      { id: 'kimi-coder', model: 'kimi-for-coding', displayName: 'Kimi Coder' },
    ]);

    const result = await buildSessionConfigOptions(harness, 'unknown-model', 'on', 'default');
    expect(result.map((o) => o.id)).toEqual(['model', 'mode']);
  });

  it('handles missing getConfig (partial-stub harness) by suppressing the toggle and shipping an empty model picker', async () => {
    const harness = {} as unknown as KimiHarness;

    const result = await buildSessionConfigOptions(harness, '', 'off', 'default');

    expect(result.map((o) => o.id)).toEqual(['model', 'mode']);
    const modelOpt = result.find((o) => o.id === 'model');
    if (!modelOpt || modelOpt.type !== 'select') throw new Error('expected select');
    expect(modelOpt.options).toHaveLength(0);
  });
});

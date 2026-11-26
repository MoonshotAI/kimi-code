import { describe, expect, it } from 'vitest';
import type { AppModel } from '@moonshot-ai/app-core/api';
import { orderedModelProviders, providerModelsForMenu, recentModelsForMenu } from '../src/lib/modelQuickSwitch';

function model(id: string, provider: string): AppModel {
  return { id, provider, model: id, maxContextSize: 0 };
}

const catalog = [
  model('openai/gpt-4o', 'openai'),
  model('managed:kimi-code/kimi-k2', 'managed:kimi-code'),
  model('managed:kimi-code/kimi-k3', 'managed:kimi-code'),
  model('anthropic/claude-sonnet', 'anthropic'),
  model('openai/gpt-4o-mini', 'openai'),
];

describe('orderedModelProviders', () => {
  it('keeps first-appearance order and pins the Kimi subscription provider first', () => {
    expect(orderedModelProviders(catalog)).toEqual(['managed:kimi-code', 'openai', 'anthropic']);
    expect(orderedModelProviders(catalog.filter((m) => m.provider !== 'managed:kimi-code'))).toEqual(['openai', 'anthropic']);
    expect(orderedModelProviders([])).toEqual([]);
  });
});

describe('providerModelsForMenu', () => {
  it('puts the current model first when it belongs to the provider and otherwise keeps catalog order', () => {
    expect(providerModelsForMenu(catalog, 'openai', 'openai/gpt-4o-mini').map((m) => m.id)).toEqual([
      'openai/gpt-4o-mini',
      'openai/gpt-4o',
    ]);
    expect(providerModelsForMenu(catalog, 'openai', 'managed:kimi-code/kimi-k2').map((m) => m.id)).toEqual([
      'openai/gpt-4o',
      'openai/gpt-4o-mini',
    ]);
    expect(providerModelsForMenu(catalog, 'missing', undefined)).toEqual([]);
  });
});

describe('recentModelsForMenu', () => {
  it('puts the current model first, filters missing ids, removes duplicate history, and caps the menu at five', () => {
    const recent = recentModelsForMenu(
      [...catalog, model('google/gemini', 'google')],
      [
        'anthropic/claude-sonnet',
        'missing/model',
        'openai/gpt-4o-mini',
        'anthropic/claude-sonnet',
        'managed:kimi-code/kimi-k3',
        'openai/gpt-4o',
        'google/gemini',
      ],
      'managed:kimi-code/kimi-k2',
    );

    expect(recent.map((model) => model.id)).toEqual([
      'managed:kimi-code/kimi-k2',
      'anthropic/claude-sonnet',
      'openai/gpt-4o-mini',
      'managed:kimi-code/kimi-k3',
      'openai/gpt-4o',
    ]);
  });

  it('uses stored order when there is no current model and hides an empty recent group', () => {
    expect(
      recentModelsForMenu(
        catalog,
        ['openai/gpt-4o-mini', 'missing/model', 'anthropic/claude-sonnet'],
        undefined,
      ).map((model) => model.id),
    ).toEqual(['openai/gpt-4o-mini', 'anthropic/claude-sonnet']);
    expect(recentModelsForMenu(catalog, ['missing/model'], undefined)).toEqual([]);
  });
});

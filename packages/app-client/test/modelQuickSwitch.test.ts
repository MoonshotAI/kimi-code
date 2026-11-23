import { describe, expect, it } from 'vitest';
import type { AppModel } from '@moonshot-ai/app-core/api';
import { groupUnstarredModelsByProvider, recentModelsForMenu } from '../src/lib/modelQuickSwitch';

function model(id: string, provider: string): AppModel {
  return { id, provider, model: id, maxContextSize: 0 };
}

const catalog = [
  model('managed:kimi-code/kimi-k2', 'managed:kimi-code'),
  model('openai/gpt-4o', 'openai'),
  model('managed:kimi-code/kimi-k3', 'managed:kimi-code'),
  model('anthropic/claude-sonnet', 'anthropic'),
  model('openai/gpt-4o-mini', 'openai'),
];

describe('groupUnstarredModelsByProvider', () => {
  it('groups unstarred models by provider in first-appearance order, catalog order within a group', () => {
    const groups = groupUnstarredModelsByProvider(catalog, []);
    expect(groups.map((g) => g.provider)).toEqual(['managed:kimi-code', 'openai', 'anthropic']);
    expect(groups[0]?.models.map((m) => m.id)).toEqual(['managed:kimi-code/kimi-k2', 'managed:kimi-code/kimi-k3']);
    expect(groups[1]?.models.map((m) => m.id)).toEqual(['openai/gpt-4o', 'openai/gpt-4o-mini']);
    expect(groups[2]?.models.map((m) => m.id)).toEqual(['anthropic/claude-sonnet']);
  });

  it('excludes starred models (the starred section above owns them) without reordering the rest', () => {
    const groups = groupUnstarredModelsByProvider(catalog, ['managed:kimi-code/kimi-k2', 'openai/gpt-4o-mini']);
    expect(groups.map((g) => g.provider)).toEqual(['managed:kimi-code', 'openai', 'anthropic']);
    expect(groups[0]?.models.map((m) => m.id)).toEqual(['managed:kimi-code/kimi-k3']);
    expect(groups[1]?.models.map((m) => m.id)).toEqual(['openai/gpt-4o']);
  });

  it('drops a provider group whose every model is starred', () => {
    const groups = groupUnstarredModelsByProvider(catalog, ['openai/gpt-4o', 'openai/gpt-4o-mini']);
    expect(groups.map((g) => g.provider)).toEqual(['managed:kimi-code', 'anthropic']);
  });

  it('returns [] for an empty catalog and when everything is starred', () => {
    expect(groupUnstarredModelsByProvider([], [])).toEqual([]);
    expect(groupUnstarredModelsByProvider(catalog, catalog.map((m) => m.id))).toEqual([]);
  });
});


describe('recentModelsForMenu', () => {
  it('puts the current model first, filters missing ids, removes duplicate history, and caps the menu at five', () => {
    const recent = recentModelsForMenu(
      catalog,
      [
        'anthropic/claude-sonnet',
        'missing/model',
        'openai/gpt-4o-mini',
        'anthropic/claude-sonnet',
        'managed:kimi-code/kimi-k3',
        'openai/gpt-4o',
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

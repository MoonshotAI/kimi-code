import { describe, expect, it } from 'vitest';
import type { AppModel } from '@moonshot-ai/app-core/api';
import { searchModelsForMenu } from '../src/lib/modelMenuSearch';

const models: AppModel[] = [
  { id: 'managed:kimi-code/k2.5', provider: 'managed:kimi-code', model: 'k2.5', displayName: 'Kimi K2.5', maxContextSize: 262144 },
  { id: 'openrouter/claude-sonnet', provider: 'openrouter', model: 'claude-sonnet', displayName: 'Claude Sonnet 4.5', maxContextSize: 200000 },
  { id: 'openrouter/qwen', provider: 'openrouter', model: 'qwen', displayName: 'Qwen3 Coder', maxContextSize: 256000 },
  { id: 'anthropic/claude-opus', provider: 'anthropic', model: 'claude-opus', displayName: 'Claude Opus 4.1', maxContextSize: 200000 },
];

const label = (provider: string): string => (provider === 'managed:kimi-code' ? 'Kimi 订阅' : provider);

describe('searchModelsForMenu', () => {
  it('returns no results for a blank query', () => {
    expect(searchModelsForMenu(models, '   ', label)).toEqual([]);
  });

  it('matches model names case-insensitively with highlight ranges', () => {
    const results = searchModelsForMenu(models, 'claude', label);
    expect(results.map((r) => r.model.id)).toEqual(['openrouter/claude-sonnet', 'anthropic/claude-opus']);
    expect(results[0]?.modelRanges).toEqual([{ start: 0, end: 6 }]);
    expect(results[0]?.providerRanges).toEqual([]);
    expect(results[0]?.matchedProvider).toBe(false);
  });

  it('matches provider names and marks matchedProvider so provider truncation is avoided', () => {
    const results = searchModelsForMenu(models, 'openrouter', label);
    expect(results.map((r) => r.model.id)).toEqual(['openrouter/claude-sonnet', 'openrouter/qwen']);
    expect(results.every((r) => r.matchedProvider)).toBe(true);
    expect(results[0]?.providerRanges).toEqual([{ start: 0, end: 10 }]);
  });

  it('highlights both model and provider when the query hits both', () => {
    const results = searchModelsForMenu(models, 'kimi', label);
    expect(results).toHaveLength(1);
    expect(results[0]?.modelRanges).toEqual([{ start: 0, end: 4 }]);
    expect(results[0]?.providerRanges).toEqual([{ start: 0, end: 4 }]);
    expect(results[0]?.matchedProvider).toBe(true);
  });

  it('falls back to canonical id matching without fabricated highlight ranges', () => {
    const results = searchModelsForMenu(models, 'openrouter/claude', label);
    expect(results.map((r) => r.model.id)).toEqual(['openrouter/claude-sonnet']);
    expect(results[0]?.modelRanges).toEqual([]);
    expect(results[0]?.providerRanges).toEqual([]);
  });
});

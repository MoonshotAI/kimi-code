import { describe, expect, it } from 'vitest';
import { modelDisplayName, subagentEffortSuffix } from '../src/lib/modelDisplay';
import type { AppModel } from '../src/api/types';

const catalog: AppModel[] = [
  {
    id: 'k2-cheap',
    provider: 'managed:kimi-code',
    model: 'kimi-k2-cheap',
    displayName: 'Kimi K2 Cheap',
    maxContextSize: 100_000,
  },
  {
    id: 'k2',
    provider: 'managed:kimi-code',
    model: 'kimi-k2',
    maxContextSize: 250_000,
  },
];

describe('modelDisplayName', () => {
  it('prefers the catalog display name on an exact id match', () => {
    expect(modelDisplayName('k2-cheap', catalog)).toBe('Kimi K2 Cheap');
  });

  it('falls back to the raw model name when no display name exists', () => {
    expect(modelDisplayName('k2', catalog)).toBe('kimi-k2');
  });

  it('matches on the bare model name when the alias is unknown', () => {
    expect(modelDisplayName('kimi-k2-cheap', catalog)).toBe('Kimi K2 Cheap');
  });

  it('strips the provider prefix for aliases missing from the catalog', () => {
    expect(modelDisplayName('provider/moonshot-v1-128k', catalog)).toBe('moonshot-v1-128k');
    expect(modelDisplayName('k2.5', catalog)).toBe('k2.5');
  });

  it('returns undefined for an empty alias and survives a missing catalog', () => {
    expect(modelDisplayName(undefined, catalog)).toBeUndefined();
    expect(modelDisplayName('', catalog)).toBeUndefined();
    expect(modelDisplayName('k2-cheap', undefined)).toBe('k2-cheap');
  });
});

describe('subagentEffortSuffix', () => {
  it('hides undefined, empty, and the boolean states', () => {
    expect(subagentEffortSuffix(undefined)).toBeUndefined();
    expect(subagentEffortSuffix('')).toBeUndefined();
    expect(subagentEffortSuffix('off')).toBeUndefined();
    expect(subagentEffortSuffix('on')).toBeUndefined();
  });

  it('shows any concrete level verbatim', () => {
    expect(subagentEffortSuffix('low')).toBe('low');
    expect(subagentEffortSuffix('high')).toBe('high');
    expect(subagentEffortSuffix('max')).toBe('max');
  });
});

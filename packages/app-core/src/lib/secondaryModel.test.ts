import { describe, expect, it } from 'vitest';
import {
  buildAllModelsSecondaryConfig,
  buildFixedSecondaryModelConfig,
  buildSecondaryModelPatch,
  buildSelectedModelsSecondaryConfig,
  readSecondaryModelEntry,
  resolveSecondaryModelAutoScope,
  resolveSecondaryModelMode,
  serializeSecondaryModelEntry,
} from './secondaryModel';

describe('secondaryModel helpers', () => {
  it('resolves modes and auto scopes from config shapes', () => {
    expect(resolveSecondaryModelMode(undefined)).toBe('follow');
    expect(resolveSecondaryModelMode(null)).toBe('follow');
    expect(resolveSecondaryModelMode({ defaultModel: 'kimi/k2' })).toBe('fixed');
    expect(resolveSecondaryModelMode({ model: 'kimi/k2' })).toBe('fixed');
    expect(resolveSecondaryModelMode({ allModels: true })).toBe('auto');
    expect(resolveSecondaryModelMode({ defaultModel: 'a', models: { a: '' } })).toBe('auto');
    expect(resolveSecondaryModelAutoScope({ allModels: true })).toBe('all');
    expect(resolveSecondaryModelAutoScope({ defaultModel: 'a', models: { a: '' } })).toBe('selected');
  });

  it('normalizes and collapses pool entries on demand', () => {
    expect(readSecondaryModelEntry('fast')).toEqual({ description: 'fast', effort: '' });
    expect(readSecondaryModelEntry({ description: 'fast', effort: 'low' })).toEqual({
      description: 'fast',
      effort: 'low',
    });
    expect(serializeSecondaryModelEntry({ description: 'fast', effort: '' })).toBe('fast');
    expect(serializeSecondaryModelEntry({ description: 'fast', effort: 'low' })).toEqual({
      description: 'fast',
      effort: 'low',
    });
    expect(serializeSecondaryModelEntry({ description: '', effort: 'high' })).toEqual({
      effort: 'high',
    });
  });

  it('builds fixed, all-models, and selected-models configs cleanly', () => {
    expect(buildFixedSecondaryModelConfig({ model: 'kimi/k2', effort: 'low' })).toEqual({
      defaultModel: 'kimi/k2',
      defaultEffort: 'low',
    });
    expect(buildAllModelsSecondaryConfig('  Prefer cheap models  ')).toEqual({
      allModels: true,
      rule: 'Prefer cheap models',
    });
    expect(
      buildSelectedModelsSecondaryConfig({
        defaultModel: 'b',
        entries: {
          a: { description: 'fast', effort: 'low' },
          b: { description: 'strong', effort: '' },
        },
        rule: 'Cost first',
      }),
    ).toEqual({
      defaultModel: 'b',
      rule: 'Cost first',
      models: {
        a: { description: 'fast', effort: 'low' },
        b: 'strong',
      },
    });
    expect(buildSelectedModelsSecondaryConfig({ entries: {} })).toBeNull();
  });
});

describe('buildSecondaryModelPatch', () => {
  it('writes defaultModel when no pool exists', () => {
    expect(buildSecondaryModelPatch(undefined, { model: 'kimi/k2' })).toEqual({
      defaultModel: 'kimi/k2',
    });
  });

  it('appends an empty-description entry when the choice is outside the pool', () => {
    expect(
      buildSecondaryModelPatch(
        { defaultModel: 'a', models: { a: 'fast', b: '' } },
        { model: 'c' },
      ),
    ).toEqual({
      defaultModel: 'c',
      models: { a: 'fast', b: '', c: '' },
    });
  });

  it('leaves the pool untouched when the choice is already a pool key', () => {
    expect(
      buildSecondaryModelPatch({ defaultModel: 'a', models: { a: '', b: '' } }, { model: 'b' }),
    ).toEqual({ defaultModel: 'b' });
  });

  it('passes effort through as defaultEffort when set', () => {
    expect(buildSecondaryModelPatch(undefined, { model: 'kimi/k2', effort: 'high' })).toEqual({
      defaultModel: 'kimi/k2',
      defaultEffort: 'high',
    });
  });

  it('omits defaultEffort when effort is not set', () => {
    const patch = buildSecondaryModelPatch(
      { defaultModel: 'a', defaultEffort: 'high' },
      { model: 'b' },
    );
    expect(patch).toEqual({ defaultModel: 'b' });
    expect('defaultEffort' in patch).toBe(false);
  });

  it('does not write the legacy model key or touch force', () => {
    const patch = buildSecondaryModelPatch(
      { defaultModel: 'a', force: true },
      { model: 'b', effort: 'low' },
    );
    expect(patch).toEqual({ defaultModel: 'b', defaultEffort: 'low' });
  });
});

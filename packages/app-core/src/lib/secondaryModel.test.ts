import { describe, expect, it } from 'vitest';
import { buildSecondaryModelPatch } from './secondaryModel';

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

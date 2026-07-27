/**
 * `app/kosongConfig` secondaryModelOverlay tests — the `[secondary_model]`
 * derived-entry synthesis:
 *
 *  - a recipe with patch fields synthesizes `SECONDARY_DERIVED_MODEL_ID`
 *    (base copy, patch merged into `overrides` with patch winning conflicts,
 *    `aliases` dropped); a pointer-only recipe, a missing pointer, and a
 *    dangling pointer synthesize nothing;
 *  - `strip` keeps the synthesized entry out of `config.toml`.
 */

import { describe, expect, it } from 'vitest';

import {
  MODELS_SECTION,
  SECONDARY_MODEL_SECTION,
} from '#/app/kosongConfig/configSection';
import {
  SECONDARY_DERIVED_MODEL_ID,
  secondaryModelOverlay,
} from '#/app/kosongConfig/secondaryModelOverlay';

function apply(effective: Record<string, unknown>): readonly string[] {
  return secondaryModelOverlay.apply(effective, () => undefined, (_domain, value) => value);
}

const baseEntry = {
  provider: 'kimi',
  model: 'kimi-k2',
  maxContextSize: 262144,
  aliases: ['k2-latest'],
  overrides: { defaultEffort: 'medium', supportEfforts: ['low', 'medium', 'high'] },
};

describe('secondaryModelOverlay.apply', () => {
  it('does nothing when no secondary model is configured', () => {
    const effective: Record<string, unknown> = { [MODELS_SECTION]: { k2: baseEntry } };
    expect(apply(effective)).toEqual([]);
    expect(effective[MODELS_SECTION]).toEqual({ k2: baseEntry });
  });

  it('does nothing for a pointer-only recipe (no patch fields)', () => {
    const effective: Record<string, unknown> = {
      [MODELS_SECTION]: { k2: baseEntry },
      [SECONDARY_MODEL_SECTION]: { model: 'k2' },
    };
    expect(apply(effective)).toEqual([]);
    expect(effective[MODELS_SECTION]).toEqual({ k2: baseEntry });
  });

  it('synthesizes the derived entry: base copy, patch wins overrides conflicts, aliases dropped', () => {
    const effective: Record<string, unknown> = {
      [MODELS_SECTION]: { k2: baseEntry },
      [SECONDARY_MODEL_SECTION]: { model: 'k2', defaultEffort: 'low', maxOutputSize: 8192 },
    };
    expect(apply(effective)).toEqual([MODELS_SECTION]);
    const models = effective[MODELS_SECTION] as Record<string, unknown>;
    expect(models[SECONDARY_DERIVED_MODEL_ID]).toEqual({
      provider: 'kimi',
      model: 'kimi-k2',
      maxContextSize: 262144,
      overrides: {
        defaultEffort: 'low',
        supportEfforts: ['low', 'medium', 'high'],
        maxOutputSize: 8192,
      },
    });
    // The pointed entry stays untouched.
    expect(models['k2']).toEqual(baseEntry);
  });

  it('does nothing when the pointed entry does not exist', () => {
    const effective: Record<string, unknown> = {
      [MODELS_SECTION]: { k2: baseEntry },
      [SECONDARY_MODEL_SECTION]: { model: 'nope', maxOutputSize: 8192 },
    };
    expect(apply(effective)).toEqual([]);
    expect(effective[MODELS_SECTION]).toEqual({ k2: baseEntry });
  });

  it('never derives from the derived id itself', () => {
    const effective: Record<string, unknown> = {
      [MODELS_SECTION]: { [SECONDARY_DERIVED_MODEL_ID]: baseEntry },
      [SECONDARY_MODEL_SECTION]: { model: SECONDARY_DERIVED_MODEL_ID, maxOutputSize: 1 },
    };
    expect(apply(effective)).toEqual([]);
  });
});

describe('secondaryModelOverlay.strip', () => {
  const strip = secondaryModelOverlay.strip!;

  it('removes the derived entry from models writes and leaves other domains alone', () => {
    const models = { k2: baseEntry, [SECONDARY_DERIVED_MODEL_ID]: { ...baseEntry } };
    expect(strip(MODELS_SECTION, models, {})).toEqual({ k2: baseEntry });
    expect(strip('thinking', { effort: 'low' }, {})).toEqual({ effort: 'low' });
  });

  it('leaves a models section without the derived entry untouched', () => {
    const models = { k2: baseEntry };
    expect(strip(MODELS_SECTION, models, {})).toBe(models);
  });

  it('rolls back a defaultModel pointer set to the derived id', () => {
    expect(strip('defaultModel', 'k2', {})).toBe('k2');
    // Restore the raw pointer when one exists…
    expect(strip('defaultModel', SECONDARY_DERIVED_MODEL_ID, { default_model: 'k2' })).toBe('k2');
    // …or drop the section when the raw config never had one.
    expect(strip('defaultModel', SECONDARY_DERIVED_MODEL_ID, {})).toBeUndefined();
  });
});

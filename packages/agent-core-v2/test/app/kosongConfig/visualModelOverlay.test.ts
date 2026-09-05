
import { describe, expect, it } from 'vitest';

import {
  MODELS_SECTION,
  VISUAL_MODEL_SECTION,
} from '#/app/kosongConfig/configSection';
import {
  VISUAL_DERIVED_MODEL_ID,
  visualModelOverlay,
} from '#/app/kosongConfig/visualModelOverlay';

function apply(effective: Record<string, unknown>): readonly string[] {
  return visualModelOverlay.apply(effective, () => undefined, (_domain, value) => value);
}

const baseEntry = {
  provider: 'kimi',
  model: 'kimi-vision',
  maxContextSize: 131072,
  aliases: ['vision-latest'],
  overrides: { defaultEffort: 'medium', supportEfforts: ['low', 'medium', 'high'] },
};

describe('visualModelOverlay.apply', () => {
  it('does nothing when no visual model is configured', () => {
    const effective: Record<string, unknown> = { [MODELS_SECTION]: { vision: baseEntry } };
    expect(apply(effective)).toEqual([]);
    expect(effective[MODELS_SECTION]).toEqual({ vision: baseEntry });
  });

  it('does nothing for a pointer-only recipe (no patch fields)', () => {
    const effective: Record<string, unknown> = {
      [MODELS_SECTION]: { vision: baseEntry },
      [VISUAL_MODEL_SECTION]: { model: 'vision' },
    };
    expect(apply(effective)).toEqual([]);
    expect(effective[MODELS_SECTION]).toEqual({ vision: baseEntry });
  });

  it('synthesizes the derived entry: base copy, patch wins overrides conflicts, aliases dropped', () => {
    const effective: Record<string, unknown> = {
      [MODELS_SECTION]: { vision: baseEntry },
      [VISUAL_MODEL_SECTION]: { model: 'vision', defaultEffort: 'low', maxOutputSize: 4096 },
    };
    expect(apply(effective)).toEqual([MODELS_SECTION]);
    const models = effective[MODELS_SECTION] as Record<string, unknown>;
    expect(models[VISUAL_DERIVED_MODEL_ID]).toEqual({
      provider: 'kimi',
      model: 'kimi-vision',
      maxContextSize: 131072,
      overrides: {
        defaultEffort: 'low',
        supportEfforts: ['low', 'medium', 'high'],
        maxOutputSize: 4096,
      },
    });
    expect(models['vision']).toEqual(baseEntry);
  });

  it('does nothing when the pointed entry does not exist', () => {
    const effective: Record<string, unknown> = {
      [MODELS_SECTION]: { vision: baseEntry },
      [VISUAL_MODEL_SECTION]: { model: 'nope', maxOutputSize: 4096 },
    };
    expect(apply(effective)).toEqual([]);
    expect(effective[MODELS_SECTION]).toEqual({ vision: baseEntry });
  });

  it('never derives from the derived id itself', () => {
    const effective: Record<string, unknown> = {
      [MODELS_SECTION]: { [VISUAL_DERIVED_MODEL_ID]: baseEntry },
      [VISUAL_MODEL_SECTION]: { model: VISUAL_DERIVED_MODEL_ID, maxOutputSize: 1 },
    };
    expect(apply(effective)).toEqual([]);
  });

  it('does not collide with the secondary-model derived entry', () => {
    const SECONDARY_DERIVED_MODEL_ID = '__secondary__';
    const effective: Record<string, unknown> = {
      [MODELS_SECTION]: {
        vision: baseEntry,
        coder: { ...baseEntry, model: 'kimi-coder' },
      },
      [VISUAL_MODEL_SECTION]: { model: 'vision', maxOutputSize: 4096 },
      secondaryModel: { model: 'coder', maxOutputSize: 8192 },
    };
    apply(effective);
    const models = effective[MODELS_SECTION] as Record<string, unknown>;
    expect(models[VISUAL_DERIVED_MODEL_ID]).toBeDefined();
    expect(models[VISUAL_DERIVED_MODEL_ID]).not.toBe(models[SECONDARY_DERIVED_MODEL_ID]);
  });
});

describe('visualModelOverlay.strip', () => {
  const strip = visualModelOverlay.strip!;

  it('removes the derived entry from models writes and leaves other domains alone', () => {
    const models = { vision: baseEntry, [VISUAL_DERIVED_MODEL_ID]: { ...baseEntry } };
    expect(strip(MODELS_SECTION, models, {})).toEqual({ vision: baseEntry });
    expect(strip('thinking', { effort: 'low' }, {})).toEqual({ effort: 'low' });
  });

  it('leaves a models section without the derived entry untouched', () => {
    const models = { vision: baseEntry };
    expect(strip(MODELS_SECTION, models, {})).toBe(models);
  });

  it('rolls back a defaultModel pointer set to the derived id', () => {
    expect(strip('defaultModel', 'vision', {})).toBe('vision');
    expect(strip('defaultModel', VISUAL_DERIVED_MODEL_ID, { default_model: 'vision' })).toBe(
      'vision',
    );
    expect(strip('defaultModel', VISUAL_DERIVED_MODEL_ID, {})).toBeUndefined();
  });
});


import { describe, expect, it } from 'vitest';

import { VISUAL_MODEL_SECTION } from '#/app/kosongConfig/configSection';
import { VISUAL_DERIVED_MODEL_ID } from '#/app/kosongConfig/visualModelOverlay';
import {
  resolveVisualBinding,
  resolveVisualModel,
  visualDisplayModel,
  stripVisualModelParameter,
  wrapVisualModelError,
} from '#/session/visual/configSection';
import { VISUAL_MODEL_FLAG_ID } from '#/session/visual/flag';
import { Error2, ErrorCodes } from '#/errors';

import { stubFlag } from '../../app/flag/stubs';
import { StubConfigService } from '../../kosong/stubs';

function makeServices(configValues: Record<string, unknown>, flagEnabled = true) {
  const config = new StubConfigService(configValues);
  const flags = stubFlag((id) => flagEnabled && id === VISUAL_MODEL_FLAG_ID);
  return { config, flags };
}

const own = { modelAlias: 'caller/kimi-coder', thinkingLevel: 'medium' };

describe('resolveVisualModel', () => {
  it('returns undefined when the visual-model flag is disabled', () => {
    const { config } = makeServices({ [VISUAL_MODEL_SECTION]: { model: 'kimi/vision' } }, false);
    const { flags } = makeServices({}, false);
    expect(resolveVisualModel(config, flags)).toBeUndefined();
  });

  it('returns undefined when [visual_model] is unset (no behavior change)', () => {
    const { config, flags } = makeServices({});
    expect(resolveVisualModel(config, flags)).toBeUndefined();
  });

  it('returns the configured recipe when set and the flag is on', () => {
    const { config, flags } = makeServices({
      [VISUAL_MODEL_SECTION]: { model: 'kimi/vision', defaultEffort: 'low' },
    });
    expect(resolveVisualModel(config, flags)).toEqual({
      model: 'kimi/vision',
      defaultEffort: 'low',
    });
  });
});

describe('resolveVisualBinding', () => {
  it('inherits the caller model when visual model is unset (no behavior change)', () => {
    const { config, flags } = makeServices({});
    expect(resolveVisualBinding(config, flags, own)).toEqual({
      model: own.modelAlias,
      thinking: own.thinkingLevel,
      displayModel: own.modelAlias,
    });
  });

  it('inherits the caller model when the flag is disabled even if the recipe is set', () => {
    const { config } = makeServices({ [VISUAL_MODEL_SECTION]: { model: 'kimi/vision' } });
    const { flags } = makeServices({}, false);
    expect(resolveVisualBinding(config, flags, own)).toEqual({
      model: own.modelAlias,
      thinking: own.thinkingLevel,
      displayModel: own.modelAlias,
    });
  });

  it('binds the visual model when set (pointer-only recipe)', () => {
    const { config, flags } = makeServices({
      [VISUAL_MODEL_SECTION]: { model: 'kimi/vision' },
    });
    expect(resolveVisualBinding(config, flags, own)).toEqual({
      model: 'kimi/vision',
      thinking: undefined,
      displayModel: 'kimi/vision',
    });
  });

  it('binds the derived entry when the recipe carries patch fields', () => {
    const { config, flags } = makeServices({
      [VISUAL_MODEL_SECTION]: { model: 'kimi/vision', defaultEffort: 'low', maxOutputSize: 4096 },
    });
    const binding = resolveVisualBinding(config, flags, own);
    expect(binding.model).toBe(VISUAL_DERIVED_MODEL_ID);
    expect(binding.thinking).toBe('low');
    expect(binding.displayModel).toBe('kimi/vision');
  });

  it('binds the legacy default_model pointer when model is unset', () => {
    const { config, flags } = makeServices({
      [VISUAL_MODEL_SECTION]: { defaultModel: 'kimi/vision' },
    });
    expect(resolveVisualBinding(config, flags, own)).toEqual({
      model: 'kimi/vision',
      thinking: undefined,
      displayModel: 'kimi/vision',
    });
  });

  it('prefers model over the legacy default_model when both are set', () => {
    const { config, flags } = makeServices({
      [VISUAL_MODEL_SECTION]: { model: 'kimi/new', defaultModel: 'kimi/legacy' },
    });
    expect(resolveVisualBinding(config, flags, own).model).toBe('kimi/new');
  });

  it('forces the caller model on explicit "primary" even when a visual model is configured', () => {
    const { config, flags } = makeServices({
      [VISUAL_MODEL_SECTION]: { model: 'kimi/vision' },
    });
    expect(resolveVisualBinding(config, flags, own, 'primary')).toEqual({
      model: own.modelAlias,
      thinking: own.thinkingLevel,
      displayModel: own.modelAlias,
    });
  });
});

describe('visualDisplayModel', () => {
  it('passes through any non-derived alias', () => {
    const { config } = makeServices({});
    expect(visualDisplayModel(config, 'kimi/vision')).toBe('kimi/vision');
  });

  it('resolves the derived id back to the recipe base alias', () => {
    const { config } = makeServices({
      [VISUAL_MODEL_SECTION]: { model: 'kimi/vision' },
    });
    expect(visualDisplayModel(config, VISUAL_DERIVED_MODEL_ID)).toBe('kimi/vision');
  });

  it('falls back to the derived id when the recipe has been removed', () => {
    const { config } = makeServices({});
    expect(visualDisplayModel(config, VISUAL_DERIVED_MODEL_ID)).toBe(VISUAL_DERIVED_MODEL_ID);
  });
});

describe('stripVisualModelParameter', () => {
  it('returns the input unchanged when there is no model property', () => {
    const schema = { properties: { prompt: { type: 'string' } }, required: ['prompt'] };
    expect(stripVisualModelParameter(schema)).toBe(schema);
  });

  it('removes the model property and its required entry', () => {
    const schema = {
      properties: { prompt: { type: 'string' }, model: { type: 'string' } },
      required: ['prompt', 'model'],
    };
    const next = stripVisualModelParameter(schema);
    expect(next['properties']).toEqual({ prompt: { type: 'string' } });
    expect(next['required']).toEqual(['prompt']);
  });

  it('does not mutate the input', () => {
    const schema = {
      properties: { model: { type: 'string' } },
      required: ['model'],
    };
    const next = stripVisualModelParameter(schema);
    expect(next).not.toBe(schema);
    expect(schema['properties']).toEqual({ model: { type: 'string' } });
  });
});

describe('wrapVisualModelError', () => {
  const callerModelAlias = 'caller/kimi-coder';

  it('returns the error unchanged when the bound model is the caller own', () => {
    const error = new Error2(ErrorCodes.CONFIG_INVALID, 'boom', {
      details: { model: callerModelAlias },
    });
    expect(wrapVisualModelError(error, callerModelAlias, callerModelAlias)).toBe(error);
  });

  it('returns the error unchanged for non-CONFIG_INVALID errors', () => {
    const error = new Error('boom');
    expect(wrapVisualModelError(error, 'kimi/vision', callerModelAlias)).toBe(error);
  });

  it('returns the error unchanged when the error details model does not match the bound model', () => {
    const error = new Error2(ErrorCodes.CONFIG_INVALID, 'boom', {
      details: { model: 'some/other' },
    });
    expect(wrapVisualModelError(error, 'kimi/vision', callerModelAlias)).toBe(error);
  });

  it('wraps a missing-alias failure with a hint pointing at [visual_model]', () => {
    const error = new Error2(ErrorCodes.CONFIG_INVALID, 'Model "kimi/vision" is not configured.', {
      details: { model: 'kimi/vision' },
    });
    const wrapped = wrapVisualModelError(error, 'kimi/vision', callerModelAlias) as Error2;
    expect(wrapped).toBeInstanceOf(Error2);
    expect(wrapped.message).toContain('[visual_model]');
    expect(wrapped.message).toContain('KIMI_VISUAL_MODEL');
    expect(wrapped.details).toMatchObject({
      model: 'kimi/vision',
      visualModel: 'kimi/vision',
      visualModelConfig: { section: 'visualModel.model', environment: 'KIMI_VISUAL_MODEL' },
    });
  });

  it('wraps a derived-entry failure with a hint pointing at the derived id', () => {
    const error = new Error2(ErrorCodes.CONFIG_INVALID, 'missing', {
      details: { model: VISUAL_DERIVED_MODEL_ID },
    });
    const wrapped = wrapVisualModelError(error, VISUAL_DERIVED_MODEL_ID, callerModelAlias) as Error2;
    expect(wrapped.message).toContain(VISUAL_DERIVED_MODEL_ID);
    expect(wrapped.message).toContain('[visual_model]');
  });
});

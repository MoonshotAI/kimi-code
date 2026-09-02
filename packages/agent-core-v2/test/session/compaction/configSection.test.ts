
import { describe, expect, it } from 'vitest';

import { COMPACTION_MODEL_SECTION } from '#/app/kosongConfig/configSection';
import { COMPACTION_DERIVED_MODEL_ID } from '#/app/kosongConfig/compactionModelOverlay';
import {
  compactionDisplayModel,
  compactionModelBindingFor,
  resolveCompactionBinding,
  resolveCompactionModel,
  resolveCompactionSecondaryModel,
  wrapCompactionModelError,
} from '#/session/compaction/configSection';
import { COMPACTION_MODEL_FLAG_ID } from '#/session/compaction/flag';
import { Error2, ErrorCodes } from '#/errors';

import { stubFlag } from '../../app/flag/stubs';
import { StubConfigService } from '../../kosong/stubs';

function makeServices(configValues: Record<string, unknown>, flagEnabled = true) {
  const config = new StubConfigService(configValues);
  const flags = stubFlag((id) => flagEnabled && id === COMPACTION_MODEL_FLAG_ID);
  return { config, flags };
}

const own = { modelAlias: 'caller/kimi-coder', thinkingLevel: 'medium' };

describe('resolveCompactionModel', () => {
  it('returns undefined when the compaction-model flag is disabled', () => {
    const { config } = makeServices({ [COMPACTION_MODEL_SECTION]: { model: 'kimi/compaction' } }, false);
    const { flags } = makeServices({}, false);
    expect(resolveCompactionModel(config, flags)).toBeUndefined();
  });

  it('returns undefined when [compaction_model] is unset (no behavior change)', () => {
    const { config, flags } = makeServices({});
    expect(resolveCompactionModel(config, flags)).toBeUndefined();
  });

  it('returns the configured recipe when set and the flag is on', () => {
    const { config, flags } = makeServices({
      [COMPACTION_MODEL_SECTION]: { model: 'kimi/compaction', defaultEffort: 'low' },
    });
    expect(resolveCompactionModel(config, flags)).toEqual({
      model: 'kimi/compaction',
      defaultEffort: 'low',
    });
  });
});

describe('resolveCompactionSecondaryModel', () => {
  it('returns undefined when the compaction-model flag is disabled', () => {
    const { config, flags } = makeServices(
      { [COMPACTION_MODEL_SECTION]: { secondaryModel: 'kimi/backup' } },
      false,
    );
    expect(resolveCompactionSecondaryModel(config, flags)).toBeUndefined();
  });

  it('returns undefined when no secondary squeeze model is configured', () => {
    const { config, flags } = makeServices({
      [COMPACTION_MODEL_SECTION]: { model: 'kimi/compaction' },
    });
    expect(resolveCompactionSecondaryModel(config, flags)).toBeUndefined();
  });

  it('returns the secondary squeeze model when configured and the flag is on', () => {
    const { config, flags } = makeServices({
      [COMPACTION_MODEL_SECTION]: { model: 'kimi/compaction', secondaryModel: 'kimi/backup' },
    });
    expect(resolveCompactionSecondaryModel(config, flags)).toBe('kimi/backup');
  });

  it('returns the secondary squeeze model even when no primary is set', () => {
    const { config, flags } = makeServices({
      [COMPACTION_MODEL_SECTION]: { secondaryModel: 'kimi/backup' },
    });
    expect(resolveCompactionSecondaryModel(config, flags)).toBe('kimi/backup');
  });
});

describe('resolveCompactionBinding', () => {
  it('inherits the caller model when compaction model is unset (no behavior change)', () => {
    const { config, flags } = makeServices({});
    expect(resolveCompactionBinding(config, flags, own)).toEqual({
      model: own.modelAlias,
      thinking: own.thinkingLevel,
      displayModel: own.modelAlias,
    });
  });

  it('inherits the caller model when the flag is disabled even if the recipe is set', () => {
    const { config } = makeServices({ [COMPACTION_MODEL_SECTION]: { model: 'kimi/compaction' } });
    const { flags } = makeServices({}, false);
    expect(resolveCompactionBinding(config, flags, own)).toEqual({
      model: own.modelAlias,
      thinking: own.thinkingLevel,
      displayModel: own.modelAlias,
    });
  });

  it('binds the compaction model when set (pointer-only recipe)', () => {
    const { config, flags } = makeServices({
      [COMPACTION_MODEL_SECTION]: { model: 'kimi/compaction' },
    });
    expect(resolveCompactionBinding(config, flags, own)).toEqual({
      model: 'kimi/compaction',
      thinking: undefined,
      displayModel: 'kimi/compaction',
    });
  });

  it('binds the derived entry when the recipe carries patch fields', () => {
    const { config, flags } = makeServices({
      [COMPACTION_MODEL_SECTION]: { model: 'kimi/compaction', defaultEffort: 'low', maxOutputSize: 4096 },
    });
    const binding = resolveCompactionBinding(config, flags, own);
    expect(binding.model).toBe(COMPACTION_DERIVED_MODEL_ID);
    expect(binding.thinking).toBe('low');
    expect(binding.displayModel).toBe('kimi/compaction');
  });

  it('binds the legacy default_model pointer when model is unset', () => {
    const { config, flags } = makeServices({
      [COMPACTION_MODEL_SECTION]: { defaultModel: 'kimi/compaction' },
    });
    expect(resolveCompactionBinding(config, flags, own)).toEqual({
      model: 'kimi/compaction',
      thinking: undefined,
      displayModel: 'kimi/compaction',
    });
  });

  it('prefers model over the legacy default_model when both are set', () => {
    const { config, flags } = makeServices({
      [COMPACTION_MODEL_SECTION]: { model: 'kimi/new', defaultModel: 'kimi/legacy' },
    });
    expect(resolveCompactionBinding(config, flags, own).model).toBe('kimi/new');
  });
});

describe('compactionModelBindingFor', () => {
  it('mirrors resolveCompactionBinding (inherits caller when unset)', () => {
    const { config, flags } = makeServices({});
    expect(compactionModelBindingFor(config, flags, own)).toEqual({
      model: own.modelAlias,
      thinking: own.thinkingLevel,
      displayModel: own.modelAlias,
    });
  });

  it('binds the compaction model when set (pointer-only recipe)', () => {
    const { config, flags } = makeServices({
      [COMPACTION_MODEL_SECTION]: { model: 'kimi/compaction' },
    });
    expect(compactionModelBindingFor(config, flags, own)).toEqual({
      model: 'kimi/compaction',
      thinking: undefined,
      displayModel: 'kimi/compaction',
    });
  });
});

describe('compactionDisplayModel', () => {
  it('passes through any non-derived alias', () => {
    const { config } = makeServices({});
    expect(compactionDisplayModel(config, 'kimi/compaction')).toBe('kimi/compaction');
  });

  it('resolves the derived id back to the recipe base alias', () => {
    const { config } = makeServices({
      [COMPACTION_MODEL_SECTION]: { model: 'kimi/compaction' },
    });
    expect(compactionDisplayModel(config, COMPACTION_DERIVED_MODEL_ID)).toBe('kimi/compaction');
  });

  it('falls back to the derived id when the recipe has been removed', () => {
    const { config } = makeServices({});
    expect(compactionDisplayModel(config, COMPACTION_DERIVED_MODEL_ID)).toBe(COMPACTION_DERIVED_MODEL_ID);
  });
});

describe('wrapCompactionModelError', () => {
  const callerModelAlias = 'caller/kimi-coder';

  it('returns the error unchanged when the bound model is the caller own', () => {
    const error = new Error('boom');
    expect(wrapCompactionModelError(error, callerModelAlias)).toBe(error);
  });

  it('returns the error unchanged when the bound model is a pointer-only alias', () => {
    const error = new Error('boom');
    expect(wrapCompactionModelError(error, 'kimi/compaction')).toBe(error);
  });

  it('wraps a failure with a hint pointing at [compaction_model] for the derived id', () => {
    const error = new Error2(ErrorCodes.CONFIG_INVALID, 'Model "kimi/compaction" is not configured.', {
      details: { model: 'kimi/compaction' },
    });
    const wrapped = wrapCompactionModelError(error, COMPACTION_DERIVED_MODEL_ID) as Error;
    expect(wrapped).toBeInstanceOf(Error);
    expect(wrapped.message).toContain(COMPACTION_DERIVED_MODEL_ID);
    expect(wrapped.message).toContain('[compaction_model]');
  });
});

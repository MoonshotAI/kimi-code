import { describe, expect, it } from 'vitest';

import type { ModelAlias } from '../../../src/config';
import {
  defaultThinkingEffortFor,
  resolveThinkingEffort,
  supportsThinkingEffort,
} from '../../../src/agent/config/thinking';

function model(overrides: Partial<ModelAlias> = {}): ModelAlias {
  return {
    provider: 'p',
    model: 'm',
    maxContextSize: 1,
    ...overrides,
  };
}

const booleanModel = model({ capabilities: ['thinking'] });
const effortModel = model({
  capabilities: ['thinking'],
  supportEfforts: ['low', 'medium', 'high'],
});
const effortModelWithDefault = model({
  capabilities: ['thinking'],
  supportEfforts: ['low', 'high', 'max'],
  defaultEffort: 'max',
});
const alwaysThinkingModel = model({ capabilities: ['thinking', 'always_thinking'] });
const alwaysThinkingEffortModel = model({
  capabilities: ['thinking', 'always_thinking'],
  supportEfforts: ['low', 'high', 'max'],
  defaultEffort: 'high',
});
const nonThinkingModel = model({ capabilities: ['tool_use'] });

describe('defaultThinkingEffortFor', () => {
  it('returns off for models that do not support thinking (or an unknown model)', () => {
    expect(defaultThinkingEffortFor(undefined)).toBe('off');
    expect(defaultThinkingEffortFor(nonThinkingModel)).toBe('off');
    expect(defaultThinkingEffortFor(model())).toBe('off');
  });

  it('returns the declared defaultEffort for effort-capable models', () => {
    expect(defaultThinkingEffortFor(effortModelWithDefault)).toBe('max');
  });

  it('ignores a defaultEffort that is not declared in supportEfforts', () => {
    expect(
      defaultThinkingEffortFor(
        model({
          capabilities: ['thinking'],
          supportEfforts: ['low', 'high'],
          defaultEffort: 'max',
        }),
      ),
    ).toBe('high');
  });

  it('falls back to the middle supportEfforts entry when defaultEffort is absent', () => {
    // odd length -> exact middle
    expect(defaultThinkingEffortFor(effortModel)).toBe('medium');
    // even length -> upper-middle index
    expect(defaultThinkingEffortFor(model({ capabilities: ['thinking'], supportEfforts: ['low', 'high'] }))).toBe(
      'high',
    );
    expect(defaultThinkingEffortFor(model({ capabilities: ['thinking'], supportEfforts: ['low'] }))).toBe(
      'low',
    );
  });

  it('returns on for boolean thinking models (thinking support without supportEfforts)', () => {
    expect(defaultThinkingEffortFor(booleanModel)).toBe('on');
    expect(defaultThinkingEffortFor(model({ capabilities: ['always_thinking'] }))).toBe('on');
    expect(defaultThinkingEffortFor(model({ adaptiveThinking: true }))).toBe('on');
  });
});

describe('resolveThinkingEffort', () => {
  it('returns the requested effort verbatim when one is provided', () => {
    expect(resolveThinkingEffort('low', undefined, effortModel)).toBe('low');
    expect(resolveThinkingEffort('on', { enabled: false }, booleanModel)).toBe('on');
    expect(resolveThinkingEffort('off', undefined, booleanModel)).toBe('off');
  });

  it('returns off when config.enabled is false and no effort is requested', () => {
    expect(resolveThinkingEffort(undefined, { enabled: false }, effortModel)).toBe('off');
    expect(resolveThinkingEffort(undefined, { enabled: false, effort: 'high' }, effortModel)).toBe(
      'off',
    );
  });

  it('uses config.effort as the default effort', () => {
    expect(resolveThinkingEffort(undefined, { effort: 'high' }, effortModel)).toBe('high');
    expect(resolveThinkingEffort(undefined, { enabled: true, effort: 'low' }, effortModel)).toBe(
      'low',
    );
  });

  it('falls back to defaultThinkingEffortFor(model) when no effort is configured', () => {
    expect(resolveThinkingEffort(undefined, undefined, effortModel)).toBe('medium');
    expect(resolveThinkingEffort(undefined, {}, booleanModel)).toBe('on');
    expect(resolveThinkingEffort(undefined, undefined, undefined)).toBe('off');
  });

  it('forces always-thinking models back on when the resolved effort is off', () => {
    expect(resolveThinkingEffort('off', undefined, alwaysThinkingModel, true)).toBe('on');
    expect(resolveThinkingEffort(undefined, { enabled: false }, alwaysThinkingModel, true)).toBe(
      'on',
    );
  });

  it('honors a configured effort when clamping always-thinking models back on', () => {
    // enabled=false resolves to 'off', then always_thinking clamps back on;
    // an explicitly configured effort is preserved instead of falling back to
    // the model default.
    expect(
      resolveThinkingEffort(
        undefined,
        { enabled: false, effort: 'max' },
        alwaysThinkingEffortModel,
        true,
      ),
    ).toBe('max');
    // without an explicit effort, fall back to the model's default effort.
    expect(
      resolveThinkingEffort(undefined, { enabled: false }, alwaysThinkingEffortModel, true),
    ).toBe('high');
  });

  it('clamps always-thinking models to their default effort on every protocol', () => {
    // A model declared always-on never resolves to off — claiming off while
    // upstream keeps reasoning at its default would be a lie.
    expect(resolveThinkingEffort('off', undefined, alwaysThinkingEffortModel, false)).toBe(
      'high',
    );
    expect(
      resolveThinkingEffort(undefined, { enabled: false }, alwaysThinkingEffortModel, false),
    ).toBe('high');
    expect(resolveThinkingEffort('off', undefined, alwaysThinkingModel, false)).toBe('on');
  });

  it('normalizes a configured off value (case/whitespace) instead of sending it upstream', () => {
    expect(resolveThinkingEffort(undefined, { effort: ' OFF ' }, effortModel, false)).toBe('off');
    expect(resolveThinkingEffort(undefined, { effort: 'Off' }, booleanModel, false)).toBe('off');
    // … and inside the always-on clamp it is treated as absent, not as an effort.
    expect(
      resolveThinkingEffort(undefined, { enabled: false, effort: ' OFF ' }, alwaysThinkingEffortModel, false),
    ).toBe('high');
  });

  it('reads a whitespace-only configured effort as absent, not as an empty effort', () => {
    expect(resolveThinkingEffort(undefined, { effort: '   ' }, effortModel, false)).toBe('medium');
    expect(resolveThinkingEffort(undefined, { effort: '   ' }, alwaysThinkingModel, false)).toBe('on');
  });

  it('normalizes the requested effort (case/whitespace) on every wire', () => {
    expect(resolveThinkingEffort(' OFF ', undefined, effortModel, false)).toBe('off');
    expect(resolveThinkingEffort(' Max ', undefined, effortModel, false)).toBe('max');
    expect(resolveThinkingEffort('  ', undefined, effortModel, false)).toBe('medium');
  });

  it('treats a configured off as absent when clamping always-thinking models', () => {
    expect(resolveThinkingEffort(undefined, { effort: 'off' }, alwaysThinkingEffortModel, false)).toBe(
      'high',
    );
    expect(
      resolveThinkingEffort(undefined, { enabled: false, effort: 'off' }, alwaysThinkingEffortModel, false),
    ).toBe('high');
    expect(
      resolveThinkingEffort(undefined, { enabled: false, effort: ' OFF ' }, alwaysThinkingEffortModel, false),
    ).toBe('high');
    // … while an explicitly configured concrete effort is still honored.
    expect(
      resolveThinkingEffort(undefined, { enabled: false, effort: 'max' }, alwaysThinkingEffortModel, true),
    ).toBe('max');
  });

  it('does not force on for models that are not always-thinking', () => {
    expect(resolveThinkingEffort('off', undefined, booleanModel)).toBe('off');
    expect(resolveThinkingEffort(undefined, { enabled: false }, booleanModel)).toBe('off');
  });

  it('falls back to the model default for an unsupported Kimi effort', () => {
    expect(resolveThinkingEffort('ultra', undefined, effortModel, true)).toBe('medium');
  });

  it('projects a concrete effort to on for a boolean-only Kimi model', () => {
    expect(resolveThinkingEffort('ultra', undefined, booleanModel, true)).toBe('on');
  });

  it('reports unsupported concrete efforts only for Kimi effort models', () => {
    expect(supportsThinkingEffort('ultra', effortModel, true)).toBe(false);
    expect(supportsThinkingEffort('ultra', effortModel, false)).toBe(true);
  });
});

describe('defaultThinkingEffortFor overrides', () => {
  it('uses overridden supportEfforts for the default effort', () => {
    expect(
      defaultThinkingEffortFor(
        model({
          capabilities: ['thinking'],
          supportEfforts: ['low', 'high', 'max'],
          defaultEffort: 'max',
          overrides: { supportEfforts: ['low', 'high'] },
        }),
      ),
    ).toBe('high');
  });
});

describe('resolveThinkingEffort overrides', () => {
  it('honors overridden always_thinking when clamping off', () => {
    expect(
      resolveThinkingEffort(
        'off',
        { enabled: false },
        model({
          capabilities: ['thinking'],
          overrides: { capabilities: ['thinking', 'always_thinking'] },
        }),
        true,
      ),
    ).toBe('on');
  });

  it('honors overridden capabilities when always_thinking is removed', () => {
    expect(
      resolveThinkingEffort(
        'off',
        { enabled: false },
        model({
          capabilities: ['thinking', 'always_thinking'],
          overrides: { capabilities: ['thinking'] },
        }),
      ),
    ).toBe('off');
  });
});

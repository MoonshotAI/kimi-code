import { describe, expect, it } from 'vitest';

import { resolveThinkingEffort } from '#/agent/profile/thinking';
import { defaultThinkingEffortForModel } from '#/app/model/thinking';

const booleanModel = { capabilities: ['thinking'] };
const effortModel = {
  capabilities: ['thinking'],
  supportEfforts: ['low', 'medium', 'high'],
};
const effortModelWithDefault = {
  capabilities: ['thinking'],
  supportEfforts: ['low', 'high'],
  defaultEffort: 'max',
};
const alwaysThinkingModel = {
  capabilities: ['thinking', 'always_thinking'],
  alwaysThinking: true,
};
const alwaysThinkingEffortModel = {
  capabilities: ['thinking', 'always_thinking'],
  alwaysThinking: true,
  supportEfforts: ['low', 'high', 'max'],
  defaultEffort: 'high',
};
const nonThinkingModel = { capabilities: ['tool_use'] };

describe('defaultThinkingEffortForModel', () => {
  it('returns off for models that do not support thinking (or an unknown model)', () => {
    expect(defaultThinkingEffortForModel(undefined)).toBe('off');
    expect(defaultThinkingEffortForModel(nonThinkingModel)).toBe('off');
    expect(defaultThinkingEffortForModel({})).toBe('off');
  });

  it('returns the declared defaultEffort for effort-capable models', () => {
    expect(defaultThinkingEffortForModel(effortModelWithDefault)).toBe('max');
  });

  it('falls back to the middle supportEfforts entry when defaultEffort is absent', () => {
    expect(defaultThinkingEffortForModel(effortModel)).toBe('medium');
    expect(
      defaultThinkingEffortForModel({
        capabilities: ['thinking'],
        supportEfforts: ['low', 'high'],
      }),
    ).toBe('high');
    expect(
      defaultThinkingEffortForModel({ capabilities: ['thinking'], supportEfforts: ['low'] }),
    ).toBe('low');
  });

  it('returns on for boolean thinking models (thinking support without supportEfforts)', () => {
    expect(defaultThinkingEffortForModel(booleanModel)).toBe('on');
    expect(defaultThinkingEffortForModel({ capabilities: ['always_thinking'] })).toBe('on');
    expect(defaultThinkingEffortForModel({ adaptiveThinking: true })).toBe('on');
  });
});

describe('resolveThinkingEffort', () => {
  it('returns the requested effort verbatim when one is provided', () => {
    expect(resolveThinkingEffort('low', undefined, effortModel)).toBe('low');
    expect(resolveThinkingEffort('on', { enabled: false }, booleanModel)).toBe('on');
    expect(resolveThinkingEffort('off', undefined, booleanModel)).toBe('off');
    expect(resolveThinkingEffort('on', { effort: 'medium' }, effortModel)).toBe('on');
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

  it('falls back to defaultThinkingEffortForModel(model) when no effort is configured', () => {
    expect(resolveThinkingEffort(undefined, undefined, effortModel)).toBe('medium');
    expect(resolveThinkingEffort(undefined, {}, booleanModel)).toBe('on');
    expect(resolveThinkingEffort(undefined, undefined, undefined)).toBe('off');
  });

  it('forces always-thinking models back on when the resolved effort is off', () => {
    expect(resolveThinkingEffort('off', undefined, alwaysThinkingModel)).toBe('on');
    expect(resolveThinkingEffort(undefined, { enabled: false }, alwaysThinkingModel)).toBe('on');
  });

  it('honors a configured effort when clamping always-thinking models back on', () => {
    expect(
      resolveThinkingEffort(
        undefined,
        { enabled: false, effort: 'max' },
        alwaysThinkingEffortModel,
      ),
    ).toBe('max');
    expect(resolveThinkingEffort(undefined, { enabled: false }, alwaysThinkingEffortModel)).toBe(
      'high',
    );
  });

  it('does not force on for models that are not always-thinking', () => {
    expect(resolveThinkingEffort('off', undefined, booleanModel)).toBe('off');
    expect(resolveThinkingEffort(undefined, { enabled: false }, booleanModel)).toBe('off');
  });

  it('carries custom requested efforts through', () => {
    expect(resolveThinkingEffort('xhigh', undefined)).toBe('xhigh');
    expect(resolveThinkingEffort('bogus', { effort: 'low' })).toBe('bogus');
  });

  it('normalizes requested effort case and whitespace', () => {
    expect(resolveThinkingEffort('  Medium ', undefined)).toBe('medium');
    expect(resolveThinkingEffort('OFF', { effort: 'high' })).toBe('off');
  });
});

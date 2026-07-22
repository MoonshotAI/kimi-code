import { describe, expect, it } from 'vitest';

import {
  defaultThinkingEffortForModel,
  modelSupportsThinkingEffort,
  resolveForcedThinkingEffort,
  resolveThinkingEffortForModel,
} from '#/kosong/model/thinking';

// The old `#/agent/profile/thinking` helpers derived "Kimi thinking
// semantics" from `protocol: 'kimi'` on the model fixture. The kosong layer
// has no Kimi protocol (Kimi is a set of `(baseProtocol, traits)`
// registrations, so fixtures use `providerType: 'kimi'` + a legal protocol);
// the semantics verdict is now an explicit `strictValidation` argument
// resolved by the caller through the adapter registry.
const booleanModel = { capabilities: ['thinking'] };
const effortModel = {
  capabilities: ['thinking'],
  supportEfforts: ['low', 'medium', 'high'],
};
const effortModelWithDefault = {
  capabilities: ['thinking'],
  supportEfforts: ['low', 'high', 'max'],
  defaultEffort: 'max',
};
const alwaysThinkingModel = {
  capabilities: ['thinking', 'always_thinking'],
  alwaysThinking: true,
  protocol: 'openai',
  providerType: 'kimi',
};
const alwaysThinkingEffortModel = {
  capabilities: ['thinking', 'always_thinking'],
  alwaysThinking: true,
  protocol: 'openai',
  providerType: 'kimi',
  supportEfforts: ['low', 'high', 'max'],
  defaultEffort: 'high',
};
const nonThinkingModel = { capabilities: ['tool_use'] };
// Named fixtures for the call sites below: inline literals would trip excess
// property checks (`ModelThinkingMetadata` carries no protocol/providerType —
// those fields only document which semantics verdict the case stands for).
const alwaysThinkingAnthropicEffortModel = {
  ...alwaysThinkingEffortModel,
  protocol: 'anthropic',
  providerType: 'kimi',
};
const kimiEffortModel = { ...effortModel, protocol: 'openai', providerType: 'kimi' };
const kimiBooleanModel = { ...booleanModel, protocol: 'openai', providerType: 'kimi' };
const openaiEffortModel = { ...effortModel, providerType: 'openai' };

describe('defaultThinkingEffortForModel', () => {
  it('returns off for models that do not support thinking (or an unknown model)', () => {
    expect(defaultThinkingEffortForModel(undefined)).toBe('off');
    expect(defaultThinkingEffortForModel(nonThinkingModel)).toBe('off');
    expect(defaultThinkingEffortForModel({})).toBe('off');
  });

  it('returns the declared defaultEffort for effort-capable models', () => {
    expect(defaultThinkingEffortForModel(effortModelWithDefault)).toBe('max');
  });

  it('ignores a defaultEffort that is not declared in supportEfforts', () => {
    expect(
      defaultThinkingEffortForModel({
        capabilities: ['thinking'],
        supportEfforts: ['low', 'high'],
        defaultEffort: 'max',
      }),
    ).toBe('high');
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

describe('resolveThinkingEffortForModel', () => {
  it('returns the requested effort verbatim when one is provided', () => {
    expect(resolveThinkingEffortForModel('low', undefined, effortModel)).toBe('low');
    expect(resolveThinkingEffortForModel('on', { enabled: false }, booleanModel)).toBe('on');
    expect(resolveThinkingEffortForModel('off', undefined, booleanModel)).toBe('off');
    expect(resolveThinkingEffortForModel('on', { effort: 'medium' }, effortModel)).toBe('medium');
  });

  it('returns off when config.enabled is false and no effort is requested', () => {
    expect(resolveThinkingEffortForModel(undefined, { enabled: false }, effortModel)).toBe('off');
    expect(
      resolveThinkingEffortForModel(undefined, { enabled: false, effort: 'high' }, effortModel),
    ).toBe('off');
  });

  it('uses config.effort as the default effort', () => {
    expect(resolveThinkingEffortForModel(undefined, { effort: 'high' }, effortModel)).toBe('high');
    expect(
      resolveThinkingEffortForModel(undefined, { enabled: true, effort: 'low' }, effortModel),
    ).toBe('low');
  });

  it('falls back to defaultThinkingEffortForModel(model) when no effort is configured', () => {
    expect(resolveThinkingEffortForModel(undefined, undefined, effortModel)).toBe('medium');
    expect(resolveThinkingEffortForModel(undefined, {}, booleanModel)).toBe('on');
    expect(resolveThinkingEffortForModel(undefined, undefined, undefined)).toBe('off');
  });

  it('forces always-thinking models back on when the resolved effort is off', () => {
    expect(resolveThinkingEffortForModel('off', undefined, alwaysThinkingModel, true)).toBe('on');
    expect(
      resolveThinkingEffortForModel(undefined, { enabled: false }, alwaysThinkingModel, true),
    ).toBe('on');
  });

  it('honors a configured effort when clamping always-thinking models back on', () => {
    expect(
      resolveThinkingEffortForModel(
        undefined,
        { enabled: false, effort: 'max' },
        alwaysThinkingEffortModel,
        true,
      ),
    ).toBe('max');
    expect(
      resolveThinkingEffortForModel(undefined, { enabled: false }, alwaysThinkingEffortModel, true),
    ).toBe('high');
  });

  it('does not force on for models that are not always-thinking', () => {
    expect(resolveThinkingEffortForModel('off', undefined, booleanModel)).toBe('off');
    expect(resolveThinkingEffortForModel(undefined, { enabled: false }, booleanModel)).toBe('off');
  });

  it('clamps always-thinking models to their default effort even without strict validation', () => {
    // A model declared always-on never resolves to off, on any wire — claiming
    // off while upstream keeps reasoning at its default would be a lie. This
    // covers Kimi-managed models routed through the Anthropic transport and
    // catalog-imported always-thinking models (e.g. gpt-5) alike.
    expect(
      resolveThinkingEffortForModel('off', undefined, alwaysThinkingAnthropicEffortModel),
    ).toBe('high');
    expect(
      resolveThinkingEffortForModel(undefined, { enabled: false }, alwaysThinkingAnthropicEffortModel),
    ).toBe('high');
    expect(resolveThinkingEffortForModel('off', undefined, alwaysThinkingModel)).toBe('on');
  });

  it('normalizes a configured off value (case/whitespace) instead of sending it upstream', () => {
    expect(resolveThinkingEffortForModel(undefined, { effort: ' OFF ' }, effortModel)).toBe('off');
    expect(resolveThinkingEffortForModel(undefined, { effort: 'Off' }, booleanModel)).toBe('off');
    expect(
      resolveThinkingEffortForModel(undefined, { enabled: false, effort: ' OFF ' }, alwaysThinkingEffortModel),
    ).toBe('high');
  });

  it('normalizes the env-forced effort (case/whitespace)', () => {
    expect(resolveForcedThinkingEffort(' MAX ', 'high', true)).toBe('max');
    expect(resolveForcedThinkingEffort('   ', 'high', true)).toBeUndefined();
  });

  it('treats a configured off as absent when clamping always-thinking models', () => {
    expect(resolveThinkingEffortForModel(undefined, { effort: 'off' }, alwaysThinkingEffortModel)).toBe(
      'high',
    );
    expect(
      resolveThinkingEffortForModel(undefined, { enabled: false, effort: 'off' }, alwaysThinkingEffortModel),
    ).toBe('high');
    expect(
      resolveThinkingEffortForModel(undefined, { enabled: false, effort: 'max' }, alwaysThinkingEffortModel),
    ).toBe('max');
  });

  it('carries custom requested efforts through', () => {
    expect(resolveThinkingEffortForModel('xhigh', undefined, undefined)).toBe('xhigh');
    expect(resolveThinkingEffortForModel('bogus', { effort: 'low' }, undefined)).toBe('bogus');
  });

  it('normalizes requested effort case and whitespace', () => {
    expect(resolveThinkingEffortForModel('  Medium ', undefined, undefined)).toBe('medium');
    expect(resolveThinkingEffortForModel('OFF', { effort: 'high' }, undefined)).toBe('off');
  });

  it('falls back to the model default for an unsupported Kimi effort', () => {
    expect(resolveThinkingEffortForModel('ultra', undefined, kimiEffortModel, true)).toBe(
      'medium',
    );
  });

  it('projects a concrete effort to on for a boolean-only Kimi model', () => {
    expect(resolveThinkingEffortForModel('ultra', undefined, kimiBooleanModel, true)).toBe('on');
  });

  it('reports unsupported concrete efforts only for Kimi effort models', () => {
    expect(modelSupportsThinkingEffort('ultra', kimiEffortModel, true)).toBe(false);
    expect(modelSupportsThinkingEffort('ultra', openaiEffortModel, false)).toBe(true);
  });
});

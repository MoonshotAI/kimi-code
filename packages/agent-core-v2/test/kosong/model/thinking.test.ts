import { describe, expect, it } from 'vitest';

import { ProtocolAdapterRegistry } from '#/kosong/provider/protocolAdapterRegistry';
import '#/kosong/provider/providers/kimi/kimi.contrib';
import '#/kosong/provider/providers/standard.contrib';
import {
  defaultThinkingEffortForModel,
  drivesThinkingThroughTraits,
  modelSupportsThinkingEffort,
  requiresStrictThinkingValidation,
  resolveForcedThinkingEffort,
  resolveThinkingEffortForModel,
  resolveThinkingEffortForModelWithFallback,
  resolveThinkingKeep,
  usesTraitDrivenThinking,
} from '#/kosong/model/thinking';

const registry = new ProtocolAdapterRegistry();

describe('registry-driven vendor verdicts', () => {
  it('drivesThinkingThroughTraits: trait-driven vendors only, no string branches', () => {
    expect(drivesThinkingThroughTraits('kimi')).toBe(true);
    expect(drivesThinkingThroughTraits('openai')).toBe(false);
    expect(drivesThinkingThroughTraits('anthropic')).toBe(false);
    expect(drivesThinkingThroughTraits('never-registered')).toBe(false);
    expect(drivesThinkingThroughTraits(undefined)).toBe(false);
  });

  it('usesTraitDrivenThinking: native traits and the (kimi, anthropic) pair registration', () => {
    expect(usesTraitDrivenThinking(registry, 'openai', 'kimi')).toBe(true);
    expect(usesTraitDrivenThinking(registry, 'anthropic', 'kimi')).toBe(true);
    expect(usesTraitDrivenThinking(registry, 'openai', 'openai')).toBe(false);
    expect(usesTraitDrivenThinking(registry, 'openai', undefined)).toBe(false);
    expect(usesTraitDrivenThinking(registry, 'anthropic', 'anthropic')).toBe(false);
    expect(usesTraitDrivenThinking(registry, 'google-genai', 'kimi')).toBe(false);
  });

  it('requiresStrictThinkingValidation: only the strict-validation thinking driver', () => {
    expect(requiresStrictThinkingValidation(registry, 'openai', 'kimi')).toBe(true);
    expect(requiresStrictThinkingValidation(registry, 'anthropic', 'kimi')).toBe(false);
    expect(requiresStrictThinkingValidation(registry, 'openai', 'openai')).toBe(false);
    expect(requiresStrictThinkingValidation(registry, 'openai', undefined)).toBe(false);
    expect(requiresStrictThinkingValidation(registry, 'anthropic', 'anthropic')).toBe(false);
  });
});

describe('resolveThinkingEffortForModel', () => {
  const thinkingModel = {
    capabilities: ['thinking'],
    supportEfforts: ['low', 'medium', 'high'],
    defaultEffort: 'high',
  };

  it('prefers the normalized request, then config, then the model default', () => {
    expect(resolveThinkingEffortForModel('HIGH', undefined, thinkingModel, true)).toBe('high');
    expect(resolveThinkingEffortForModel(undefined, { effort: 'low' }, thinkingModel, true)).toBe('low');
    expect(resolveThinkingEffortForModel(undefined, undefined, thinkingModel, true)).toBe('high');
    expect(resolveThinkingEffortForModel(undefined, { enabled: false }, thinkingModel, true)).toBe('off');
  });

  it('picks the middle effort when the model declares no default', () => {
    expect(
      defaultThinkingEffortForModel({ capabilities: ['thinking'], supportEfforts: ['low', 'medium', 'high'] }),
    ).toBe('medium');
    expect(defaultThinkingEffortForModel({ capabilities: ['thinking'] })).toBe('on');
    expect(defaultThinkingEffortForModel(undefined)).toBe('off');
  });

  it('normalizes unknown efforts back to the model default on any wire', () => {
    expect(resolveThinkingEffortForModel('extreme', undefined, thinkingModel, true)).toBe('high');
    expect(resolveThinkingEffortForModel('extreme', undefined, thinkingModel, false)).toBe('high');
    expect(resolveThinkingEffortForModel('on', undefined, thinkingModel, true)).toBe('high');
    expect(resolveThinkingEffortForModel('on', undefined, thinkingModel, false)).toBe('high');
  });

  it('falls back to the declared default for an unlisted effort without strict validation', () => {
    const declared = {
      capabilities: ['thinking'],
      supportEfforts: ['low', 'medium', 'xhigh'],
      defaultEffort: 'xhigh',
    };
    expect(resolveThinkingEffortForModel(undefined, { effort: 'high' }, declared, false)).toBe(
      'xhigh',
    );
    expect(resolveThinkingEffortForModel('high', undefined, declared, false)).toBe('xhigh');
    expect(resolveThinkingEffortForModel('medium', undefined, declared, false)).toBe('medium');
  });

  it('passes concrete efforts through when the model declares no effort list', () => {
    expect(
      resolveThinkingEffortForModel('extreme', undefined, { capabilities: ['thinking'] }, false),
    ).toBe('extreme');
    expect(
      resolveThinkingEffortForModel(
        undefined,
        { effort: 'extreme' },
        { capabilities: ['thinking'] },
        false,
      ),
    ).toBe('extreme');
  });

  it('falls back to the declared default when the model omits the thinking capability', () => {
    const declared = {
      supportEfforts: ['low', 'medium', 'xhigh'],
      defaultEffort: 'xhigh',
    };
    expect(resolveThinkingEffortForModel(undefined, { effort: 'high' }, declared, false)).toBe(
      'xhigh',
    );
    expect(resolveThinkingEffortForModel('high', undefined, declared, false)).toBe('xhigh');
    const withFallback = resolveThinkingEffortForModelWithFallback(
      'high',
      undefined,
      declared,
      false,
    );
    expect(withFallback.effort).toBe('xhigh');
    expect(withFallback.fallback).toEqual({ configured: 'high', resolved: 'xhigh' });
    expect(
      resolveThinkingEffortForModel(
        'high',
        undefined,
        { supportEfforts: ['low', 'medium', 'xhigh'] },
        false,
      ),
    ).toBe('medium');
  });

  it('treats a declared effort list as thinking support under strict validation', () => {
    const declared = {
      supportEfforts: ['low', 'medium', 'xhigh'],
      defaultEffort: 'xhigh',
    };
    expect(resolveThinkingEffortForModel(undefined, { effort: 'high' }, declared, true)).toBe(
      'xhigh',
    );
    expect(resolveThinkingEffortForModel('high', undefined, declared, true)).toBe('xhigh');
    expect(resolveThinkingEffortForModel('on', undefined, declared, true)).toBe('xhigh');
    expect(resolveThinkingEffortForModel('medium', undefined, declared, true)).toBe('medium');
    expect(modelSupportsThinkingEffort('low', declared, true)).toBe(true);
    expect(modelSupportsThinkingEffort('bogus', declared, true)).toBe(false);
    expect(resolveThinkingEffortForModelWithFallback('high', undefined, declared, true)).toEqual({
      effort: 'xhigh',
      fallback: { configured: 'high', resolved: 'xhigh' },
    });
  });

  it('resolves the declared default when nothing is configured and the capability is omitted', () => {
    const declared = {
      supportEfforts: ['low', 'medium', 'xhigh'],
      defaultEffort: 'xhigh',
    };
    expect(defaultThinkingEffortForModel(declared)).toBe('xhigh');
    expect(resolveThinkingEffortForModel(undefined, undefined, declared, false)).toBe('xhigh');
    expect(resolveThinkingEffortForModel(undefined, undefined, declared, true)).toBe('xhigh');
  });

  it('trims a padded default_effort before matching the declared list', () => {
    expect(
      defaultThinkingEffortForModel({
        supportEfforts: [' low ', ' medium ', ' xhigh '],
        defaultEffort: ' xhigh ',
      }),
    ).toBe('xhigh');
  });

  it('keeps always-thinking models on under kimi semantics', () => {
    const always = {
      capabilities: ['always_thinking'],
      alwaysThinking: true,
      supportEfforts: ['low', 'high'],
      defaultEffort: 'low',
    };
    expect(resolveThinkingEffortForModel('off', undefined, always, true)).toBe('low');
    expect(resolveThinkingEffortForModel('off', undefined, thinkingModel, true)).toBe('off');
  });

  it('modelSupportsThinkingEffort validates against the declared effort list', () => {
    expect(modelSupportsThinkingEffort('high', thinkingModel, true)).toBe(true);
    expect(modelSupportsThinkingEffort('extreme', thinkingModel, true)).toBe(false);
    expect(modelSupportsThinkingEffort('off', thinkingModel, true)).toBe(true);
    expect(modelSupportsThinkingEffort('extreme', thinkingModel, false)).toBe(true);
  });
});

describe('resolveForcedThinkingEffort', () => {
  it('applies the forced effort only for trait-driven vendors with thinking on', () => {
    expect(resolveForcedThinkingEffort('low', 'high', true)).toBe('low');
    expect(resolveForcedThinkingEffort('low', 'off', true)).toBeUndefined();
    expect(resolveForcedThinkingEffort('low', 'high', false)).toBeUndefined();
    expect(resolveForcedThinkingEffort(undefined, 'high', true)).toBeUndefined();
  });
});

describe('resolveThinkingKeep', () => {
  it('never keeps when thinking is off', () => {
    expect(resolveThinkingKeep('all', 'all', 'off')).toBeUndefined();
  });

  it('honors explicit off-values as a specified disable', () => {
    expect(resolveThinkingKeep('off', undefined, 'on')).toBeUndefined();
    expect(resolveThinkingKeep('0', 'all', 'on')).toBeUndefined();
    expect(resolveThinkingKeep(undefined, 'none', 'on')).toBeUndefined();
  });

  it('env wins over config; the default is all', () => {
    expect(resolveThinkingKeep('summary', 'all', 'on')).toBe('summary');
    expect(resolveThinkingKeep(undefined, 'summary', 'on')).toBe('summary');
    expect(resolveThinkingKeep(undefined, undefined, 'on')).toBe('all');
  });
});

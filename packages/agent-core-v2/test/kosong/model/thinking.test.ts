/**
 * `kosong/model` thinking tests — effort/keep resolution and the
 * registry-driven vendor verdicts:
 *
 *  - `drivesThinkingThroughTraits` answers through the definition registry:
 *    true once the kimi definitions are registered (their traits declare
 *    `withThinking`), false for the endpoint-only canonical vendors and for
 *    unregistered ones;
 *  - `usesTraitDrivenThinking` answers through the adapter registry's one
 *    resolution point — true for kimi on its native transport AND for kimi
 *    over anthropic (the `(kimi, anthropic)` pair registration), false for
 *    plain openai and for pairs kimi never registered;
 *  - `requiresStrictThinkingValidation` narrows that verdict to the strict
 *    effort-validation gate (v1 `provider.type === 'kimi'` parity): true only
 *    when the pair's thinking driver marks `strictThinkingValidation`, false
 *    for kimi over anthropic;
 *  - effort resolution folds request/config/model metadata with the
 *    trait-driven normalization rules; keep resolution honors off-values and
 *    precedence.
 */

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
    // Kimi registers no google-genai definition — the pair contributes nothing.
    expect(usesTraitDrivenThinking(registry, 'google-genai', 'kimi')).toBe(false);
  });

  it('requiresStrictThinkingValidation: only the strict-validation thinking driver', () => {
    // The strict effort gate (v1 `provider.type === 'kimi'` parity): kimi on
    // its native openai transport qualifies (kimiOpenAITrait marks
    // `strictThinkingValidation`); kimi over anthropic does NOT — the foreign
    // backend may accept unlisted efforts, so the profile stays lenient there
    // and warns instead of rejecting.
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

  it('normalizes unknown efforts back to the model default under kimi semantics', () => {
    expect(resolveThinkingEffortForModel('extreme', undefined, thinkingModel, true)).toBe('high');
    expect(resolveThinkingEffortForModel('extreme', undefined, thinkingModel, false)).toBe('extreme');
    expect(resolveThinkingEffortForModel('on', undefined, thinkingModel, true)).toBe('high');
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

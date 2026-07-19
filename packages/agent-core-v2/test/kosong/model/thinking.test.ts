/**
 * `kosong/model` thinking tests — effort/keep resolution and the
 * registry-driven vendor verdicts:
 *
 *  - `isKimiProvider` answers through the definition registry: true once the
 *    kimi definition is registered (its native traits declare `withThinking`),
 *    false for the endpoint-only canonical vendors and for unregistered ones;
 *  - `usesKimiThinkingSemantics` answers through the adapter registry's one
 *    resolution point — true for kimi on its native transport AND for kimi
 *    over anthropic (the `dialects.anthropic` slice), false for plain openai;
 *  - effort resolution folds request/config/model metadata with the kimi
 *    normalization rules; keep resolution honors off-values and precedence.
 */

import { describe, expect, it } from 'vitest';

import { ProtocolAdapterRegistry } from '#/kosong/provider/protocolAdapterRegistry';
import '#/kosong/provider/providers/kimi/kimi.contrib';
import '#/kosong/provider/providers/standard.contrib';
import {
  defaultThinkingEffortForModel,
  isKimiProvider,
  modelSupportsThinkingEffort,
  resolveKimiThinkingEffortOverride,
  resolveThinkingEffortForModel,
  resolveThinkingKeep,
  usesKimiThinkingSemantics,
} from '#/kosong/model/thinking';

const registry = new ProtocolAdapterRegistry();

describe('registry-driven vendor verdicts', () => {
  it('isKimiProvider: trait-driven vendors only, no string branches', () => {
    expect(isKimiProvider('kimi')).toBe(true);
    expect(isKimiProvider('openai')).toBe(false);
    expect(isKimiProvider('anthropic')).toBe(false);
    expect(isKimiProvider('never-registered')).toBe(false);
    expect(isKimiProvider(undefined)).toBe(false);
  });

  it('usesKimiThinkingSemantics: native traits and the anthropic dialect slice', () => {
    expect(usesKimiThinkingSemantics(registry, 'openai', 'kimi')).toBe(true);
    expect(usesKimiThinkingSemantics(registry, 'anthropic', 'kimi')).toBe(true);
    expect(usesKimiThinkingSemantics(registry, 'openai', 'openai')).toBe(false);
    expect(usesKimiThinkingSemantics(registry, 'openai', undefined)).toBe(false);
    expect(usesKimiThinkingSemantics(registry, 'anthropic', 'anthropic')).toBe(false);
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

describe('resolveKimiThinkingEffortOverride', () => {
  it('applies the forced effort only for trait-driven vendors with thinking on', () => {
    expect(resolveKimiThinkingEffortOverride('low', 'high', true)).toBe('low');
    expect(resolveKimiThinkingEffortOverride('low', 'off', true)).toBeUndefined();
    expect(resolveKimiThinkingEffortOverride('low', 'high', false)).toBeUndefined();
    expect(resolveKimiThinkingEffortOverride(undefined, 'high', true)).toBeUndefined();
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

import { describe, expect, it } from 'vitest';

import { ProtocolAdapterRegistry } from '#/llm-adapter/protocol/protocolAdapterRegistry';
import {
  drivesThinkingThroughTraits,
  requiresStrictThinkingValidation,
  usesTraitDrivenThinking,
} from '#/llm-adapter/model/thinking';
import {
  declaredDefaultEffortForModel,
  defaultThinkingEffortForModel,
  modelSupportsThinkingEffort,
  resolveForcedThinkingEffort,
  resolveThinkingEffortForModel,
  resolveThinkingKeep,
} from '@moonshot-ai/core/llm/thinking';
import type { LlmModelSpec } from '@moonshot-ai/core/llm/request';

const registry = new ProtocolAdapterRegistry();

function spec(input: {
  readonly capabilities?: readonly string[];
  readonly supportEfforts?: readonly string[];
  readonly defaultEffort?: string;
  readonly alwaysThinking?: boolean;
  readonly adaptiveThinking?: boolean;
}): LlmModelSpec {
  const declared = new Set(input.capabilities ?? []);
  return {
    provider: "test",
    name: "test",
    capability: {
      image_in: declared.has("image_in"),
      video_in: declared.has("video_in"),
      audio_in: declared.has("audio_in"),
      thinking: declared.has("thinking") || declared.has("always_thinking"),
      tool_use: declared.has("tool_use"),
    },
    thinking: {
      supportEfforts: input.supportEfforts,
      defaultEffort: input.defaultEffort,
      alwaysThinking: input.alwaysThinking,
      adaptiveThinking: input.adaptiveThinking,
    },
  };
}


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
  const thinkingModel = spec({
    capabilities: ['thinking'],
    supportEfforts: ['low', 'medium', 'high'],
    defaultEffort: 'high',
  });

  it('prefers the normalized request, then config, then the model default', () => {
    expect(resolveThinkingEffortForModel('HIGH', undefined, thinkingModel, true)).toBe('high');
    expect(resolveThinkingEffortForModel(undefined, { effort: 'low' }, thinkingModel, true)).toBe('low');
    expect(resolveThinkingEffortForModel(undefined, undefined, thinkingModel, true)).toBe('high');
    expect(resolveThinkingEffortForModel(undefined, { enabled: false }, thinkingModel, true)).toBe('off');
  });

  it('picks the middle effort when the model declares no default', () => {
    expect(
      defaultThinkingEffortForModel(spec({ capabilities: ['thinking'], supportEfforts: ['low', 'medium', 'high'] })),
    ).toBe('medium');
    expect(defaultThinkingEffortForModel(spec({ capabilities: ['thinking'] }))).toBe('on');
    expect(defaultThinkingEffortForModel(undefined)).toBe('off');
  });

  it('normalizes unknown efforts back to the model default under kimi semantics', () => {
    expect(resolveThinkingEffortForModel('extreme', undefined, thinkingModel, true)).toBe('high');
    expect(resolveThinkingEffortForModel('extreme', undefined, thinkingModel, false)).toBe('extreme');
    expect(resolveThinkingEffortForModel('on', undefined, thinkingModel, true)).toBe('high');
  });

  it('keeps always-thinking models on under kimi semantics', () => {
    const always = spec({
      capabilities: ['always_thinking'],
      alwaysThinking: true,
      supportEfforts: ['low', 'high'],
      defaultEffort: 'low',
    });
    expect(resolveThinkingEffortForModel('off', undefined, always, true)).toBe('low');
    expect(resolveThinkingEffortForModel('off', undefined, thinkingModel, true)).toBe('off');
  });

  it('modelSupportsThinkingEffort validates against the declared effort list', () => {
    expect(modelSupportsThinkingEffort('high', thinkingModel, true)).toBe(true);
    expect(modelSupportsThinkingEffort('extreme', thinkingModel, true)).toBe(false);
    expect(modelSupportsThinkingEffort('off', thinkingModel, true)).toBe(true);
    expect(modelSupportsThinkingEffort('extreme', thinkingModel, false)).toBe(true);
  });

  it('declaredDefaultEffortForModel returns the declared default only when the model lists it', () => {
    expect(declaredDefaultEffortForModel(thinkingModel)).toBe('high');
    expect(
      declaredDefaultEffortForModel(spec({
        capabilities: ['thinking'],
        supportEfforts: ['low', 'medium'],
        defaultEffort: 'high',
      })),
    ).toBeUndefined();
    expect(
      declaredDefaultEffortForModel(spec({ capabilities: ['thinking'], supportEfforts: ['low'] })),
    ).toBeUndefined();
    expect(
      declaredDefaultEffortForModel(spec({ supportEfforts: ['max'], defaultEffort: 'max' })),
    ).toBeUndefined();
    expect(declaredDefaultEffortForModel(undefined)).toBeUndefined();
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

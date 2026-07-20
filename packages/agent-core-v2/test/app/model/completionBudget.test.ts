import type { ModelCapability } from '#/app/llmProtocol/capability';
import type { Model } from '#/app/model/modelInstance';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  applyCompletionBudget,
  computeCompletionBudgetCap,
  resolveCompletionBudget,
} from '#/app/model/completionBudget';

function makeCapability(maxContextTokens: number): ModelCapability {
  return {
    image_in: false,
    video_in: false,
    audio_in: false,
    thinking: false,
    tool_use: true,
    max_context_tokens: maxContextTokens,
  };
}

describe('computeCompletionBudgetCap', () => {
  it('uses fallback when context size is unknown and no hard cap is set', () => {
    expect(
      computeCompletionBudgetCap({
        budget: { fallback: 8192 },
        capability: undefined,
      }),
    ).toBe(8192);
  });

  it('uses the model context window when no hard cap is set', () => {
    expect(
      computeCompletionBudgetCap({
        budget: { fallback: 32000 },
        capability: makeCapability(100000),
      }),
    ).toBe(100000);
  });

  it('uses the explicit hard cap when configured', () => {
    expect(
      computeCompletionBudgetCap({
        budget: { hardCap: 32000 },
        capability: makeCapability(10000),
      }),
    ).toBe(32000);
  });

  it('floors at 1 when hard cap is zero or negative', () => {
    expect(
      computeCompletionBudgetCap({
        budget: { hardCap: 0 },
        capability: undefined,
      }),
    ).toBe(1);
    expect(
      computeCompletionBudgetCap({
        budget: { hardCap: -100 },
        capability: undefined,
      }),
    ).toBe(1);
  });
});

describe('applyCompletionBudget', () => {
  let withMaxCompletionTokens: ReturnType<typeof vi.fn>;
  let original: Model;

  beforeEach(() => {
    const cloneFactory = (tokens: number): Model =>
      ({ ...original, _maxTokensApplied: tokens }) as unknown as Model;
    withMaxCompletionTokens = vi.fn(cloneFactory);
    original = {
      name: 'mock',
      modelName: 'mock-model',
      thinkingEffort: null,
      generate: vi.fn(),
      withThinking: vi.fn(),
      withMaxCompletionTokens: withMaxCompletionTokens as unknown as (n: number) => Model,
      withProviderOptions: vi.fn(),
    } as unknown as Model;
  });

  it('returns the original model when no budget is configured', () => {
    const result = applyCompletionBudget({
      model: original,
      budget: undefined,
      capability: makeCapability(10000),
    });

    expect(result).toBe(original);
    expect(withMaxCompletionTokens).not.toHaveBeenCalled();
  });

  it('clones the model with the model context window when budget is configured', () => {
    const result = applyCompletionBudget({
      model: original,
      budget: { fallback: 32000 },
      capability: makeCapability(10000),
    });

    expect(withMaxCompletionTokens).toHaveBeenCalledOnce();
    expect(withMaxCompletionTokens.mock.calls[0]?.[0]).toBe(10000);
    expect(result).not.toBe(original);
  });

  it('passes used and max context tokens to the model budget hook', () => {
    applyCompletionBudget({
      model: original,
      budget: { hardCap: 4096 },
      capability: makeCapability(10000),
      usedContextTokens: 2500,
    });

    expect(withMaxCompletionTokens).toHaveBeenCalledOnce();
    expect(withMaxCompletionTokens.mock.calls[0]?.[1]).toEqual({
      usedContextTokens: 2500,
      maxContextTokens: 10000,
    });
  });
});

describe('resolveCompletionBudget', () => {
  it('uses maxCompletionTokensCap first', () => {
    expect(
      resolveCompletionBudget({
        maxCompletionTokensCap: 4096,
        maxOutputSize: 8192,
        reservedContextSize: 12345,
      }),
    ).toEqual({ hardCap: 4096 });
  });

  it('treats non-positive maxCompletionTokensCap as an opt-out', () => {
    expect(resolveCompletionBudget({ maxCompletionTokensCap: 0 })).toBeUndefined();
    expect(resolveCompletionBudget({ maxCompletionTokensCap: -1 })).toBeUndefined();
  });

  it('uses model max output size when no explicit cap is set', () => {
    expect(
      resolveCompletionBudget({
        maxOutputSize: 384000,
        reservedContextSize: 12345,
      }),
    ).toEqual({ hardCap: 384000 });
  });

  it('uses reservedContextSize as the unknown-context fallback', () => {
    expect(resolveCompletionBudget({ reservedContextSize: 12345 })).toEqual({
      fallback: 12345,
    });
  });

  it('falls back to 32000 only for unknown context when nothing is configured', () => {
    expect(resolveCompletionBudget({})).toEqual({ fallback: 32000 });
  });
});

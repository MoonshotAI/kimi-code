import { describe, expect, it } from 'vitest';

import type { ModelCapability } from '#/llm-adapter/contract/capability';
import {
  completionBudgetParams,
  resolveCompletionBudget,
} from '#/llm-adapter/model/completion-budget';

const capability = (maxContextTokens: number): ModelCapability => ({
  image_in: false,
  video_in: false,
  audio_in: false,
  thinking: false,
  tool_use: true,
  max_context_tokens: maxContextTokens,
});

describe('resolveCompletionBudget', () => {
  it('prefers the explicit cap, then maxOutputSize, and omits the budget otherwise', () => {
    expect(
      resolveCompletionBudget({ maxCompletionTokensCap: 100, maxOutputSize: 200 }),
    ).toBe(100);
    expect(resolveCompletionBudget({ maxOutputSize: 200 })).toBe(200);
    expect(resolveCompletionBudget({})).toBeUndefined();
  });

  it('ignores non-positive caps and sizes', () => {
    expect(resolveCompletionBudget({ maxCompletionTokensCap: 0 })).toBeUndefined();
    expect(resolveCompletionBudget({ maxCompletionTokensCap: -5, maxOutputSize: 200 })).toBeUndefined();
    expect(resolveCompletionBudget({ maxOutputSize: 0 })).toBeUndefined();
  });
});

describe('completionBudgetParams (the budget fold)', () => {
  it('applies the floor to the resolved budget regardless of the capability window', () => {
    expect(completionBudgetParams({ budget: 50, capability: capability(128000) })).toEqual({
      maxCompletionTokens: 50,
      usedContextTokens: undefined,
      maxContextTokens: 128000,
    });
  });

  it('returns undefined without a budget', () => {
    expect(completionBudgetParams({ budget: undefined, capability: capability(1000) })).toBeUndefined();
  });

  it('carries the used context size when the caller did not override messages', () => {
    expect(
      completionBudgetParams({
        budget: 8192,
        capability: capability(128000),
        usedContextTokens: 5000,
      }),
    ).toEqual({
      maxCompletionTokens: 8192,
      usedContextTokens: 5000,
      maxContextTokens: 128000,
    });
  });

  it('omits usedContextTokens with explicit messages — no tightening against the current context', () => {
    const params = completionBudgetParams({
      budget: 8192,
      capability: capability(128000),
      usedContextTokens: undefined,
    });
    expect(params?.maxCompletionTokens).toBe(8192);
    expect(params?.maxContextTokens).toBe(128000);
    expect(params?.usedContextTokens).toBeUndefined();
  });
});

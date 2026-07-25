/**
 * `kosong/model` completion-budget tests — pure resolution and fold:
 *
 *  - `resolveCompletionBudget` precedence: explicit cap > maxOutputSize >
 *    reservedContextSize > the unknown-context fallback;
 *  - `computeCompletionBudgetCap`: hardCap wins, otherwise the capability
 *    context size, otherwise the fallback — floored at 1;
 *  - `completionBudgetParams` folds the budget into the requester params: the
 *    measured `usedContextTokens` rides along ONLY when the caller passes it
 *    (i.e. when the request did not override its messages — with explicit
 *    messages the budget is not tightened against the current context).
 */

import { describe, expect, it } from 'vitest';

import type { ModelCapability } from '#/kosong/contract/capability';
import {
  completionBudgetParams,
  computeCompletionBudgetCap,
  resolveCompletionBudget,
} from '#/kosong/model/completionBudget';

const capability = (maxContextTokens: number): ModelCapability => ({
  image_in: false,
  video_in: false,
  audio_in: false,
  thinking: false,
  tool_use: true,
  max_context_tokens: maxContextTokens,
});

describe('resolveCompletionBudget', () => {
  it('prefers the explicit cap, then maxOutputSize, then reservedContextSize', () => {
    expect(
      resolveCompletionBudget({ maxCompletionTokensCap: 100, maxOutputSize: 200, reservedContextSize: 300 }),
    ).toEqual({ hardCap: 100 });
    expect(resolveCompletionBudget({ maxOutputSize: 200, reservedContextSize: 300 })).toEqual({ hardCap: 200 });
    expect(resolveCompletionBudget({ reservedContextSize: 300 })).toEqual({ fallback: 300 });
    expect(resolveCompletionBudget({})).toEqual({ fallback: 32000 });
  });

  it('ignores non-positive caps and sizes', () => {
    expect(resolveCompletionBudget({ maxCompletionTokensCap: 0 })).toBeUndefined();
    expect(resolveCompletionBudget({ maxCompletionTokensCap: -5, maxOutputSize: 200 })).toBeUndefined();
    expect(resolveCompletionBudget({ maxOutputSize: 0, reservedContextSize: -1 })).toEqual({ fallback: 32000 });
  });
});

describe('computeCompletionBudgetCap', () => {
  it('hardCap wins over the capability context size', () => {
    expect(computeCompletionBudgetCap({ budget: { hardCap: 50 }, capability: capability(128000) })).toBe(50);
  });

  it('falls back to the capability context size, then the configured fallback', () => {
    expect(computeCompletionBudgetCap({ budget: { fallback: 300 }, capability: capability(128000) })).toBe(128000);
    expect(computeCompletionBudgetCap({ budget: { fallback: 300 }, capability: capability(0) })).toBe(300);
    expect(computeCompletionBudgetCap({ budget: {}, capability: undefined })).toBe(32000);
  });
});

describe('completionBudgetParams (the budget fold)', () => {
  it('returns undefined without a budget', () => {
    expect(completionBudgetParams({ budget: undefined, capability: capability(1000) })).toBeUndefined();
  });

  it('carries the measured usedContextTokens when the caller did not override messages', () => {
    expect(
      completionBudgetParams({
        budget: { hardCap: 8192 },
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
      budget: { hardCap: 8192 },
      capability: capability(128000),
      usedContextTokens: undefined,
    });
    expect(params?.maxCompletionTokens).toBe(8192);
    expect(params?.maxContextTokens).toBe(128000);
    expect(params?.usedContextTokens).toBeUndefined();
  });
});

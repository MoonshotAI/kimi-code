import { describe, expect, it } from 'vitest';

import { resolveCompletionBudget } from '#/llm-adapter/model/completion-budget';

describe('resolveCompletionBudget', () => {
  it('prefers the explicit cap, then maxOutputSize, and omits the budget otherwise', () => {
    expect(
      resolveCompletionBudget({ maxCompletionTokensCap: 100, maxOutputSize: 200 }),
    ).toBe(100);
    expect(resolveCompletionBudget({ maxCompletionTokensCap: 300, maxOutputSize: 200 })).toBe(300);
    expect(resolveCompletionBudget({ maxOutputSize: 200 })).toBe(200);
    expect(resolveCompletionBudget({})).toBeUndefined();
  });

  it('ignores non-positive caps and sizes', () => {
    expect(resolveCompletionBudget({ maxCompletionTokensCap: 0 })).toBeUndefined();
    expect(resolveCompletionBudget({ maxCompletionTokensCap: -5, maxOutputSize: 200 })).toBeUndefined();
    expect(resolveCompletionBudget({ maxOutputSize: 0 })).toBeUndefined();
    expect(resolveCompletionBudget({ maxOutputSize: -5 })).toBeUndefined();
  });
});

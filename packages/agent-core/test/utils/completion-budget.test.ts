import type { ChatProvider, ModelCapability } from '@moonshot-ai/kosong';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  applyCompletionBudget,
  computeCompletionBudgetCap,
  resolveCompletionBudget,
} from '../../src/utils/completion-budget';

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
    const cap = computeCompletionBudgetCap({
      budget: { fallback: 8192 },
      capability: undefined,
    });
    expect(cap).toBe(8192);
  });

  it('uses an explicit hard cap when context size is unknown', () => {
    const cap = computeCompletionBudgetCap({
      budget: { hardCap: 10, fallback: 8192 },
      capability: makeCapability(0),
    });
    expect(cap).toBe(10);
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

  it('uses the model context window when no hard cap is set', () => {
    const maxCtx = 100000;
    const cap = computeCompletionBudgetCap({
      budget: { fallback: 32000 },
      capability: makeCapability(maxCtx),
    });
    expect(cap).toBe(maxCtx);
  });

  it('uses the explicit hard cap when configured', () => {
    const cap = computeCompletionBudgetCap({
      budget: { hardCap: 32000 },
      capability: makeCapability(10000),
    });
    expect(cap).toBe(32000);
  });

  it('ignores fallback when the model context window is known', () => {
    const cap = computeCompletionBudgetCap({
      budget: { fallback: 32000 },
      capability: makeCapability(10000),
    });
    expect(cap).toBe(10000);
  });

  it('keeps explicit hard cap when smaller than remaining', () => {
    const cap = computeCompletionBudgetCap({
      budget: { hardCap: 1024 },
      capability: makeCapability(100000),
    });
    expect(cap).toBe(1024);
  });
});

describe('applyCompletionBudget', () => {
  let withMaxCompletionTokens: ReturnType<typeof vi.fn>;
  let original: ChatProvider;

  beforeEach(() => {
    const cloneFactory = (n: number): ChatProvider => {
      const clone = { ...original, _maxTokensApplied: n };
      return clone as unknown as ChatProvider;
    };
    withMaxCompletionTokens = vi.fn(cloneFactory);
    original = {
      name: 'mock',
      modelName: 'mock-model',
      thinkingEffort: null,
      generate: vi.fn() as unknown as ChatProvider['generate'],
      withThinking: vi.fn() as unknown as ChatProvider['withThinking'],
      withMaxCompletionTokens: withMaxCompletionTokens as unknown as (
        n: number,
      ) => ChatProvider,
    };
  });

  it('returns the original provider when no budget is configured', () => {
    const result = applyCompletionBudget({
      provider: original,
      budget: undefined,
      capability: makeCapability(10000),
    });
    expect(result).toBe(original);
    expect(withMaxCompletionTokens).not.toHaveBeenCalled();
  });

  it('returns the original provider when withMaxCompletionTokens is not implemented', () => {
    const { withMaxCompletionTokens: _drop, ...rest } = original;
    void _drop;
    const opaque = rest as unknown as ChatProvider;
    const result = applyCompletionBudget({
      provider: opaque,
      budget: { hardCap: 8192 },
      capability: makeCapability(10000),
    });
    expect(result).toBe(opaque);
  });

  it('clones the provider with the model context window when budget is configured', () => {
    const result = applyCompletionBudget({
      provider: original,
      budget: { fallback: 32000 },
      capability: makeCapability(10000),
    });
    expect(withMaxCompletionTokens).toHaveBeenCalledOnce();
    const cap = withMaxCompletionTokens.mock.calls[0]?.[0] as number;
    expect(cap).toBe(10000);
    expect(result).not.toBe(original);
  });

  it('uses the explicit hard cap when configured', () => {
    const result = applyCompletionBudget({
      provider: original,
      budget: { hardCap: 8192 },
      capability: makeCapability(10000),
    });
    expect(withMaxCompletionTokens).toHaveBeenCalledOnce();
    expect(withMaxCompletionTokens.mock.calls[0]?.[0]).toBe(8192);
    expect(result).not.toBe(original);
  });
});

describe('resolveCompletionBudget', () => {
  it('reads KIMI_MODEL_MAX_COMPLETION_TOKENS first', () => {
    const budget = resolveCompletionBudget({
      reservedContextSize: 1000,
      env: {
        KIMI_MODEL_MAX_COMPLETION_TOKENS: '4096',
        KIMI_MODEL_MAX_TOKENS: '2048',
      },
    });
    expect(budget?.hardCap).toBe(4096);
  });

  it('falls back to legacy KIMI_MODEL_MAX_TOKENS when the new var is unset', () => {
    const budget = resolveCompletionBudget({
      reservedContextSize: 1000,
      env: { KIMI_MODEL_MAX_TOKENS: '2048' },
    });
    expect(budget?.hardCap).toBe(2048);
  });

  it('uses reservedContextSize as the unknown-context fallback when no env var is set', () => {
    const budget = resolveCompletionBudget({
      reservedContextSize: 12345,
      env: {},
    });
    expect(budget?.hardCap).toBeUndefined();
    expect(budget?.fallback).toBe(12345);
  });

  it('uses model max output size as the default hard cap when no env var is set', () => {
    const budget = resolveCompletionBudget({
      maxOutputSize: 384000,
      reservedContextSize: 12345,
      env: {},
    });
    expect(budget?.hardCap).toBe(384000);
    expect(budget?.fallback).toBeUndefined();
  });

  it('falls back to 32000 only for unknown context when nothing is configured', () => {
    const budget = resolveCompletionBudget({ env: {} });
    expect(budget?.hardCap).toBeUndefined();
    expect(budget?.fallback).toBe(32000);
  });

  it('ignores reservedContextSize when it is 0', () => {
    const budget = resolveCompletionBudget({
      reservedContextSize: 0,
      env: {},
    });
    expect(budget?.hardCap).toBeUndefined();
    expect(budget?.fallback).toBe(32000);
  });

  it('treats non-positive KIMI_MODEL_MAX_COMPLETION_TOKENS as an opt-out', () => {
    expect(
      resolveCompletionBudget({
        reservedContextSize: 1000,
        env: { KIMI_MODEL_MAX_COMPLETION_TOKENS: '0' },
      }),
    ).toBeUndefined();
    expect(
      resolveCompletionBudget({
        reservedContextSize: 1000,
        env: { KIMI_MODEL_MAX_COMPLETION_TOKENS: '-1' },
      }),
    ).toBeUndefined();
  });

  it('treats non-positive legacy KIMI_MODEL_MAX_TOKENS as an opt-out when the new var is unset', () => {
    expect(
      resolveCompletionBudget({
        reservedContextSize: 1000,
        env: { KIMI_MODEL_MAX_TOKENS: '-1' },
      }),
    ).toBeUndefined();
  });

  it('lets the new var override a legacy disable signal', () => {
    const budget = resolveCompletionBudget({
      env: {
        KIMI_MODEL_MAX_COMPLETION_TOKENS: '4096',
        KIMI_MODEL_MAX_TOKENS: '-1',
      },
    });
    expect(budget?.hardCap).toBe(4096);
  });

  it('falls back to defaults when the env var is non-numeric garbage', () => {
    const budget = resolveCompletionBudget({
      env: { KIMI_MODEL_MAX_COMPLETION_TOKENS: 'not-a-number' },
    });
    expect(budget?.hardCap).toBeUndefined();
    expect(budget?.fallback).toBe(32000);
  });
});

describe('compaction budget resolution', () => {
  // Simulates the budget resolution logic from full.ts compactionRound():
  //   const compactionOutputCap =
  //     maxOutputSize ?? (maxCtx > 0 ? Math.min(Math.floor(maxCtx / 4), 8192) : undefined);
  // This ensures compaction never requests the full context window as
  // max_completion_tokens when maxOutputSize is not explicitly configured.
  function resolveCompactionBudget(args: {
    readonly maxOutputSize?: number;
    readonly maxCtx: number;
    readonly reservedContextSize?: number;
    readonly env?: NodeJS.ProcessEnv;
  }): ReturnType<typeof resolveCompletionBudget> {
    const compactionOutputCap =
      args.maxOutputSize ?? (args.maxCtx > 0 ? Math.min(Math.floor(args.maxCtx / 4), 8192) : undefined);
    return resolveCompletionBudget({
      maxOutputSize: compactionOutputCap,
      reservedContextSize: args.reservedContextSize,
      env: args.env,
    });
  }

  it('uses a conservative fallback cap when maxOutputSize is undefined', () => {
    const budget = resolveCompactionBudget({
      maxCtx: 262_144,
      reservedContextSize: 50_000,
      env: {},
    });
    // 262144 / 4 = 65536, min(65536, 8192) = 8192
    expect(budget?.hardCap).toBe(8192);
  });

  it('caps at 8192 even for very large context windows', () => {
    const budget = resolveCompactionBudget({
      maxCtx: 1_000_000,
      reservedContextSize: 50_000,
      env: {},
    });
    expect(budget?.hardCap).toBe(8192);
  });

  it('uses 1/4 of context when context is small', () => {
    const budget = resolveCompactionBudget({
      maxCtx: 20_000,
      reservedContextSize: 50_000,
      env: {},
    });
    // 20000 / 4 = 5000, min(5000, 8192) = 5000
    expect(budget?.hardCap).toBe(5000);
  });

  it('uses explicit maxOutputSize when configured', () => {
    const budget = resolveCompactionBudget({
      maxOutputSize: 131_072,
      maxCtx: 1_000_000,
      reservedContextSize: 50_000,
      env: {},
    });
    expect(budget?.hardCap).toBe(131_072);
  });

  it('respects KIMI_MODEL_MAX_COMPLETION_TOKENS over the fallback cap', () => {
    const budget = resolveCompactionBudget({
      maxCtx: 262_144,
      reservedContextSize: 50_000,
      env: { KIMI_MODEL_MAX_COMPLETION_TOKENS: '4096' },
    });
    expect(budget?.hardCap).toBe(4096);
  });

  it('produces a hardCap that computeCompletionBudgetCap will use instead of maxCtx', () => {
    const maxCtx = 262_144;
    const budget = resolveCompactionBudget({
      maxCtx,
      reservedContextSize: 50_000,
      env: {},
    });
    // The budget should have a hardCap, not just a fallback
    expect(budget?.hardCap).toBeDefined();
    expect(budget?.hardCap).not.toBe(maxCtx);
    // computeCompletionBudgetCap should use the hardCap, not the context window
    const cap = computeCompletionBudgetCap({
      budget: budget!,
      capability: makeCapability(maxCtx),
    });
    expect(cap).toBe(8192);
    expect(cap).toBeLessThan(maxCtx);
  });
});

import type {
  ChatProvider,
  Message,
  ModelCapability,
  Tool,
} from '@moonshot-ai/kosong';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  applyCompletionBudget,
  computeCompletionBudgetCap,
  resolveCompletionBudget,
} from '../../src/utils/completion-budget';

function makeMessages(approxAsciiTokens: number): Message[] {
  // estimateTokens treats ASCII as ~4 chars/token. Pad with a single
  // string so the message lands near the requested count.
  const charCount = approxAsciiTokens * 4;
  return [
    {
      role: 'user',
      content: [{ type: 'text', text: 'a'.repeat(charCount) }],
      toolCalls: [],
    },
  ];
}

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

function makeTool(name: string, asciiCharsInDescription: number): Tool {
  return {
    name,
    description: 'd'.repeat(asciiCharsInDescription),
    parameters: { type: 'object', properties: {} },
  };
}

describe('computeCompletionBudgetCap', () => {
  it('uses fallback when context size is unknown and no hard cap is set', () => {
    const cap = computeCompletionBudgetCap({
      budget: { fallback: 8192 },
      capability: undefined,
      messages: makeMessages(100),
    });
    expect(cap).toBe(8192);
  });

  it('uses an explicit hard cap when context size is unknown', () => {
    const cap = computeCompletionBudgetCap({
      budget: { hardCap: 10, fallback: 8192 },
      capability: makeCapability(0),
      messages: makeMessages(100),
    });
    expect(cap).toBe(10);
  });

  it('floors at 1 when hard cap is zero or negative', () => {
    expect(
      computeCompletionBudgetCap({
        budget: { hardCap: 0 },
        capability: undefined,
        messages: makeMessages(10),
      }),
    ).toBe(1);
    expect(
      computeCompletionBudgetCap({
        budget: { hardCap: -100 },
        capability: undefined,
        messages: makeMessages(10),
      }),
    ).toBe(1);
  });

  it('uses the remaining context window when no hard cap is set', () => {
    const maxCtx = 100000;
    const cap = computeCompletionBudgetCap({
      budget: { fallback: 32000 },
      capability: makeCapability(maxCtx),
      messages: makeMessages(1000),
    });
    expect(cap).toBe(maxCtx - 1001 - 1024);
  });

  it('clamps explicit hard cap down to the remaining context window', () => {
    // max_context_tokens 10000, input ~ 1000, safetyMargin 1024 → remaining ~ 7976
    const cap = computeCompletionBudgetCap({
      budget: { hardCap: 32000 },
      capability: makeCapability(10000),
      messages: makeMessages(1000),
    });
    expect(cap).toBeLessThanOrEqual(10000 - 1000 - 1024);
    expect(cap).toBeGreaterThan(7000);
  });

  it('returns 1 when input already exceeds context minus margin', () => {
    const cap = computeCompletionBudgetCap({
      budget: { fallback: 32000 },
      capability: makeCapability(10000),
      messages: makeMessages(11000),
    });
    expect(cap).toBe(1);
  });

  it('never exceeds remaining context, even when remaining is below the historical floor', () => {
    // input ~ 8900, safetyMargin 1024 → remaining ~ 75 (positive but below 256).
    // The cap MUST stay <= remaining so the request does not overflow.
    const maxCtx = 10000;
    const cap = computeCompletionBudgetCap({
      budget: { fallback: 32000 },
      capability: makeCapability(maxCtx),
      messages: makeMessages(8900),
    });
    expect(cap).toBeGreaterThanOrEqual(1);
    expect(cap).toBeLessThanOrEqual(maxCtx - 8900 - 1024);
  });

  it('respects custom safetyMargin', () => {
    const cap = computeCompletionBudgetCap({
      budget: { fallback: 32000, safetyMargin: 4096 },
      capability: makeCapability(20000),
      messages: makeMessages(1000),
    });
    // remaining = 20000 - (1000 + 1 for 'user' role) - 4096 = 14903
    expect(cap).toBe(14903);
  });

  it('keeps explicit hard cap when smaller than remaining', () => {
    const cap = computeCompletionBudgetCap({
      budget: { hardCap: 1024 },
      capability: makeCapability(100000),
      messages: makeMessages(1000),
    });
    expect(cap).toBe(1024);
  });

  it('counts the system prompt as input', () => {
    const maxCtx = 10000;
    const safetyMargin = 1024;
    const systemPrompt = 'a'.repeat(2000 * 4); // ~2000 tokens
    const cap = computeCompletionBudgetCap({
      budget: { fallback: 32000, safetyMargin },
      capability: makeCapability(maxCtx),
      messages: makeMessages(1000),
      systemPrompt,
    });
    // remaining = 10000 - (1001 + 2000) - 1024 = 5975
    expect(cap).toBeLessThanOrEqual(maxCtx - 1001 - 2000 - safetyMargin);
    expect(cap).toBeGreaterThan(5500);
  });

  it('counts tool schemas as input', () => {
    const maxCtx = 10000;
    const safetyMargin = 1024;
    const tools: Tool[] = [
      makeTool('tool_a', 4000), // ~1000 tokens of description per tool
      makeTool('tool_b', 4000),
    ];
    const capWithTools = computeCompletionBudgetCap({
      budget: { fallback: 32000, safetyMargin },
      capability: makeCapability(maxCtx),
      messages: makeMessages(1000),
      tools,
    });
    const capWithoutTools = computeCompletionBudgetCap({
      budget: { fallback: 32000, safetyMargin },
      capability: makeCapability(maxCtx),
      messages: makeMessages(1000),
    });
    expect(capWithTools).toBeLessThan(capWithoutTools);
    // Tool descriptions add ~2000 tokens, so cap should drop by roughly that.
    expect(capWithoutTools - capWithTools).toBeGreaterThan(1500);
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
      messages: makeMessages(100),
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
      messages: makeMessages(100),
    });
    expect(result).toBe(opaque);
  });

  it('clones the provider with the clamped cap when budget is configured', () => {
    const result = applyCompletionBudget({
      provider: original,
      budget: { fallback: 32000 },
      capability: makeCapability(10000),
      messages: makeMessages(1000),
    });
    expect(withMaxCompletionTokens).toHaveBeenCalledOnce();
    const cap = withMaxCompletionTokens.mock.calls[0]?.[0] as number;
    expect(cap).toBeLessThanOrEqual(10000 - 1000 - 1024);
    expect(cap).toBeGreaterThan(7000);
    expect(result).not.toBe(original);
  });

  it('forwards systemPrompt and tools to the cap computation', () => {
    const tools: Tool[] = [makeTool('tool_a', 4000)];
    const systemPrompt = 'a'.repeat(4000); // ~1000 tokens
    applyCompletionBudget({
      provider: original,
      budget: { fallback: 32000 },
      capability: makeCapability(10000),
      messages: makeMessages(1000),
      systemPrompt,
      tools,
    });
    const capWithExtras = withMaxCompletionTokens.mock.calls[0]?.[0] as number;
    withMaxCompletionTokens.mockClear();
    applyCompletionBudget({
      provider: original,
      budget: { fallback: 32000 },
      capability: makeCapability(10000),
      messages: makeMessages(1000),
    });
    const capBare = withMaxCompletionTokens.mock.calls[0]?.[0] as number;
    expect(capWithExtras).toBeLessThan(capBare);
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

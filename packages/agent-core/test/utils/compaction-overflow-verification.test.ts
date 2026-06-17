import { describe, expect, it } from 'vitest';

import {
  applyCompletionBudget,
  computeCompletionBudgetCap,
  resolveCompletionBudget,
} from '../../src/utils/completion-budget';

import type { ChatProvider, ModelCapability } from '@moonshot-ai/kosong';

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

function makeMockProvider(): { provider: ChatProvider; getCap: () => number | null } {
  let cap: number | null = null;
  const provider = {
    name: 'mock',
    modelName: 'mock-model',
    thinkingEffort: null,
    generate: (() => {}) as unknown as ChatProvider['generate'],
    withThinking: (() => {}) as unknown as ChatProvider['withThinking'],
    withMaxCompletionTokens: ((n: number) => {
      cap = n;
      return { ...provider, _cap: n } as unknown as ChatProvider;
    }) as unknown as (n: number) => ChatProvider,
  } as ChatProvider;
  return { provider, getCap: () => cap };
}

/**
 * Simulates the ORIGINAL compactionRound() budget logic (before fix):
 * does NOT pass maxOutputSize to resolveCompletionBudget.
 */
function originalCompactionMaxTokens(args: {
  maxOutputSize?: number;
  maxCtx: number;
  reservedContextSize?: number;
}): number {
  const { provider, getCap } = makeMockProvider();
  applyCompletionBudget({
    provider,
    budget: resolveCompletionBudget({
      // maxOutputSize intentionally omitted — this is the bug
      reservedContextSize: args.reservedContextSize,
    }),
    capability: makeCapability(args.maxCtx),
  });
  return getCap() ?? 0;
}

/**
 * Simulates the PATCHED compactionRound() budget logic (after fix):
 * passes maxOutputSize or a conservative fallback cap.
 */
function patchedCompactionMaxTokens(args: {
  maxOutputSize?: number;
  maxCtx: number;
  reservedContextSize?: number;
}): number {
  const compactionOutputCap =
    args.maxOutputSize ?? (args.maxCtx > 0 ? Math.min(Math.floor(args.maxCtx / 4), 8192) : undefined);
  const { provider, getCap } = makeMockProvider();
  applyCompletionBudget({
    provider,
    budget: resolveCompletionBudget({
      maxOutputSize: compactionOutputCap,
      reservedContextSize: args.reservedContextSize,
    }),
    capability: makeCapability(args.maxCtx),
  });
  return getCap() ?? 0;
}

describe('compaction overflow verification (before vs after fix)', () => {
  // Simulated compaction input size: a typical compaction prompt contains
  // the entire conversation history being compacted.
  const COMPACTION_INPUT_TOKENS = 80_000;

  const testModels = [
    {
      name: 'stepfun/step-3.7-flash (maxOutputSize not configured)',
      maxOutputSize: undefined,
      maxCtx: 256_000,
      reservedContextSize: 50_000,
    },
    {
      name: 'kimi-for-coding (maxOutputSize not configured)',
      maxOutputSize: undefined,
      maxCtx: 262_144,
      reservedContextSize: 50_000,
    },
    {
      name: 'zhipu/glm-5.2 (maxOutputSize=131072)',
      maxOutputSize: 131_072,
      maxCtx: 1_000_000,
      reservedContextSize: 50_000,
    },
  ];

  for (const model of testModels) {
    it(`${model.name}: original overflows, patched is safe`, () => {
      const origCap = originalCompactionMaxTokens(model);
      const patchedCap = patchedCompactionMaxTokens(model);
      const origTotal = COMPACTION_INPUT_TOKENS + origCap;
      const patchedTotal = COMPACTION_INPUT_TOKENS + patchedCap;

      // --- Original code ---
      // The original compaction code does NOT pass maxOutputSize to
      // resolveCompletionBudget, so it always falls back to using the full
      // context window as max_completion_tokens — regardless of whether
      // maxOutputSize is configured. This is the core bug.
      expect(origCap).toBe(model.maxCtx); // bug: always uses full context as max_tokens
      expect(origTotal).toBeGreaterThan(model.maxCtx); // overflow!

      // --- Patched code ---
      // The patched code always uses a safe cap (either maxOutputSize or min(maxCtx/4, 8192))
      expect(patchedTotal).toBeLessThanOrEqual(model.maxCtx);
      expect(patchedCap).toBeLessThan(model.maxCtx);

      // Print a comparison table for manual verification
      console.log(`
  ${model.name}
    max_context_tokens:    ${model.maxCtx.toLocaleString()}
    maxOutputSize:         ${model.maxOutputSize?.toLocaleString() ?? 'undefined'}
    compaction input est:  ${COMPACTION_INPUT_TOKENS.toLocaleString()}

    Original:  max_tokens=${origCap.toLocaleString()}  total=${origTotal.toLocaleString()}  overflow=${origTotal > model.maxCtx ? 'YES ❌' : 'NO'}
    Patched:   max_tokens=${patchedCap.toLocaleString()}  total=${patchedTotal.toLocaleString()}  overflow=${patchedTotal > model.maxCtx ? 'YES ❌' : 'NO ✅'}
`);
    });
  }
});

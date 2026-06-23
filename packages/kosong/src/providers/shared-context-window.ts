import { estimatePromptTokens } from '#/token-estimate';
import type { Message } from '#/message';
import type { Tool } from '#/tool';

import { usesMaxCompletionTokensOnWire } from './kimi-reasoning';
import type { OpenAILegacyGenerationKwargs } from './openai-legacy';

const DEFAULT_SERIALIZATION_MARGIN = 512;
const MIN_COMPLETION_TOKENS = 1;

function completionTokenField(model: string): 'max_completion_tokens' | 'max_tokens' {
  return usesMaxCompletionTokensOnWire(model) ? 'max_completion_tokens' : 'max_tokens';
}

/**
 * Clamp completion budget for providers where input and output share one
 * context window (e.g. Microsoft Foundry Kimi deployments).
 *
 * Kimi reasoning models use `max_completion_tokens` for visible output; reasoning
 * tokens are billed separately within the shared window. Do not apply a separate
 * reasoning output cap — that defeats the purpose of the split field.
 */
export function clampCompletionTokensForSharedContextWindow(args: {
  readonly model: string;
  readonly sharedContextWindowTokens: number;
  readonly generationKwargs: OpenAILegacyGenerationKwargs;
  readonly systemPrompt: string;
  readonly history: readonly Message[];
  readonly tools: readonly Tool[];
  readonly serializationMargin?: number;
}): OpenAILegacyGenerationKwargs {
  const margin = args.serializationMargin ?? DEFAULT_SERIALIZATION_MARGIN;
  const inputEstimate = estimatePromptTokens({
    systemPrompt: args.systemPrompt,
    history: args.history,
    tools: args.tools,
  });
  const remaining = Math.max(
    MIN_COMPLETION_TOKENS,
    args.sharedContextWindowTokens - inputEstimate - margin,
  );

  const field = completionTokenField(args.model);
  const kwargs = { ...args.generationKwargs };
  const requested = kwargs[field];
  kwargs[field] = requested === undefined ? remaining : Math.min(requested, remaining);
  // Drop legacy alias when the wire field is max_completion_tokens.
  if (field === 'max_completion_tokens') {
    // eslint-disable-next-line @typescript-eslint/no-dynamic-delete
    delete kwargs.max_tokens;
  }
  return kwargs;
}

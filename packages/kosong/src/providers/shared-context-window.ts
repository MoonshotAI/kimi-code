import { estimatePromptTokens } from '#/token-estimate';
import type { Message } from '#/message';
import type { Tool } from '#/tool';

import type { OpenAILegacyGenerationKwargs } from './openai-legacy';

const DEFAULT_SERIALIZATION_MARGIN = 512;
const MIN_COMPLETION_TOKENS = 1;

function completionTokenField(model: string): 'max_completion_tokens' | 'max_tokens' {
  const normalized = model.toLowerCase();
  if (/^o\d(?:$|[-.])/.test(normalized) || /^gpt-5(?:$|[-.])/.test(normalized)) {
    return 'max_completion_tokens';
  }
  return 'max_tokens';
}

/**
 * Clamp completion budget for providers where input and output share one
 * context window (e.g. Microsoft Foundry Kimi deployments).
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
  return kwargs;
}

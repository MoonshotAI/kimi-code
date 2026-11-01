import type { OpenAIOptions } from '#/llm/builtin/protocol/openai/index';
import type { LlmRequester as CoreLlmRequester } from '#/llm/requester';
import { modelKey } from '#/llm-requester/model';

import type { LlmRequester } from './requester';
import { createRunRequester, type RunRequesterOptions } from './run';

export function createOpenAIRunRequester(
  base: CoreLlmRequester<'protocol'>,
  options?: RunRequesterOptions<unknown>,
): LlmRequester {
  const detectedByModel = new Map<string, string>();
  return createRunRequester(base, {
    ...options,
    options: (config, model): OpenAIOptions => {
      const resolved = options?.options?.(config, model) as OpenAIOptions | undefined;
      if (resolved?.reasoningKey !== undefined) return resolved;
      const key = modelKey(model);
      return {
        ...resolved,
        detectedReasoningKey: detectedByModel.get(key),
        onReasoningKey: (reasoningKey) => {
          if (!detectedByModel.has(key)) {
            detectedByModel.set(key, reasoningKey);
          }
        },
      };
    },
  });
}

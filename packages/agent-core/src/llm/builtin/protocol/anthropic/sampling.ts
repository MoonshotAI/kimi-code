import { shake } from 'radashi';

import type { LlmSampling } from '#/llm/requester/requester';

export function encodeAnthropicSampling(
  sampling: LlmSampling | undefined,
): Record<string, unknown> {
  if (sampling === undefined) return {};
  return shake({
    temperature: sampling.temperature,
    top_p: sampling.topP,
    top_k: sampling.topK,
    stop_sequences: sampling.stop,
  });
}

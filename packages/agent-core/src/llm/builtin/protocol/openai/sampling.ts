import { shake } from 'radashi';

import type { LlmSampling } from '#/llm/requester/requester';

export function encodeOpenAISampling(
  sampling: LlmSampling | undefined,
): Record<string, unknown> {
  if (sampling === undefined) return {};
  return shake({
    temperature: sampling.temperature,
    top_p: sampling.topP,
    top_k: sampling.topK,
    stop: sampling.stop,
    seed: sampling.seed,
    presence_penalty: sampling.presencePenalty,
    frequency_penalty: sampling.frequencyPenalty,
  });
}

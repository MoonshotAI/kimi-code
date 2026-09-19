import { shake } from 'radashi';

import type { LlmSampling } from '#/llm/requester/requester';

export function encodeGoogleGenAISampling(
  sampling: LlmSampling | undefined,
): Record<string, unknown> {
  if (sampling === undefined) return {};
  return shake({
    temperature: sampling.temperature,
    topP: sampling.topP,
    topK: sampling.topK,
    stopSequences: sampling.stop,
    seed: sampling.seed,
    presencePenalty: sampling.presencePenalty,
    frequencyPenalty: sampling.frequencyPenalty,
  });
}

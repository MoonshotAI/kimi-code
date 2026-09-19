import { shake } from 'radashi';

import type { LlmSampling } from '#/llm/requester/requester';

export function encodeOpenAIResponsesSampling(
  sampling: LlmSampling | undefined,
): Record<string, unknown> {
  if (sampling === undefined) return {};
  return shake({
    temperature: sampling.temperature,
    top_p: sampling.topP,
  });
}

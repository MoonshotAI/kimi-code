import { googleGenAIProtocol } from '#/llm/builtin/protocol/google-genai/index';
import { createRequester } from '#/llm/requester';

export const googleGenAIRequester = createRequester().with({
  protocol: { base: googleGenAIProtocol },
});

export const googleVertexRequester = createRequester().with({
  protocol: { base: googleGenAIProtocol, options: { vertexai: true } },
});

import { openAIResponsesProtocol } from '#/llm/builtin/protocol/openai-responses/index';
import { openAIProtocol } from '#/llm/builtin/protocol/openai/index';
import { createRequester } from '#/llm/requester';

export const openAIRequester = createRequester().with({
  protocol: { base: openAIProtocol },
});

export const openAIResponsesRequester = createRequester().with({
  protocol: { base: openAIResponsesProtocol },
});

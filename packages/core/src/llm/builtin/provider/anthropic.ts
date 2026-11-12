/**
 * Requester preset for the Anthropic Messages protocol.
 */
import { anthropicProtocol } from '#/llm/builtin/protocol/anthropic/index';
import { createRequester } from '#/llm/requester';

export const anthropicRequester = createRequester().with({
  protocol: { base: anthropicProtocol },
});

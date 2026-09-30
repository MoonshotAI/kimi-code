import {
  kimiAnthropicRequester,
  kimiRequester,
  kimiResponsesRequester,
  type CatalogProviderHandle,
  type LlmRequester,
} from '@moonshot-ai/agent-core';

export function kimiProtocolBindings(): Record<string, LlmRequester<'protocol'>> {
  return {
    openai: kimiRequester,
    anthropic: kimiAnthropicRequester,
    openai_responses: kimiResponsesRequester,
  };
}

export const kimiProvider: CatalogProviderHandle = {
  id: 'kimi',
  requester: kimiProtocolBindings(),
};

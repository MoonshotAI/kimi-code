import {
  kimiAnthropicRequester,
  kimiRequester,
  kimiResponsesRequester,
} from '@moonshot-ai/agent-core/llm/builtin/provider/index';
import type { CatalogProviderHandle } from '@moonshot-ai/agent-core/llm/catalog/index';
import type { LlmRequester } from '@moonshot-ai/agent-core/llm/requester';

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

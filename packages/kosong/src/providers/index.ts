import type { ChatProvider } from '../provider';
import { AnthropicChatProvider, type AnthropicOptions } from './anthropic';
import { GoogleGenAIChatProvider, type GoogleGenAIOptions } from './google-genai';
import { KimiChatProvider, type KimiOptions } from './kimi';
import { OpenAILegacyChatProvider, type OpenAILegacyOptions } from './openai-legacy';
import { OpenAIResponsesChatProvider, type OpenAIResponsesOptions } from './openai-responses';

export type ProviderConfig =
  | ({ type: 'anthropic' } & AnthropicOptions)
  | ({ type: 'openai' } & OpenAILegacyOptions)
  | ({ type: 'kimi' } & KimiOptions)
  | ({ type: 'google-genai' } & GoogleGenAIOptions)
  | ({ type: 'openai_responses' } & OpenAIResponsesOptions)
  | ({ type: 'vertexai' } & GoogleGenAIOptions);

export type ProviderType = ProviderConfig['type'];

export function createProvider(config: ProviderConfig): ChatProvider {
  switch (config.type) {
    case 'anthropic':
      return new AnthropicChatProvider(config);
    case 'openai':
      return new OpenAILegacyChatProvider(config);
    case 'kimi':
      return new KimiChatProvider(config);
    case 'google-genai':
      return new GoogleGenAIChatProvider(config);
    case 'openai_responses':
      return new OpenAIResponsesChatProvider(config);
    case 'vertexai':
      return new GoogleGenAIChatProvider(config);
    default: {
      const exhaustive: never = config;
      throw new Error(`Unknown provider type: ${String(exhaustive)}`);
    }
  }
}

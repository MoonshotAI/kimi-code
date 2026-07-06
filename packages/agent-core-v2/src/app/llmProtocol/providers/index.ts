import { UNKNOWN_CAPABILITY, type ModelCapability } from '../capability';
import type { ChatProvider } from '../provider';
import { AnthropicChatProvider, type AnthropicOptions } from './anthropic';
import {
  getAnthropicModelCapability,
  getGoogleGenAIModelCapability,
  getOpenAILegacyModelCapability,
  getOpenAIResponsesModelCapability,
} from './capability-registry';
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

/**
 * Look up the declared {@link ModelCapability} for a `(wire, model)` pair.
 *
 * This is a pure static table lookup — it does not instantiate a provider.
 * Unknown / uncatalogued models (and the Kimi wire, whose capabilities come
 * from the host's catalog/config rather than the model name) return
 * {@link UNKNOWN_CAPABILITY} so capability checks stay non-fatal.
 */
export function getModelCapability(wire: ProviderType, modelName: string): ModelCapability {
  switch (wire) {
    case 'anthropic':
      return getAnthropicModelCapability(modelName);
    case 'openai':
      return getOpenAILegacyModelCapability(modelName);
    case 'openai_responses':
      return getOpenAIResponsesModelCapability(modelName);
    case 'google-genai':
    case 'vertexai':
      return getGoogleGenAIModelCapability(modelName);
    case 'kimi':
      return UNKNOWN_CAPABILITY;
    default: {
      const exhaustive: never = wire;
      void exhaustive;
      return UNKNOWN_CAPABILITY;
    }
  }
}

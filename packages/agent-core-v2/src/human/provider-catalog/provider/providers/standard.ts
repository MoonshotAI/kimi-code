import {
  anthropicRequester,
  googleGenAIRequester,
  googleVertexRequester,
  openAIRequester,
  openAIResponsesRequester,
} from '#/llm/builtin/provider/index';
import type { LlmRequester as CoreLlmRequester } from '#/llm/requester';
import type { ProtocolName } from '#/llm-requester/requester';
import { createLlmHeadersTimeoutFetch } from '#/llm-requester/timeout';

import type { CatalogModelDefinition, CatalogProviderHandle } from '../../catalog';

function withEnvironment(
  base: CoreLlmRequester<'protocol'>,
  apiKeyEnv: string,
  baseUrlEnv: string,
  fetchFn?: typeof fetch,
): CoreLlmRequester<'protocol'> {
  return base.with({
    endpoint: {
      baseUrl: process.env[baseUrlEnv],
      credentials: {
        resolve: () => {
          const apiKey = process.env[apiKeyEnv];
          return apiKey === undefined || apiKey.length === 0 ? undefined : { apiKey };
        },
      },
      fetch: fetchFn,
    },
  });
}

export const openaiProvider: CatalogProviderHandle = {
  id: 'openai',
  requester: (protocol?: ProtocolName) => {
    const base =
      protocol === undefined || protocol === 'openai'
        ? openAIRequester
        : protocol === 'openai_responses'
          ? openAIResponsesRequester
          : undefined;
    return base === undefined
      ? undefined
      : withEnvironment(
          base,
          'OPENAI_API_KEY',
          'OPENAI_BASE_URL',
          createLlmHeadersTimeoutFetch(),
        );
  },
  listModels: async () => [],
};

export const anthropicProvider: CatalogProviderHandle = {
  id: 'anthropic',
  requester: (protocol?: ProtocolName) =>
    protocol === undefined || protocol === 'anthropic'
      ? withEnvironment(
          anthropicRequester,
          'ANTHROPIC_API_KEY',
          'ANTHROPIC_BASE_URL',
          createLlmHeadersTimeoutFetch(),
        )
      : undefined,
  listModels: async () => [],
};

export const googleProvider: CatalogProviderHandle = {
  id: 'google',
  requester: (protocol?: ProtocolName, model?: CatalogModelDefinition) => {
    if (protocol !== undefined && protocol !== 'google-genai') return undefined;
    return model?.vertexai === true
      ? withEnvironment(googleVertexRequester, 'VERTEXAI_API_KEY', 'GOOGLE_VERTEX_BASE_URL')
      : withEnvironment(googleGenAIRequester, 'GOOGLE_API_KEY', 'GOOGLE_GEMINI_BASE_URL');
  },
  listModels: async () => [],
  media: { inlineVideo: true },
};

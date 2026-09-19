import {
  anthropicBetaBase,
  createOAuthCredentialProvider,
  createProvider,
  openAIBase,
  openAIResponsesBase,
  type AccessTokenResolver,
  type LlmCredentialProvider,
  type Provider,
} from '@moonshot-ai/agent-core';

import { classifyKimiQuotaError } from './errors';
import { kimiMediaContribution } from './media';
import { kimiAnthropicTrait, kimiConnection, kimiOpenAITrait } from './trait';

export function createKimiProvider(): Provider {
  return createProvider({
    id: 'kimi',
    protocols: {
      openai: {
        base: openAIBase,
        trait: kimiOpenAITrait,
        connection: kimiConnection,
        classifyError: classifyKimiQuotaError,
      },
      anthropic: {
        base: anthropicBetaBase,
        trait: kimiAnthropicTrait,
        connection: kimiConnection,
        classifyError: classifyKimiQuotaError,
      },
      openai_responses: {
        base: openAIResponsesBase,
        connection: kimiConnection,
        classifyError: classifyKimiQuotaError,
      },
    },
    media: kimiMediaContribution,
  });
}

export const kimiProvider = createKimiProvider();

export function createKimiOAuthCredentialProvider(
  getToken: AccessTokenResolver,
): LlmCredentialProvider {
  return createOAuthCredentialProvider(getToken);
}

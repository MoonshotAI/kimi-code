import type OpenAI from 'openai';

import type { ProtocolBase } from '#/llm/protocol/base';
import type { ProviderConnection } from '#/llm/protocol/connection';
import type {
  LlmClientContext,
  LlmErrorClassifier,
  LlmRequester,
} from '#/llm/requester/requester';

import { createRunRequester } from '#/llm/requester/run';
import { getOpenAILegacyModelCapability } from './capability';
import { openAIProtocol } from './protocol';

export interface OpenAIRequesterOptions {
  readonly connection?: ProviderConnection;
  readonly classifyError?: LlmErrorClassifier;
  readonly clientFactory?: (request: LlmClientContext) => OpenAI;
  readonly reasoningKey?: string;
}

export function createOpenAIRequester(options?: OpenAIRequesterOptions): LlmRequester {
  return createRunRequester(openAIProtocol, {
    connection: options?.connection,
    classifyError: options?.classifyError,
    clientFactory: options?.clientFactory,
    options: (config) => ({
      extras: config.extraParams?.openai,
      reasoningKey: options?.reasoningKey,
      toolMessageConversion: config.toolMessageConversion,
    }),
  });
}

export const openAIBase: ProtocolBase = {
  capability: getOpenAILegacyModelCapability,
  createRequester: createOpenAIRequester,
};

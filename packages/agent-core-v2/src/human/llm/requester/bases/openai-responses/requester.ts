import type OpenAI from 'openai';

import type { ProtocolBase } from '#/llm/protocol/base';
import type { ProviderConnection } from '#/llm/protocol/connection';
import type {
  LlmClientContext,
  LlmErrorClassifier,
  LlmRequester,
} from '#/llm/requester/requester';
import { createRunRequester } from '#/llm/requester/run';

import { getOpenAIResponsesModelCapability } from './capability';
import { openAIResponsesProtocol } from './protocol';

export interface OpenAIResponsesRequesterOptions {
  readonly connection?: ProviderConnection;
  readonly classifyError?: LlmErrorClassifier;
  readonly clientFactory?: (request: LlmClientContext) => OpenAI;
}

export function createOpenAIResponsesRequester(
  options?: OpenAIResponsesRequesterOptions,
): LlmRequester {
  return createRunRequester(openAIResponsesProtocol, {
    connection: options?.connection,
    classifyError: options?.classifyError,
    clientFactory: options?.clientFactory,
    options: (config) => ({
      extras: config.extraParams?.responses,
      toolMessageConversion: config.toolMessageConversion,
    }),
  });
}

export const openAIResponsesBase: ProtocolBase = {
  capability: getOpenAIResponsesModelCapability,
  createRequester: createOpenAIResponsesRequester,
};

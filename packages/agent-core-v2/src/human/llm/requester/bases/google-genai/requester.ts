import type { GoogleGenAI as GenAIClient } from '@google/genai';

import type { ProtocolBase } from '#/llm/protocol/base';
import type { ProviderConnection } from '#/llm/protocol/connection';
import type {
  LlmClientContext,
  LlmErrorClassifier,
  LlmRequester,
} from '#/llm/requester/requester';
import { createRunRequester } from '#/llm/requester/run';

import { getGoogleGenAIModelCapability } from './capability';
import { googleGenAIProtocol } from './protocol';

export interface GoogleGenAIRequesterOptions {
  readonly connection?: ProviderConnection;
  readonly classifyError?: LlmErrorClassifier;
  readonly clientFactory?: (request: LlmClientContext) => GenAIClient;
  readonly vertexai?: boolean;
}

export function createGoogleGenAIRequester(options?: GoogleGenAIRequesterOptions): LlmRequester {
  return createRunRequester(googleGenAIProtocol, {
    connection: options?.connection,
    classifyError: options?.classifyError,
    clientFactory: options?.clientFactory,
    options: (config) => ({
      vertexai: options?.vertexai === true || config.model.vertexai === true ? true : undefined,
      extras: config.extraParams?.googleGenai,
    }),
  });
}

export function createGoogleGenAIBase(
  options?: Pick<GoogleGenAIRequesterOptions, 'clientFactory' | 'vertexai'>,
): ProtocolBase {
  return {
    capability: getGoogleGenAIModelCapability,
    createRequester: (requesterOptions) =>
      createGoogleGenAIRequester({ ...options, ...requesterOptions }),
  };
}

export const googleGenAIBase: ProtocolBase = createGoogleGenAIBase();

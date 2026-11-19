import { createDecorator } from '#/_base/di/instantiation';
import type { Message } from '@moonshot-ai/core/llm/message';
import type { Model } from '#/provider-catalog/model/catalog';
import type { InitializedLlmRequester } from '@moonshot-ai/core/llm/requester';

export interface IAgentMediaResolverService {
  readonly _serviceBrand: undefined;

  resolve(
    messages: readonly Message[],
    model: Model,
    requester: InitializedLlmRequester,
    signal?: AbortSignal,
  ): Promise<readonly Message[]>;
  recoverFailedUploads(
    messages: readonly Message[],
    requester: InitializedLlmRequester,
    signal?: AbortSignal,
  ): Promise<boolean>;
}

export const IAgentMediaResolverService = createDecorator<IAgentMediaResolverService>(
  'agentVideoResolverService',
);

import { createDecorator } from '#/_base/di/instantiation';
import type { Message } from '@moonshot-ai/core/llm/message';
import type { Model } from '#/llm-adapter/model/catalog';
import type { InitializedLlmRequester } from '@moonshot-ai/core/llm/requester';

export interface IAgentMediaResolverService {
  readonly _serviceBrand: undefined;

  resolve(
    messages: readonly Message[],
    model: Model,
    requester: InitializedLlmRequester,
    signal?: AbortSignal,
  ): Promise<readonly Message[]>;
  displayPaths(messages: readonly Message[]): Promise<ReadonlyMap<string, string>>;
}

export const IAgentMediaResolverService = createDecorator<IAgentMediaResolverService>(
  'agentVideoResolverService',
);

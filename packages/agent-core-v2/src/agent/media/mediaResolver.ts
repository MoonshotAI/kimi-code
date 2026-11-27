import { createDecorator } from '#/_base/di/instantiation';
import type { Message } from '@moonshot-ai/core/llm/message';
import type { LlmRequest } from '@moonshot-ai/core/llm/request';

export interface IAgentMediaResolverService {
  readonly _serviceBrand: undefined;

  resolve(
    messages: readonly Message[],
    request: LlmRequest,
    signal?: AbortSignal,
  ): Promise<readonly Message[]>;
  recoverFailedUploads(
    messages: readonly Message[],
    request: LlmRequest,
    signal?: AbortSignal,
  ): Promise<boolean>;
}

export const IAgentMediaResolverService = createDecorator<IAgentMediaResolverService>(
  'agentVideoResolverService',
);

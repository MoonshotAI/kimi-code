import { createDecorator, type ServiceIdentifier } from '#/_base/di/instantiation';
import type { AssistantMessage, Message } from '#human/llm/message';
import type { ResponseFormat } from '#human/llm-requester/response-format';
import type { TokenUsage } from '#human/llm-requester/usage';

import type { SamplingOptions } from './generate';

export interface ModelRequest {
  readonly modelAlias: string;
  readonly systemPrompt: string;
  readonly messages: readonly Message[];
  readonly responseFormat?: ResponseFormat;
  readonly sampling?: SamplingOptions;
  readonly cacheKey?: string;
  readonly maxAttempts?: number;
}

export interface ModelResponse {
  readonly message: AssistantMessage;
  readonly usage?: TokenUsage;
  readonly requestId?: string;
}

export interface IModelRequester {
  readonly _serviceBrand: undefined;

  request(request: ModelRequest, signal: AbortSignal): Promise<ModelResponse>;
}

export const IModelRequester: ServiceIdentifier<IModelRequester> =
  createDecorator<IModelRequester>('modelRequester');

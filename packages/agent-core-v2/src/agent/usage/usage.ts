import type { LLMRequestSource } from '#/agent/llmRequester/llmRequester';
import type { TokenUsage } from '#/app/llmProtocol';

import { createDecorator } from '#/_base/di';

export interface UsageStatus {
  readonly byModel?: Record<string, TokenUsage>;
  readonly total?: TokenUsage;
  readonly currentTurn?: TokenUsage;
}

export interface IAgentUsageService {
  readonly _serviceBrand: undefined;

  record(model: string, usage: TokenUsage, source?: LLMRequestSource): void;
  status(): UsageStatus;
}

export const IAgentUsageService = createDecorator<IAgentUsageService>('agentUsageService');

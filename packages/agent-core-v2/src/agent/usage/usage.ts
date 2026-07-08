import type { LLMRequestSource } from '#/agent/llmRequester/llmRequester';
import type { TokenUsage } from '#/app/llmProtocol/usage';

import { createDecorator } from '#/_base/di/instantiation';
import type { ErrorCode } from '#/_base/errors/codes';
import { KimiError } from '#/_base/errors/errors';

import { UsageErrors } from './errors';

export { UsageErrors } from './errors';

export type UsageErrorCode = (typeof UsageErrors.codes)[keyof typeof UsageErrors.codes];

export class UsageError extends KimiError {
  constructor(code: UsageErrorCode, message: string, details?: Record<string, unknown>) {
    super(code as ErrorCode, message, { details });
    this.name = 'UsageError';
  }
}

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

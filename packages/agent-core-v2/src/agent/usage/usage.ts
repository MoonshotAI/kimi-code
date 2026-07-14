/**
 * `usage` domain (L3) — per-agent token usage accounting contract.
 *
 * Exposes accumulated status, live usage recording, and an `onDidRecord` event
 * for agent-scoped consumers that react to newly recorded usage. Bound at Agent
 * scope.
 */

import type { LLMRequestSource } from '#/agent/llmRequester/llmRequester';
import type { TokenUsage } from '#/app/llmProtocol/usage';

import { createDecorator } from '#/_base/di/instantiation';
import type { Event } from '#/_base/event';
import type { ErrorCode } from '#/_base/errors/codes';
import { Error2 } from '#/_base/errors/errors';

import { UsageErrors } from './errors';

export { UsageErrors } from './errors';

export type UsageErrorCode = (typeof UsageErrors.codes)[keyof typeof UsageErrors.codes];

export class UsageError extends Error2 {
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

export interface UsageRecordedContext {
  readonly model: string;
  readonly usage: Readonly<TokenUsage>;
  readonly source?: LLMRequestSource;
}

export interface IAgentUsageService {
  readonly _serviceBrand: undefined;

  record(model: string, usage: TokenUsage, source?: LLMRequestSource): void;
  status(): UsageStatus;

  readonly onDidRecord: Event<UsageRecordedContext>;
}

export const IAgentUsageService = createDecorator<IAgentUsageService>('agentUsageService');

import type { AgentContext } from '#/agent/agentContext/agentContext';
import type { AgentLLMRequestSource } from '#/agent/loop/requesterContract';
import type { TokenUsage } from '#human/llm-requester/usage';

import { type ErrorCode } from '#/errors';
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
  readonly agent: AgentContext;
  readonly model: string;
  readonly usage: Readonly<TokenUsage>;
  readonly usageReported: boolean;
  readonly source?: AgentLLMRequestSource;
  readonly firstRecord: boolean;
}

import { createDecorator } from '#/_base/di/instantiation';
import type { Event } from '#/_base/event';
import type { AgentContext } from '#/agent/agentContext/agentContext';
import type { AgentLLMRequestSource } from '#/agent/llmRequester/llmRequester';
import type { UsageRecordedContext, UsageStatus } from '#/agent/usage/usage';
import type { TokenUsage } from '#/kosong/contract/usage';

export interface ISessionUsageService {
  readonly _serviceBrand: undefined;

  record(
    agent: AgentContext,
    model: string,
    usage: TokenUsage,
    source?: AgentLLMRequestSource,
  ): Promise<void>;
  status(agent: AgentContext): UsageStatus;

  readonly onDidRecord: Event<UsageRecordedContext>;
}

export const ISessionUsageService = createDecorator<ISessionUsageService>('sessionUsageService');

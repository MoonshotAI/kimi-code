import type { AgentContext } from '#/agent/agentContext/agentContext';
import type { AgentLLMRequestSource } from '#/actor/llmRequester/llmRequester';
import type { TokenUsage } from '#/kosong/contract/usage';

export interface UsageStatus {
  readonly byModel?: Record<string, TokenUsage>;
  readonly total?: TokenUsage;
  readonly currentTurn?: TokenUsage;
}

export interface UsageRecordedContext {
  readonly agent: AgentContext;
  readonly model: string;
  readonly usage: Readonly<TokenUsage>;
  readonly source?: AgentLLMRequestSource;
  readonly firstRecord: boolean;
}

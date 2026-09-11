import { createDecorator } from '#/_base/di/instantiation';
import type { IDisposable } from '#/_base/di/lifecycle';
import type { FinishReason } from '#human/llm/finish-reason';
import type { LlmCredentialProvider } from '#human/llm/requester/requester';
import type { ThinkingEffort } from '#human/llm/thinking';
import type { Message } from '#/llm-adapter/contract/message';
import type { StreamedMessagePart, ToolDescription as Tool } from '#human/llm/message';
import type { TokenUsage } from '#human/llm/usage';
import type { LLMRequestTrace } from '#/llm-adapter/contract/request-trace';
import type { ModelRequestTiming } from '#/llm-adapter/model/model-requester';
import type { LogContext } from '#/_base/log/log';

export type AgentLLMRequestLogFields = Readonly<LogContext>;

export type AgentLLMRequestSource =
  | {
      readonly type: 'turn';
      readonly turnId: number;
      readonly step?: number;
      readonly logFields?: AgentLLMRequestLogFields;
    }
  | {
      readonly type: 'operation';
      readonly turnId?: number;
      readonly requestKind?: string;
      readonly logFields?: AgentLLMRequestLogFields;
    };

export interface LLMRequestRetryContext {
  readonly failedAttempt: number;
  readonly nextAttempt: number;
  readonly maxAttempts: number;
  readonly delayMs: number;
  readonly errorName: string;
  readonly errorMessage: string;
  readonly statusCode?: number;
}

export type LLMRequestRetryHandler = (
  context: LLMRequestRetryContext,
) => void | Promise<void>;

export interface LLMRequestRetryOptions {
  readonly maxAttempts?: number;
  readonly onRetry?: LLMRequestRetryHandler;
}

export type LLMStreamTiming = ModelRequestTiming;

export interface LLMRequestParams {
  messages: Message[];
  tools: readonly Tool[];
  signal: AbortSignal;
  source?: AgentLLMRequestSource;
}

export interface AgentLLMRequestFinish {
  message: Message;
  usage: TokenUsage;
  model?: string | undefined;
  providerFinishReason?: FinishReason;
  rawFinishReason?: string;
  providerMessageId?: string;
  timing?: ModelRequestTiming;
  traceId?: string;
}

export type AgentLLMRequestPartHandler = (part: StreamedMessagePart) => void | Promise<void>;

export interface AgentLLMRequestOverrides {
  messages?: readonly Message[];
  tools?: readonly Tool[];
  systemPrompt?: string;
  source?: AgentLLMRequestSource;
  maxOutputSize?: number;
  retry?: LLMRequestRetryOptions;
}

export interface SystemPromptContributionContext {
  readonly source: AgentLLMRequestSource | undefined;
  readonly tools: readonly Tool[];
}

export type SystemPromptContribution = (
  prompt: string,
  context: SystemPromptContributionContext,
) => string;

export interface AgentLLMRequestTask {
  readonly trace: LLMRequestTrace;
  readonly result: Promise<AgentLLMRequestFinish>;
}

export interface PreparedTurnRequestConfig {
  readonly thinkingEffort: ThinkingEffort;
}
export interface IAgentLLMRequesterService {
  readonly _serviceBrand: undefined;

  prepareTurnConfig(turnId: number): PreparedTurnRequestConfig | undefined;

  currentCredentials(): LlmCredentialProvider | undefined;

  credentialsForTurn(turnId: number): LlmCredentialProvider | undefined;

  request(
    overrides?: AgentLLMRequestOverrides,
    onPart?: AgentLLMRequestPartHandler,
    signal?: AbortSignal,
  ): Promise<AgentLLMRequestFinish>;

  registerSystemPromptContribution(
    id: string,
    contribution: SystemPromptContribution,
  ): IDisposable;

  start(
    overrides?: AgentLLMRequestOverrides,
    onPart?: AgentLLMRequestPartHandler,
    signal?: AbortSignal,
  ): AgentLLMRequestTask;
}

export const IAgentLLMRequesterService = createDecorator<IAgentLLMRequesterService>(
  'agentLLMRequesterService',
);

import type { FinishReason } from '#human/llm-requester/finish-reason';
import type { LlmCredentialProvider } from '#human/llm-requester/requester';
import type { ThinkingEffort } from '#human/llm-requester/thinking';
import type {
  AssistantMessage,
  Message,
  StreamedMessagePart,
  ToolDescription as Tool,
} from '#human/llm/message';
import type { TokenUsage } from '#human/llm-requester/usage';
import type { LLMRequestTrace } from '#/llm-adapter/contract/request-trace';
import type { ModelRequestTiming } from '#/llm-adapter/model/generate';
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

export interface AgentLLMRequestFinish {
  message: AssistantMessage;
  usage: TokenUsage;
  model?: string | undefined;
  providerFinishReason?: FinishReason;
  rawFinishReason?: string;
  providerMessageId?: string;
  timing?: ModelRequestTiming;
  requestId?: string;
}

export type AgentLLMRequestPartHandler = (part: StreamedMessagePart) => void | Promise<void>;

export interface AgentLLMRequestOverrides {
  messages?: readonly Message[];
  tools?: readonly Tool[];
  systemPrompt?: string;
  source?: AgentLLMRequestSource;
  maxOutputSize?: number;
  usedContextTokens?: number;
  promptCacheProbe?: 'compaction';
  onAttemptRetry?: () => void;
}

export interface AgentLLMRequestTask {
  readonly trace: LLMRequestTrace;
  readonly result: Promise<AgentLLMRequestFinish>;
}

export interface PreparedTurnRequestConfig {
  readonly thinkingEffort: ThinkingEffort;
}

export interface LoopRequester {
  prepareTurnConfig(turnId: number): PreparedTurnRequestConfig | undefined;

  currentCredentialProvider(): LlmCredentialProvider | undefined;

  credentialProviderForTurn(turnId: number): LlmCredentialProvider | undefined;

  request(
    overrides?: AgentLLMRequestOverrides,
    onPart?: AgentLLMRequestPartHandler,
    signal?: AbortSignal,
  ): Promise<AgentLLMRequestFinish>;

  start(
    overrides?: AgentLLMRequestOverrides,
    onPart?: AgentLLMRequestPartHandler,
    signal?: AbortSignal,
  ): AgentLLMRequestTask;
}

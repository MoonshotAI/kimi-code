import type { ToolDescription as Tool, Message } from '#human/llm/message';
import type { LLMRequestTrace } from '#/llm-adapter/contract/request-trace';
import type { LogContext } from '#/_base/log/log';
import type { LlmOutcome } from '#human/llm/response';
import type { LlmDimension, LlmRequester } from '#human/llm/requester';
import type { ProfileModelContext } from '#/agent/profile/profile';
import type { Model } from '#/llm-adapter/model/catalog';
import type { InitializedLlmRequester, ModelRequestParams } from '#/llm-adapter/model/generate';
import type { ThinkingEffort } from '#human/llm-requester/thinking';
import type { LoopRequestRuntime, TurnExecution, TurnExecutionInput } from './core/request';

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

export interface RequestConfigSnapshot {
  readonly resolved: ProfileModelContext;
  readonly params: ModelRequestParams;
  readonly systemPrompt: string;
  readonly maxCompletionTokensCap?: number;
}

export interface ResolvedRequestContext {
  readonly request: InitializedLlmRequester;
  readonly model: Model;
  readonly params: ModelRequestParams;
  readonly modelAlias: string;
  readonly thinkingEffort: ThinkingEffort;
  readonly systemPrompt: string;
  readonly tools?: readonly Tool[];
  readonly messages: Message[];
  readonly contextRevision: number;
  readonly promptCacheProbe: 'compaction' | undefined;
  readonly source: AgentLLMRequestSource;
  readonly logFields: AgentLLMRequestLogFields;
  readonly dynamicTools: boolean;
  readonly runtime: LoopRequestRuntime;
}

export interface CoreLoopRequesterOptions {
  readonly source: () => AgentLLMRequestSource;
  readonly runtime: LoopRequestRuntime;
  readonly config?: RequestConfigSnapshot;
  readonly dynamicTools?: boolean;
  readonly maxOutputSize?: number;
  readonly promptCacheProbe?: 'compaction';
  readonly tools?: readonly Tool[];
  readonly onTrace?: (trace: LLMRequestTrace) => void;
  readonly onOutcome?: (
    outcome: Extract<LlmOutcome, { type: 'done' }>,
    source: AgentLLMRequestSource,
  ) => void;
}

export interface AgentTurnExecutionInput extends TurnExecutionInput {
  readonly onTrace?: (trace: LLMRequestTrace) => void;
  readonly onOutcome?: (
    outcome: Extract<LlmOutcome, { type: 'done' }>,
    source: AgentLLMRequestSource,
  ) => void;
}

export type OperationLoopRequesterOptions = Omit<CoreLoopRequesterOptions, 'runtime'>;

export type CoreLoopRequester = LlmRequester<LlmDimension>;

export interface LoopRequester {
  createTurnExecution(input: AgentTurnExecutionInput): TurnExecution;
  prepareOperation(options: OperationLoopRequesterOptions, signal: AbortSignal): Promise<CoreLoopRequester>;
}

export function agentLLMRequestLogFields(source: AgentLLMRequestSource | undefined): AgentLLMRequestLogFields {
  switch (source?.type) {
    case 'turn':
      return {
        ...source.logFields,
        ...(source.step === undefined
          ? {}
          : { turnStep: `${String(source.turnId)}.${String(source.step)}` }),
      };
    case 'operation':
      return {
        ...source.logFields,
        ...(source.requestKind === undefined ? {} : { requestKind: source.requestKind }),
      };
    default:
      return {};
  }
}

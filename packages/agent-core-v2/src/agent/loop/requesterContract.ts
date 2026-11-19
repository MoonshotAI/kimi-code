import type { Message, ToolDescription as Tool } from '@moonshot-ai/core/llm/message';
import type { LLMRequestTrace } from '#/llm-adapter/contract/request-trace';
import type { LogContext } from '#/_base/log/log';
import type { LlmOutcome } from '@moonshot-ai/core/llm/response';
import type { InitializedLlmRequester, InitializedLlmRequestPart } from '@moonshot-ai/core/llm/requester';
import type { ProfileModelContext } from '#/agent/profile/profile';
import type { Model } from '#/llm-adapter/model/catalog';
import type { ThinkingEffort } from '@moonshot-ai/core/llm/request';
import type { LoopLlmRequester, LoopRequestRuntime } from '@moonshot-ai/core/loop/request';

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
  readonly params: InitializedLlmRequestPart;
  readonly systemPrompt: string;
  readonly maxCompletionTokensCap?: number;
}

export interface RequesterBinding {
  readonly request: InitializedLlmRequester;
  readonly model: Model;
  readonly requestMetadata: boolean;
}

export interface ResolvedRequestContext {
  readonly request: InitializedLlmRequester;
  readonly model: Model;
  readonly modelAlias: string;
  readonly thinkingEffort: ThinkingEffort;
  readonly systemPrompt: string;
  readonly tools?: readonly Tool[];
  readonly messages: Message[];
  readonly usedContextTokens?: number;
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
  readonly binding?: RequesterBinding;
  readonly onSnapshot?: (config: RequestConfigSnapshot) => void;
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

export type OperationLoopRequesterOptions = Omit<CoreLoopRequesterOptions, 'runtime'>;

export type CoreLoopRequester = LoopLlmRequester;

export interface LoopRequester {
  coreRequester(options: CoreLoopRequesterOptions): CoreLoopRequester;
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

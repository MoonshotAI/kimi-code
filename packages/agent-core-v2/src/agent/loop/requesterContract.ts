import type { Message, ToolDescription as Tool } from '@moonshot-ai/core/llm/message';
import type { LLMRequestTrace } from '#/llm-adapter/contract/request-trace';
import type { AgentLLMRequestLogFields, AgentLLMRequestSource } from '#/agent/usage/usage';
import type { LlmOutcome } from '@moonshot-ai/core/llm/response';
import type { LlmPolicy } from '@moonshot-ai/core/llm/policy/policy';
import type { InitializedLlmRequester, InitializedLlmRequestPart } from '@moonshot-ai/core/llm/requester';
import type { ProfileModelContext } from '#/agent/profile/profile';
import type { Model } from '#/provider-catalog/model/catalog';
import type { ThinkingEffort } from '@moonshot-ai/core/llm/request';
import type { LoopRequestRuntime } from '@moonshot-ai/core/loop/request';

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
  readonly runtime: LoopRequestRuntime;
}

export interface RequesterOptions {
  readonly source: () => AgentLLMRequestSource;
  readonly runtime: LoopRequestRuntime;
  readonly baseContents?: InitializedLlmRequestPart;

  readonly inheritedPolicy?: LlmPolicy;
  readonly maxOutputSize?: number;
  readonly promptCacheProbe?: 'compaction';
  readonly tools?: readonly Tool[];
  readonly onTrace?: (trace: LLMRequestTrace) => void;
  readonly onOutcome?: (
    outcome: Extract<LlmOutcome, { type: 'done' }>,
    source: AgentLLMRequestSource,
  ) => void;
}

export interface BoundRequesterOptions extends RequesterOptions {
  readonly config: RequestConfigSnapshot;
  readonly binding: RequesterBinding;
}

export type OperationRequesterOptions = Omit<
  RequesterOptions,
  'runtime' | 'baseContents' | 'inheritedPolicy'
>;

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

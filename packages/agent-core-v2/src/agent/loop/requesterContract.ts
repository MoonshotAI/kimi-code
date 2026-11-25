import type { ThinkingEffort, LlmRequestAttributes } from '@moonshot-ai/core/llm/request';
import type { InitializedLlmRequester, InitializedLlmRequestPart } from '@moonshot-ai/core/llm/requester';
import type { ProfileModelContext } from '#/agent/profile/profile';
import type { AgentLLMRequestLogFields, AgentLLMRequestSource } from '#/agent/usage/usage';
import type { Model } from '#/provider-catalog/model/catalog';

export interface RequestConfigSnapshot {
  readonly resolved: ProfileModelContext;
  readonly params: InitializedLlmRequestPart;
  readonly systemPrompt: string;
  readonly maxCompletionTokensCap?: number;
}

export interface AgentRequesterBinding {
  readonly request: InitializedLlmRequester;
  readonly model: Model;
  readonly modelAlias: string;
  readonly thinkingEffort: ThinkingEffort;
  readonly systemPrompt: string;
  readonly requestMetadata: boolean;
}

export function requestSourceOf(attributes: LlmRequestAttributes | undefined): AgentLLMRequestSource {
  const logFields = attributes?.logFields as AgentLLMRequestLogFields | undefined;
  if (attributes?.kind === 'loop') {
    return {
      type: 'turn',
      turnId: attributes.turnId ?? 0,
      ...(attributes.step === undefined ? {} : { step: attributes.step }),
      ...(logFields === undefined ? {} : { logFields }),
    };
  }
  const kind = attributes?.kind;
  const requestKind = kind === 'compaction'
    ? 'full_compaction'
    : kind === 'prediction'
      ? 'prompt_prediction'
      : kind;
  return {
    type: 'operation',
    ...(attributes?.turnId === undefined ? {} : { turnId: attributes.turnId }),
    ...(requestKind === undefined ? {} : { requestKind }),
    ...(logFields === undefined ? {} : { logFields }),
  };
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

import type { MediaStripSnapshot } from '#/agent/contextProjector/contextProjector';
import type { ProfileModelContext } from '#/agent/profile/profile';
import type { AgentRuntimeContext } from '#/agent/runtime/agentRuntime';
import type { ModelRequestParams } from '#/kosong/model/modelRequester';

import type { LlmRequestTraceState } from '#/features/llmRequester/llmRequesterOps';

import type { ToolCallIdNormalizer } from './toolCallIdNormalizer';

export interface TurnRequestConfig {
  readonly resolved: ProfileModelContext;
  readonly params: ModelRequestParams;
  readonly systemPrompt: string;
}

export interface LlmRequesterEffects {
  readonly turnConfigs: Map<number, TurnRequestConfig>;
  readonly mediaDegradedTurns: Set<number>;
  readonly mediaStrippedTurns: Map<number, MediaStripSnapshot>;
  readonly emittedThinkingEffortWarnings: Set<string>;
  lastConfigLogSignature: string | undefined;
  readonly toolCallIdNormalizer: ToolCallIdNormalizer;
}

export interface LlmRequesterOperationContext {
  readonly runtime: AgentRuntimeContext<LlmRequestTraceState>;
  readonly effects: LlmRequesterEffects;
}

export function llmRequesterOperationContext(
  runtime: AgentRuntimeContext<LlmRequestTraceState>,
): LlmRequesterOperationContext {
  return {
    runtime,
    effects: runtime.getLogicState<{ readonly effects: LlmRequesterEffects }>().effects,
  };
}

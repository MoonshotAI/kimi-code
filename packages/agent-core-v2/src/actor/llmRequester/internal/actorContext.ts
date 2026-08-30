import type { Snapshot } from 'xstate';

import type { MediaStripSnapshot } from '#/agent/contextProjector/contextProjector';
import type { AgentRuntimeContext } from '#/actor/agentRuntime';
import type { LlmRequestTraceState } from '#/actor/llmRequester/llmRequesterOps';
import type { ToolCallIdNormalizer } from '#/actor/llmRequester/internal/toolCallIdNormalizer';
import type { ProfileModelContext } from '#/actor/profile/profile';
import type { ModelRequestParams } from '#/kosong/model/modelRequester';

export interface TurnRequestConfig {
  readonly resolved: ProfileModelContext;
  readonly params: ModelRequestParams;
  readonly systemPrompt: string;
}

export interface LlmRequesterActorContext {
  readonly runtime: AgentRuntimeContext<LlmRequestTraceState>;
  ledger: LlmRequestTraceState;
  readonly toolCallIdNormalizer: ToolCallIdNormalizer;
  readonly turnConfigs: Map<number, TurnRequestConfig>;
  readonly mediaDegradedTurns: Set<number>;
  readonly mediaStrippedTurns: Map<number, MediaStripSnapshot>;
  readonly emittedThinkingEffortWarnings: Set<string>;
  lastConfigLogSignature: string | undefined;
}

export interface LlmRequesterCommitEvent {
  readonly type: 'llmRequester.commit';
  readonly ledger: LlmRequestTraceState;
}

export interface LlmRequesterPatchEvent {
  readonly type: 'llmRequester.patch';
  readonly patch: Partial<Pick<LlmRequesterActorContext, 'lastConfigLogSignature'>>;
}

export type LlmRequesterActorSnapshot = Snapshot<unknown> & {
  readonly context: LlmRequesterActorContext;
};

import type { Snapshot } from 'xstate';

import type { MediaStripSnapshot } from '#/agent/contextProjector/contextProjector';
import type { AgentRuntimeContext } from '#/actor/agentRuntime';
import type { LlmRequestTraceState } from '#/actor/llmRequester/llmRequesterOps';
import type { ProfileModelContext } from '#/actor/profile/profile';
import type { ModelRequestParams } from '#/kosong/model/modelRequester';

export interface TurnRequestConfig {
  readonly resolved: ProfileModelContext;
  readonly params: ModelRequestParams;
  readonly systemPrompt: string;
}

export interface LlmRequesterActorContext {
  readonly runtime: AgentRuntimeContext<LlmRequestTraceState>;
  readonly ledger: LlmRequestTraceState;
  readonly seenToolCallIds: ReadonlySet<string>;
  readonly toolCallIdsSeeded: boolean;
  readonly turnConfigs: ReadonlyMap<number, TurnRequestConfig>;
  readonly mediaDegradedTurns: ReadonlySet<number>;
  readonly mediaStrippedTurns: ReadonlyMap<number, MediaStripSnapshot>;
  readonly emittedThinkingEffortWarnings: ReadonlySet<string>;
  readonly lastConfigLogSignature: string | undefined;
}

export interface LlmRequesterCommitEvent {
  readonly type: 'llmRequester.commit';
  readonly ledger: LlmRequestTraceState;
}

export interface LlmRequesterToolCallIdsSeededEvent {
  readonly type: 'llmRequester.toolCallIdsSeeded';
  readonly ids: readonly string[];
}

export interface LlmRequesterToolCallIdsClaimedEvent {
  readonly type: 'llmRequester.toolCallIdsClaimed';
  readonly ids: readonly string[];
}

export interface LlmRequesterTurnConfigCachedEvent {
  readonly type: 'llmRequester.turnConfigCached';
  readonly turnId: number;
  readonly config: TurnRequestConfig;
}

export interface LlmRequesterMediaDegradedMarkedEvent {
  readonly type: 'llmRequester.mediaDegradedMarked';
  readonly turnId: number;
}

export interface LlmRequesterMediaStripCapturedEvent {
  readonly type: 'llmRequester.mediaStripCaptured';
  readonly turnId: number;
  readonly snapshot: MediaStripSnapshot;
}

export interface LlmRequesterThinkingWarningEmittedEvent {
  readonly type: 'llmRequester.thinkingWarningEmitted';
  readonly key: string;
}

export interface LlmRequesterConfigLogSignatureEvent {
  readonly type: 'llmRequester.configLogSignature';
  readonly signature: string;
}

export type LlmRequesterActorEvent =
  | LlmRequesterCommitEvent
  | LlmRequesterToolCallIdsSeededEvent
  | LlmRequesterToolCallIdsClaimedEvent
  | LlmRequesterTurnConfigCachedEvent
  | LlmRequesterMediaDegradedMarkedEvent
  | LlmRequesterMediaStripCapturedEvent
  | LlmRequesterThinkingWarningEmittedEvent
  | LlmRequesterConfigLogSignatureEvent;

export type LlmRequesterActorSnapshot = Snapshot<unknown> & {
  readonly context: LlmRequesterActorContext;
};

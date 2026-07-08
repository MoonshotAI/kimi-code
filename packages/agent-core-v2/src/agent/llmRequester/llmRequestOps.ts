/**
 * `llmRequester` domain (L4) — durable request-trace wire Model and Ops.
 *
 * Defines `llm.tools_snapshot` snapshots and `llm.request` outbound request
 * traces, with replay restoring only the snapshot de-dup cursor. Consumed by
 * the Agent-scope `llmRequester` implementation.
 */

import type { ThinkingEffort } from '#/app/llmProtocol/thinkingEffort';
import { defineModel } from '#/wire/model';
import { defineOp } from '#/wire/op';

export interface LlmRequestToolSchema {
  readonly name: string;
  readonly description: string;
  readonly parameters: Record<string, unknown>;
}

export interface LlmRequestTraceState {
  readonly seenToolsHashes: readonly string[];
}

export const LlmRequestTraceModel = defineModel<LlmRequestTraceState>(
  'llm.requestTrace',
  () => ({ seenToolsHashes: [] }),
);

export interface LlmToolsSnapshotPayload {
  readonly hash: string;
  readonly tools: readonly LlmRequestToolSchema[];
}

export const llmToolsSnapshot = defineOp(
  LlmRequestTraceModel,
  'llm.tools_snapshot',
  {
    apply: (s, p: LlmToolsSnapshotPayload): LlmRequestTraceState => {
      if (s.seenToolsHashes.includes(p.hash)) return s;
      return { seenToolsHashes: [...s.seenToolsHashes, p.hash] };
    },
  },
);

export interface LlmRequestPayload {
  readonly kind: 'loop' | 'compaction';
  readonly provider: string;
  readonly model: string;
  readonly modelAlias?: string;
  readonly thinkingEffort?: ThinkingEffort;
  readonly thinkingKeep?: string;
  readonly temperature?: number;
  readonly topP?: number;
  readonly maxTokens?: number;
  readonly betaApi?: boolean;
  readonly toolSelect: boolean;
  readonly systemPromptHash: string;
  readonly systemPrompt?: string;
  readonly toolsHash: string;
  readonly messageCount: number;
  readonly turnStep?: string;
  readonly attempt?: string;
  readonly projection?: 'strict';
  readonly droppedCount?: number;
}

export const llmRequest = defineOp(LlmRequestTraceModel, 'llm.request', {
  apply: (s, _p: LlmRequestPayload): LlmRequestTraceState => s,
});

declare module '#/agent/wireRecord/wireRecord' {
  interface WireRecordMap {
    'llm.tools_snapshot': LlmToolsSnapshotPayload;
    'llm.request': LlmRequestPayload;
  }
}

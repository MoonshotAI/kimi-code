/* oxlint-disable typescript-eslint/no-unsafe-declaration-merging, eslint-plugin-import/namespace -- Event2 class+payload-interface declaration merging is the sanctioned event-declaration idiom. */
import { z } from 'zod';

import { AgentEvent2 } from '#/app/event/event2';
import type { ThinkingEffort } from '#/kosong/contract/provider';
import { defineState } from '#/state/state';

export interface LlmRequestToolSchema {
  readonly name: string;
  readonly description: string;
  readonly parameters: Record<string, unknown>;
}

export interface LlmRequestTraceState {
  readonly seenToolsHashes: readonly string[];
}

const llmToolEntrySchema = z.object({
  name: z.string(),
  description: z.string(),
  parameters: z.record(z.string(), z.unknown()),
});

const llmToolsSnapshotSchema = z.object({
  agentId: z.string(),
  hash: z.string(),
  tools: z.array(llmToolEntrySchema).readonly(),
});

export class LlmToolsSnapshot extends AgentEvent2<z.infer<typeof llmToolsSnapshotSchema>> {
  static override readonly type = 'llm.tools_snapshot';
  static override readonly durable = true;
  static override readonly schema = llmToolsSnapshotSchema;
}
export interface LlmToolsSnapshot {
  readonly agentId: string;
  readonly hash: string;
  readonly tools: readonly LlmRequestToolSchema[];
}

const llmRequestSchema = z.object({
  agentId: z.string(),
  kind: z.enum(['loop', 'compaction']),
  provider: z.string(),
  model: z.string(),
  modelAlias: z.string().optional(),
  thinkingEffort: z.custom<ThinkingEffort>().optional(),
  thinkingKeep: z.string().optional(),
  temperature: z.number().optional(),
  topP: z.number().optional(),
  maxTokens: z.number().optional(),
  betaApi: z.boolean().optional(),
  toolSelect: z.boolean(),
  systemPromptHash: z.string(),
  systemPrompt: z.string().optional(),
  toolsHash: z.string(),
  messageCount: z.number(),
  turnStep: z.string().optional(),
  attempt: z.string().optional(),
  projection: z.enum(['strict', 'media-degraded', 'media-stripped', 'strict-media-degraded', 'strict-media-stripped']).optional(),
  droppedCount: z.number().optional(),
});

export type LlmRequestPayload = z.infer<typeof llmRequestSchema>;

export class LlmRequest extends AgentEvent2<LlmRequestPayload> {
  static override readonly type = 'llm.request';
  static override readonly durable = true;
  static override readonly schema = llmRequestSchema;
}
export interface LlmRequest {
  readonly agentId: string;
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
  readonly projection?:
    | 'strict'
    | 'media-degraded'
    | 'media-stripped'
    | 'strict-media-degraded'
    | 'strict-media-stripped';
  readonly droppedCount?: number;
}

export const llmRequestTraceKey = defineState(
  'llm.requestTrace',
  (): LlmRequestTraceState => ({ seenToolsHashes: [] }),
).replayable({ schema: z.custom<LlmRequestTraceState>() })
  .on(LlmToolsSnapshot, (s, e) => {
    if (s.seenToolsHashes.includes(e.hash)) return;
    s.seenToolsHashes = [...s.seenToolsHashes, e.hash];
  })
  .on(LlmRequest, () => {});

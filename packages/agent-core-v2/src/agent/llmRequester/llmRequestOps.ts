/**
 * `llmRequester` domain (L4) — durable request-trace wire Model and Ops.
 *
 * Defines `llm.tools_snapshot` snapshots and `llm.request` outbound request
 * traces, with replay restoring only the snapshot de-dup cursor. Consumed by
 * the Agent-scope `llmRequester` implementation.
 */

import { z } from 'zod';

import type { ThinkingEffort } from '#/app/llmProtocol/thinkingEffort';
import { defineModel } from '#/wire/model';

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

const llmToolEntrySchema = z.object({
  name: z.string(),
  description: z.string(),
  parameters: z.record(z.string(), z.unknown()),
});

declare module '#/wire/types' {
  interface PersistedOpMap {
    'llm.tools_snapshot': typeof llmToolsSnapshot;
    'llm.request': typeof llmRequest;
  }
}

export const llmToolsSnapshot = LlmRequestTraceModel.defineOp('llm.tools_snapshot', {
  schema: z.object({
    hash: z.string(),
    tools: z.array(llmToolEntrySchema).readonly(),
  }),
  apply: (s, p) => {
    if (s.seenToolsHashes.includes(p.hash)) return s;
    return { seenToolsHashes: [...s.seenToolsHashes, p.hash] };
  },
});

export const llmRequest = LlmRequestTraceModel.defineOp('llm.request', {
  schema: z.object({
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
    projection: z.enum(['strict', 'media-degraded', 'media-stripped']).optional(),
    droppedCount: z.number().optional(),
  }),
  apply: (s) => s,
});

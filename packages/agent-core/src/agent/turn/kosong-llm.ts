/**
 * Kosong-backed implementation of the loop `LLM` interface.
 *
 * Bridges the new `loop/llm.ts` contract onto
 * the kosong `generate()` streaming API:
 *
 *   - kosong's per-part `onMessagePart` is forwarded to loop per-delta
 *     callbacks (`onTextDelta`, `onThinkDelta`, `onToolCallDelta`).
 *   - loop per-block callbacks (`onTextPart`, `onThinkPart`) only fire
 *     after the kosong stream drains, iterating over the merged
 *     `result.message.content`. Completed
 *     blocks land on the WAL seam, raw deltas never do.
 *   - kosong's finish reasons are preserved as provider diagnostics. The loop
 *     derives loop control from the normalized response shape, not from the
 *     provider's finish-reason spelling.
 */

import {
  emptyUsage,
  generate as kosongGenerate,
  isRetryableGenerateError,
  isUnknownCapability,
  type ChatProvider,
  type ContentPart,
  type GenerateCallbacks,
  type Message,
  type ModelCapability,
  type StreamDecodeStats,
  type StreamedMessagePart,
} from '@moonshot-ai/kosong';

import type {
  LLM,
  LLMChatParams,
  LLMChatResponse,
  LLMStreamTiming,
} from '../../loop';
import {
  applyCompletionBudget,
  type CompletionBudgetConfig,
} from '../../utils/completion-budget';
import type { GenerateOptionsWithRequestLogFields } from '../llm-request-logger';

export type GenerateFn = typeof kosongGenerate;

export interface KosongLLMConfig {
  readonly provider: ChatProvider;
  readonly systemPrompt: string;
  readonly capability?: ModelCapability | undefined;
  /**
   * Optional override for the kosong `generate()` entry point. Lets the
   * agent host (and its test harness) inject a scripted generator without
   * having to substitute the entire LLM implementation.
   */
  readonly generate?: GenerateFn | undefined;
  /**
   * Completion budget config resolved from agent/provider settings. The
   * final cap is applied to each request.
   */
  readonly completionBudgetConfig?: CompletionBudgetConfig | undefined;
  /**
   * Returns the number of context tokens already consumed by the latest
   * completed step (API-reported input + output). Used by chat-completions
   * providers to size the completion budget to the remaining context window.
   */
  readonly usedContextTokens?: (() => number) | undefined;
}

export class KosongLLM implements LLM {
  readonly systemPrompt: string;
  readonly modelName: string;
  readonly capability?: ModelCapability | undefined;

  private readonly provider: ChatProvider;
  private readonly generate: GenerateFn;
  private readonly completionBudgetConfig: CompletionBudgetConfig | undefined;
  private readonly usedContextTokens: (() => number) | undefined;

  constructor(config: KosongLLMConfig) {
    this.provider = config.provider;
    this.modelName = config.provider.modelName;
    this.systemPrompt = config.systemPrompt;
    this.capability = config.capability;
    this.generate = config.generate ?? kosongGenerate;
    this.completionBudgetConfig = config.completionBudgetConfig;
    this.usedContextTokens = config.usedContextTokens;
  }

  async chat(params: LLMChatParams): Promise<LLMChatResponse> {
    let requestStartedAt = Date.now();
    let requestSentAt: number | undefined;
    let firstChunkAt: number | undefined;
    let streamEndedAt: number | undefined;
    let decodeStats: StreamDecodeStats | undefined;
    const markRequestStart = (): void => {
      requestStartedAt = Date.now();
    };
    const markRequestSent = (): void => {
      requestSentAt ??= Date.now();
    };
    const markStreamEnd = (stats?: StreamDecodeStats): void => {
      streamEndedAt = Date.now();
      decodeStats = stats;
    };
    const markStreamOutput = (): void => {
      firstChunkAt ??= Date.now();
    };
    const callbacks = buildKosongCallbacks(params, markStreamOutput);

    // Compute and apply the per-request completion budget against a
    // throwaway shallow clone. `effectiveProvider` is local to this call
    // and never written back to `this.provider`, so retries (handled at
    // a higher layer) keep using the same long-lived provider/client.
    const effectiveProvider = applyCompletionBudget({
      provider: this.provider,
      budget: this.completionBudgetConfig,
      capability: this.capability,
      usedContextTokens: this.usedContextTokens?.(),
    });
    const options: GenerateOptionsWithRequestLogFields = {
      signal: params.signal,
      onRequestStart: markRequestStart,
      onRequestSent: markRequestSent,
      onStreamEnd: markStreamEnd,
      requestLogFields: params.requestLogFields,
    };

    const result = await this.generate(
      effectiveProvider,
      this.systemPrompt,
      [...params.tools],
      downgradeUnsupportedMedia(params.messages, this.capability),
      callbacks,
      options,
    );

    // Replay merged content parts onto loop per-block callbacks after the
    // stream drained. This preserves WAL append order and stops partial
    // parts from landing if the upstream stream aborts mid-message.
    if (params.onTextPart !== undefined || params.onThinkPart !== undefined) {
      for (const part of result.message.content) {
        if (part.type === 'text' && params.onTextPart !== undefined) {
          await params.onTextPart(part);
        } else if (part.type === 'think' && params.onThinkPart !== undefined) {
          await params.onThinkPart(part);
        }
      }
    }

    const response: LLMChatResponse = {
      toolCalls: [...result.message.toolCalls],
      providerFinishReason: result.finishReason ?? undefined,
      rawFinishReason: result.rawFinishReason ?? undefined,
      usage: result.usage ?? emptyUsage(),
      streamTiming:
        firstChunkAt === undefined
          ? undefined
          : buildStreamTiming(requestStartedAt, requestSentAt, firstChunkAt, streamEndedAt, decodeStats),
    };

    return response;
  }

  isRetryableError(error: unknown): boolean {
    return isRetryableGenerateError(error);
  }
}

function buildStreamTiming(
  requestStartedAt: number,
  requestSentAt: number | undefined,
  firstChunkAt: number,
  streamEndedAt: number | undefined,
  decodeStats: StreamDecodeStats | undefined,
): LLMStreamTiming {
  const outputEndedAt = streamEndedAt ?? Date.now();
  const firstTokenLatencyMs = Math.max(0, firstChunkAt - requestStartedAt);
  const timing: {
    -readonly [K in keyof LLMStreamTiming]: LLMStreamTiming[K];
  } = {
    firstTokenLatencyMs,
    streamDurationMs: Math.max(0, outputEndedAt - firstChunkAt),
  };
  // Split TTFT across the request-dispatch boundary when the provider reported
  // it. Clamp `requestSentAt` into [requestStartedAt, firstChunkAt] so a stray
  // clock reading can never produce a negative or over-long component.
  if (requestSentAt !== undefined) {
    const sentAt = Math.min(Math.max(requestSentAt, requestStartedAt), firstChunkAt);
    timing.requestBuildMs = sentAt - requestStartedAt;
    timing.serverFirstTokenMs = firstChunkAt - sentAt;
  }
  // Split the decode window into server (awaiting parts) vs. client (processing
  // parts) time, as accounted by the stream loop.
  if (decodeStats !== undefined) {
    timing.serverDecodeMs = Math.max(0, decodeStats.serverDecodeMs);
    timing.clientConsumeMs = Math.max(0, decodeStats.clientConsumeMs);
  }
  return timing;
}

function buildKosongCallbacks(
  params: LLMChatParams,
  markStreamOutput: () => void,
): GenerateCallbacks {
  type ToolCallIdentity = { readonly toolCallId: string; readonly name: string };
  type BufferedToolCallDelta = { readonly argumentsPart?: string | undefined };

  const toolCallIdentities = new Map<number | string, ToolCallIdentity>();
  const pendingIndexedToolCallDeltas = new Map<number | string, BufferedToolCallDelta[]>();
  let lastToolCallIdentity: ToolCallIdentity | undefined;

  const emitToolCallDelta = (delta: {
    toolCallId: string;
    name: string;
    argumentsPart?: string;
  }): void => {
    if (params.onToolCallDelta === undefined) return;
    params.onToolCallDelta(delta);
  };

  return {
    onMessagePart: (part: StreamedMessagePart) => {
      markStreamOutput();
      if (part.type === 'text') {
        if (params.onTextDelta === undefined) return;
        params.onTextDelta(part.text);
        return;
      }
      if (part.type === 'think') {
        if (params.onThinkDelta === undefined) return;
        params.onThinkDelta(part.think);
        return;
      }
      if (part.type === 'function') {
        const identity = { toolCallId: part.id, name: part.name };
        lastToolCallIdentity = identity;
        if (part._streamIndex !== undefined) {
          toolCallIdentities.set(part._streamIndex, identity);
        }
        emitToolCallDelta({
          toolCallId: part.id,
          name: part.name,
          ...(part.arguments !== null ? { argumentsPart: part.arguments } : {}),
        });
        if (part._streamIndex !== undefined) {
          const pendingDeltas = pendingIndexedToolCallDeltas.get(part._streamIndex);
          if (pendingDeltas !== undefined) {
            pendingIndexedToolCallDeltas.delete(part._streamIndex);
            for (const delta of pendingDeltas) {
              emitToolCallDelta({
                toolCallId: identity.toolCallId,
                name: identity.name,
                ...delta,
              });
            }
          }
        }
        return;
      }
      if (part.type === 'tool_call_part') {
        const argumentsPart = part.argumentsPart;
        const delta = argumentsPart !== null ? { argumentsPart } : {};
        if (part.index !== undefined) {
          const identity = toolCallIdentities.get(part.index);
          if (identity === undefined) {
            const pendingDeltas = pendingIndexedToolCallDeltas.get(part.index) ?? [];
            pendingDeltas.push(delta);
            pendingIndexedToolCallDeltas.set(part.index, pendingDeltas);
            return;
          }
          emitToolCallDelta({
            toolCallId: identity.toolCallId,
            name: identity.name,
            ...delta,
          });
          return;
        }
        const identity = lastToolCallIdentity;
        if (identity === undefined) return;
        emitToolCallDelta({
          toolCallId: identity.toolCallId,
          name: identity.name,
          ...delta,
        });
      }
    },
  };
}

export function buildMessagesWithSystem(systemPrompt: string, history: Message[]): Message[] {
  return [
    { role: 'system', content: [{ type: 'text', text: systemPrompt }], toolCalls: [] },
    ...history,
  ];
}

export function downgradeUnsupportedMedia(
  messages: readonly Message[],
  capability: ModelCapability | undefined,
): Message[] {
  if (capability === undefined || isUnknownCapability(capability)) return [...messages];
  const dropImage = !capability.image_in;
  const dropVideo = !capability.video_in;
  const dropAudio = !capability.audio_in;
  if (!dropImage && !dropVideo && !dropAudio) return [...messages];

  const drop = { dropImage, dropVideo, dropAudio };
  let changed = false;
  const out: Message[] = [];
  for (const message of messages) {
    let nextContent: ContentPart[] | undefined;
    for (let i = 0; i < message.content.length; i++) {
      const part = message.content[i]!;
      const placeholder = mediaPlaceholder(part, drop);
      if (placeholder === undefined) {
        nextContent?.push(part);
        continue;
      }
      nextContent ??= message.content.slice(0, i);
      nextContent.push({ type: 'text', text: placeholder });
      changed = true;
    }
    out.push(nextContent === undefined ? message : { ...message, content: nextContent });
  }
  return changed ? out : [...messages];
}

function mediaPlaceholder(
  part: ContentPart,
  drop: { readonly dropImage: boolean; readonly dropVideo: boolean; readonly dropAudio: boolean },
): string | undefined {
  if (part.type === 'image_url' && drop.dropImage) {
    return '[image omitted: current model has no image input]';
  }
  if (part.type === 'video_url' && drop.dropVideo) {
    return '[video omitted: current model has no video input]';
  }
  if (part.type === 'audio_url' && drop.dropAudio) {
    return '[audio omitted: current model has no audio input]';
  }
  return undefined;
}

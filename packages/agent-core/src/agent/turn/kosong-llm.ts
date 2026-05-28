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
  type GenerateOptions,
  isRetryableGenerateError,
  type ChatProvider,
  type GenerateCallbacks,
  type Message,
  type ModelCapability,
  type StreamedMessagePart,
} from '@moonshot-ai/kosong';

import type {
  LLM,
  LLMChatParams,
  LLMChatResponse,
  LLMRequestLogContext,
  LLMStreamTiming,
} from '../../loop';
import {
  applyCompletionBudget,
  type CompletionBudgetConfig,
} from '../../utils/completion-budget';

export const GENERATE_REQUEST_LOG_CONTEXT = '__kimiRequestLogContext';

export type GenerateOptionsWithRequestLog = GenerateOptions & {
  readonly [GENERATE_REQUEST_LOG_CONTEXT]?: LLMRequestLogContext;
};

export type GenerateFn = typeof kosongGenerate;

export interface KosongLLMConfig {
  readonly provider: ChatProvider;
  readonly modelName: string;
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
}

export class KosongLLM implements LLM {
  readonly systemPrompt: string;
  readonly modelName: string;
  readonly capability?: ModelCapability | undefined;

  private readonly provider: ChatProvider;
  private readonly generate: GenerateFn;
  private readonly completionBudgetConfig: CompletionBudgetConfig | undefined;

  constructor(config: KosongLLMConfig) {
    this.provider = config.provider;
    this.modelName = config.modelName;
    this.systemPrompt = config.systemPrompt;
    this.capability = config.capability;
    this.generate = config.generate ?? kosongGenerate;
    this.completionBudgetConfig = config.completionBudgetConfig;
  }

  async chat(params: LLMChatParams): Promise<LLMChatResponse> {
    let requestStartedAt = Date.now();
    let firstChunkAt: number | undefined;
    let streamEndedAt: number | undefined;
    const markRequestStart = (): void => {
      requestStartedAt = Date.now();
    };
    const markStreamEnd = (): void => {
      streamEndedAt = Date.now();
    };
    const markStreamOutput = (): void => {
      if (firstChunkAt === undefined) {
        firstChunkAt = Date.now();
      }
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
    });

    const result = await this.generate(
      effectiveProvider,
      this.systemPrompt,
      [...params.tools],
      params.messages,
      callbacks,
      generateOptions(params, {
        onRequestStart: markRequestStart,
        onStreamEnd: markStreamEnd,
      }),
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
          : buildStreamTiming(requestStartedAt, firstChunkAt, streamEndedAt),
    };

    return response;
  }

  isRetryableError(error: unknown): boolean {
    return isRetryableGenerateError(error);
  }
}

function buildStreamTiming(
  requestStartedAt: number,
  firstChunkAt: number,
  streamEndedAt: number | undefined,
): LLMStreamTiming {
  const outputEndedAt = streamEndedAt ?? Date.now();
  return {
    firstTokenLatencyMs: Math.max(0, firstChunkAt - requestStartedAt),
    streamDurationMs: Math.max(0, outputEndedAt - firstChunkAt),
  };
}

function generateOptions(
  params: LLMChatParams,
  hooks: Pick<GenerateOptions, 'onRequestStart' | 'onStreamEnd'>,
): GenerateOptionsWithRequestLog {
  return {
    signal: params.signal,
    onRequestStart: hooks.onRequestStart,
    onStreamEnd: hooks.onStreamEnd,
    [GENERATE_REQUEST_LOG_CONTEXT]: params.requestLogContext,
  };
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

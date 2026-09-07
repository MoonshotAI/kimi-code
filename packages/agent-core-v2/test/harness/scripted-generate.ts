import { type FinishReason } from '#human/llm/finish-reason';
import type { ThinkingRequestOptions } from '#human/llm/thinking';
import {
  isContentPart,
  isToolCall,
  isToolCallPart,
  type StreamedMessagePart,
} from '#human/llm/message';
import type {
  ExtraParams,
  LlmRequestConfig,
  LlmRequestContent,
  LlmRequestControl,
  LlmRequester,
} from '#human/llm/requester/requester';
import { fromLlmMessage, type Message, type Tool } from '#/llm-adapter/contract/message';
import { isAbortError } from '#/llm-adapter/contract/errors';
import { estimateTokensForMessages } from '#/llm-adapter/contract/tokens';
import type { TokenUsage } from '#human/llm/usage';
import type { SamplingOptions } from '#/llm-adapter/model/model-requester';
import { translateProviderError } from '#/llm-adapter/protocol/errors';

import {
  generateInputSnapshot,
  generateInputsSnapshot,
  normalizeGenerateInput,
  type GenerateCall,
} from './snapshots';

export interface LegacyGenerateResult {
  readonly id: string | null;
  readonly message: Message;
  readonly usage: TokenUsage | null;
  readonly finishReason: FinishReason | null;
  readonly rawFinishReason: string | null;
  readonly traceId?: string | null;
}

export type LegacyGenerateFn = (
  provider: { readonly name: string; readonly modelName: string },
  systemPrompt: string,
  tools: readonly Tool[],
  history: Message[],
  callbacks?: { onMessagePart?: (part: StreamedMessagePart) => void | Promise<void> },
  options?: {
    readonly signal?: AbortSignal;
    readonly auth?: { readonly apiKey?: string };
    readonly cacheKey?: string;
    readonly sampling?: SamplingOptions;
    readonly thinking?: ThinkingRequestOptions;
    readonly maxCompletionTokens?: number;
  },
) => Promise<LegacyGenerateResult>;

function samplingFromExtraParams(extra: ExtraParams | undefined): SamplingOptions | undefined {
  if (extra === undefined) return undefined;
  const temperature =
    extra.openai?.temperature ??
    extra.responses?.temperature ??
    extra.anthropic?.temperature ??
    extra.googleGenai?.temperature;
  const topP =
    extra.openai?.top_p ?? extra.responses?.top_p ?? extra.anthropic?.top_p ?? extra.googleGenai?.topP;
  if (temperature === undefined && topP === undefined) return undefined;
  return { temperature, topP };
}

export function requesterFromGenerateFn(fn: LegacyGenerateFn): LlmRequester {
  return {
    async generate(config, content, control) {
      const emit = control.onEvent;
      const parts: StreamedMessagePart[] = [];
      let result: LegacyGenerateResult;
      try {
        result = await fn(
          { name: config.model.provider, modelName: config.model.model },
          config.systemPrompt ?? '',
          [...(config.tools ?? [])],
          content.messages.map(fromLlmMessage),
          {
            onMessagePart: (part) => {
              parts.push(structuredClone(part));
            },
          },
          {
            signal: control.signal,
            auth: config.model.apiKey === undefined ? undefined : { apiKey: config.model.apiKey },
            cacheKey: config.cacheKey,
            sampling: samplingFromExtraParams(config.extraParams),
            thinking: config.thinking,
            maxCompletionTokens: config.maxCompletionTokens,
          },
        );
      } catch (error) {
        for (const part of normalizeProviderStreamParts(parts)) {
          emit?.({ type: 'llm.delta', part: structuredClone(part) });
        }
        throw error;
      }

      emit?.({
        type: 'llm.headers',
        headers:
          result.traceId !== undefined && result.traceId !== null
            ? { 'x-trace-id': result.traceId }
            : {},
      });
      const streamed =
        parts.length > 0
          ? normalizeProviderStreamParts(parts)
          : partsFromGeneratedMessage(result.message);
      for (const part of streamed) {
        emit?.({ type: 'llm.delta', part: structuredClone(part) });
        await Promise.resolve();
        control.signal.throwIfAborted();
      }
      if (result.usage !== null) {
        emit?.({ type: 'llm.usage', usage: result.usage });
      }
      emit?.({
        type: 'llm.finish',
        finish: { finishReason: result.finishReason, rawFinishReason: result.rawFinishReason },
      });
      if (result.id !== null) {
        emit?.({ type: 'llm.message-id', messageId: result.id });
      }
      emit?.({ type: 'llm.done' });
    },
  };
}

interface ScriptedResponse {
  readonly parts?: readonly StreamedMessagePart[] | undefined;
  readonly finishReason?: FinishReason | null | undefined;
  readonly rawFinishReason?: string | null | undefined;
  readonly traceId?: string | null | undefined;
  readonly error?: Error | undefined;
}

export function createScriptedGenerate() {
  const calls: GenerateCall[] = [];
  const responses: ScriptedResponse[] = [];
  let assertedCallCount = 0;

  function mockNextResponse(...response: StreamedMessagePart[]) {
    responses.push({ parts: structuredClone(response) });
  }

  function mockNextProviderResponse(input: {
    readonly parts?: readonly StreamedMessagePart[] | undefined;
    readonly finishReason?: FinishReason | null | undefined;
    readonly rawFinishReason?: string | null | undefined;
    readonly traceId?: string | null | undefined;
    readonly error?: Error | undefined;
  }) {
    responses.push({
      ...(input.parts !== undefined ? { parts: structuredClone(input.parts) } : {}),
      ...(input.finishReason !== undefined ? { finishReason: input.finishReason } : {}),
      ...(input.rawFinishReason !== undefined ? { rawFinishReason: input.rawFinishReason } : {}),
      ...(input.traceId !== undefined ? { traceId: input.traceId } : {}),
      ...(input.error !== undefined ? { error: input.error } : {}),
    });
  }

  async function generate(
    config: LlmRequestConfig,
    content: LlmRequestContent,
    control: LlmRequestControl,
  ): Promise<void> {
    control.signal.throwIfAborted();

    const response = responses.shift();
    if (response === undefined) {
      throw new Error(`Unexpected generate call #${String(calls.length + 1)}`);
    }

    const history = content.messages.map(fromLlmMessage);
    const input = normalizeGenerateInput({
      systemPrompt: config.systemPrompt ?? '',
      tools: (config.tools ?? []).map(({ name, description, parameters }) => ({
        name,
        description,
        parameters,
      })),
      history: structuredClone(history),
    });
    calls.push(input);

    const emit = control.onEvent;
    emit?.({
      type: 'llm.headers',
      headers:
        response.traceId !== undefined && response.traceId !== null
          ? { 'x-trace-id': response.traceId }
          : {},
    });

    const scriptedParts = response.parts ?? [];
    const contentParts = scriptedParts.filter((part) => isContentPart(part));
    const toolCalls = scriptedParts.filter((part) => isToolCall(part));
    const message: Message = {
      role: 'assistant',
      content: structuredClone(contentParts),
      toolCalls: structuredClone(toolCalls),
    };
    const streamed =
      scriptedParts.length > 0
        ? normalizeProviderStreamParts(scriptedParts)
        : partsFromGeneratedMessage(message);

    for (const part of streamed) {
      emit?.({ type: 'llm.delta', part: structuredClone(part) });
      await Promise.resolve();
      control.signal.throwIfAborted();
    }
    if (response.error !== undefined) {
      if (isAbortError(response.error)) throw response.error;
      throw translateProviderError(response.error);
    }

    const inferredFinishReason: FinishReason = toolCalls.length > 0 ? 'tool_calls' : 'completed';
    const finishReason = response.finishReason === undefined ? inferredFinishReason : response.finishReason;
    emit?.({
      type: 'llm.usage',
      usage: {
        inputOther: estimateTokensForMessages(normalizeMessagesForTokenEstimates(history)),
        output: estimateTokensForMessages(normalizeMessagesForTokenEstimates([message])),
        inputCacheRead: 0,
        inputCacheCreation: 0,
      },
    });
    emit?.({
      type: 'llm.finish',
      finish: {
        finishReason,
        rawFinishReason:
          response.rawFinishReason === undefined
            ? defaultRawFinishReason(finishReason)
            : response.rawFinishReason,
      },
    });
    emit?.({ type: 'llm.message-id', messageId: `mock-${String(calls.length)}` });
    emit?.({ type: 'llm.done' });
  }

  const requester: LlmRequester = { generate };

  return {
    requester,
    calls,
    lastInput() {
      const pendingCount = calls.length - assertedCallCount;
      if (pendingCount === 0) {
        throw new Error('No unasserted LLM input. Call ctx.lastLlmInput() after an LLM call.');
      }
      if (pendingCount > 1) {
        throw new Error(
          `Expected one unasserted LLM input, but ${String(pendingCount)} were produced. ` +
            'Call ctx.lastLlmInput() after each LLM call.',
        );
      }

      assertedCallCount = calls.length;
      return generateInputSnapshot(calls.at(-1)!, calls.at(-2));
    },
    inputs() {
      const pendingCount = calls.length - assertedCallCount;
      if (pendingCount === 0) {
        throw new Error('No unasserted LLM inputs. Call ctx.llmInputs() after LLM calls.');
      }

      const pending = calls.slice(assertedCallCount);
      const previous = calls[assertedCallCount - 1];
      assertedCallCount = calls.length;
      return generateInputsSnapshot(pending, previous);
    },
    mockNextResponse,
    mockNextProviderResponse,
  };
}

function partsFromGeneratedMessage(message: Message): StreamedMessagePart[] {
  const parts: StreamedMessagePart[] = [
    ...message.content.map((part) => structuredClone(part)),
    ...message.toolCalls.map((part) => structuredClone(part)),
  ];
  return parts.length > 0 ? parts : [{ type: 'text', text: '' }];
}

function normalizeProviderStreamParts(
  parts: readonly StreamedMessagePart[],
): StreamedMessagePart[] {
  const normalized: StreamedMessagePart[] = [];
  const pendingIndexedDeltas = new Map<number | string, StreamedMessagePart[]>();
  const seenIndexes = new Set<number | string>();

  for (const part of parts) {
    if (isToolCallPart(part) && part.index !== undefined && !seenIndexes.has(part.index)) {
      const pending = pendingIndexedDeltas.get(part.index) ?? [];
      pending.push(structuredClone(part));
      pendingIndexedDeltas.set(part.index, pending);
      continue;
    }

    normalized.push(structuredClone(part));

    if (isToolCall(part) && part._streamIndex !== undefined) {
      seenIndexes.add(part._streamIndex);
      const pending = pendingIndexedDeltas.get(part._streamIndex);
      if (pending !== undefined) {
        pendingIndexedDeltas.delete(part._streamIndex);
        normalized.push(...pending);
      }
    }
  }

  for (const pending of pendingIndexedDeltas.values()) {
    normalized.push(...pending);
  }

  return normalized;
}

function normalizeMessagesForTokenEstimates(messages: Message[]): Message[] {
  return messages.map((message) => ({
    ...message,
    content: message.content.map((part) =>
      part.type === 'text'
        ? {
            ...part,
            text: part.text.replaceAll(/^Plan file: .+$/gm, 'Plan file: <plan-file>'),
          }
        : part,
    ),
  }));
}

function defaultRawFinishReason(finishReason: FinishReason | null): string | null {
  if (finishReason === null) return null;
  if (finishReason === 'completed') return 'stop';
  return finishReason;
}

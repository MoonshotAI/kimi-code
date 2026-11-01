import { performance, type EventLoopUtilization } from 'node:perf_hooks';

import { type FinishReason } from '#human/llm-requester/finish-reason';
import type { ThinkingRequestOptions } from '#human/llm-requester/thinking';
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
} from '#human/llm-requester/requester';
import type { AssistantMessage, Message, ToolDescription as Tool } from '#human/llm/message';
import {
  errorDiagnostics,
  isAbortError,
  isImageFormatError,
  isRecoverableRequestStructureError,
  llmMessageFromError,
} from '#/llm-adapter/contract/errors';
import { unwrapErrorCause } from '#/errors';
import { estimateTokensForMessages } from '#/llm-adapter/contract/tokens';
import type { TokenUsage } from '#human/llm-requester/usage';
import type {
  InitializedLlmRequester,
  ModelRequestEvent,
  ModelRequestInput,
  ModelRequestParams,
  ModelRequestTiming,
  SamplingOptions,
} from '#/llm-adapter/model/generate';
import type { Model } from '#/llm-adapter/model/catalog';
import { translateProviderError } from '#/llm-adapter/protocol/errors';
import { toLlmErrorMessage } from '#human/llm-requester/errors';
import { resolveEndpoint } from '#human/llm/endpoint';
import type { LlmRequestPart } from '#human/llm/requester';
import { runLlmRequest } from '#human/llm/policy/policy';
import type { LlmSettleControl } from '#human/llm/policy/settle';
import {
  contentsOf,
  createRequester,
  mergeFields,
  requesterContents,
} from '#human/llm/requester';
import type { FinishInfo, LlmOutcome, LlmTiming } from '#human/llm/response';
import { createMessageAccumulator } from '#human/llm/message';
import { mergeUsagePatch } from '#human/llm-requester/usage';
import { emptyResponseError } from '#human/llm-requester/empty-response';
import { NO_FINISH } from '#human/llm-requester/finish-reason';
import { UNKNOWN_CAPABILITY } from '#/llm-adapter/contract/capability';

import {
  generateInputSnapshot,
  generateInputsSnapshot,
  normalizeGenerateInput,
  type GenerateCall,
} from './snapshots';

export interface LegacyGenerateResult {
  readonly id: string | null;
  readonly message: AssistantMessage;
  readonly usage: TokenUsage | null;
  readonly finishReason: FinishReason | null;
  readonly rawFinishReason: string | null;
  readonly requestId?: string | null;
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
    readonly maxContextTokens?: number;
    readonly usedContextTokens?: number;
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

export function generateCallOf(config: LlmRequestConfig, content: LlmRequestContent): GenerateCall {
  return normalizeGenerateInput({
    systemPrompt: config.systemPrompt ?? '',
    tools: (config.tools ?? []).map(({ name, description, parameters }) => ({
      name,
      description,
      parameters,
    })),
    history: structuredClone([...content.messages]),
  });
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
          [...content.messages],
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
            maxContextTokens: config.maxContextTokens,
            usedContextTokens: content.usedContextTokens,
          },
        );
      } catch (error) {
        for (const part of normalizeProviderStreamParts(parts)) {
          emit?.({ type: 'llm.streaming.part', part: structuredClone(part) });
        }
        throw error;
      }

      emit?.({
        type: 'llm.streaming.headers',
        headers:
          result.requestId !== undefined && result.requestId !== null
            ? { 'x-trace-id': result.requestId }
            : {},
      });
      const streamed =
        parts.length > 0
          ? normalizeProviderStreamParts(parts)
          : partsFromGeneratedMessage(result.message);
      for (const part of streamed) {
        emit?.({ type: 'llm.streaming.part', part: structuredClone(part) });
        await Promise.resolve();
        control.signal.throwIfAborted();
      }
      if (result.usage !== null) {
        emit?.({ type: 'llm.streaming.usage', usage: result.usage });
      }
      emit?.({
        type: 'llm.streaming.finish',
        finish: { finishReason: result.finishReason, rawFinishReason: result.rawFinishReason },
      });
      if (result.id !== null) {
        emit?.({ type: 'llm.streaming.message_id', messageId: result.id });
      }
      emit?.({ type: 'llm.done' });
    },
  };
}

interface ScriptedResponse {
  readonly parts?: readonly StreamedMessagePart[] | undefined;
  readonly finishReason?: FinishReason | null | undefined;
  readonly rawFinishReason?: string | null | undefined;
  readonly requestId?: string | null | undefined;
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
    readonly requestId?: string | null | undefined;
    readonly error?: Error | undefined;
  }) {
    responses.push({
      ...(input.parts !== undefined ? { parts: structuredClone(input.parts) } : {}),
      ...(input.finishReason !== undefined ? { finishReason: input.finishReason } : {}),
      ...(input.rawFinishReason !== undefined ? { rawFinishReason: input.rawFinishReason } : {}),
      ...(input.requestId !== undefined ? { requestId: input.requestId } : {}),
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

    const input = generateCallOf(config, content);
    calls.push(input);

    const emit = control.onEvent;
    emit?.({
      type: 'llm.streaming.headers',
      headers:
        response.requestId !== undefined && response.requestId !== null
          ? { 'x-trace-id': response.requestId }
          : {},
    });

    const scriptedParts = response.parts ?? [];
    const contentParts = scriptedParts.filter((part) => isContentPart(part));
    const toolCalls = scriptedParts.filter((part) => isToolCall(part));
    const message: AssistantMessage = {
      role: 'assistant',
      content: structuredClone(contentParts),
      toolCalls: structuredClone(toolCalls),
    };
    const streamed =
      scriptedParts.length > 0
        ? normalizeProviderStreamParts(scriptedParts)
        : partsFromGeneratedMessage(message);

    for (const part of streamed) {
      emit?.({ type: 'llm.streaming.part', part: structuredClone(part) });
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
      type: 'llm.streaming.usage',
      usage: {
        inputOther: estimateTokensForMessages(normalizeMessagesForTokenEstimates(input.history)),
        output: estimateTokensForMessages(normalizeMessagesForTokenEstimates([message])),
        inputCacheRead: 0,
        inputCacheCreation: 0,
      },
    });
    emit?.({
      type: 'llm.streaming.finish',
      finish: {
        finishReason,
        rawFinishReason:
          response.rawFinishReason === undefined
            ? defaultRawFinishReason(finishReason)
            : response.rawFinishReason,
      },
    });
    emit?.({ type: 'llm.streaming.message_id', messageId: `mock-${String(calls.length)}` });
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

function partsFromGeneratedMessage(message: AssistantMessage): StreamedMessagePart[] {
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

function normalizeMessagesForTokenEstimates(messages: readonly Message[]): Message[] {
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


export function coreRequesterFromA(
  initial: InitializedLlmRequester,
  requester: LlmRequester,
): InitializedLlmRequester {
  return {
    [requesterContents]: contentsOf(initial),
    with: ((part: LlmRequestPart) => {
      const merged = mergeFields(contentsOf(initial), contentsOf(part)) as LlmRequestPart;
      return coreRequesterFromA(createRequester().with(merged as never) as InitializedLlmRequester, requester);
    }) as InitializedLlmRequester['with'],
    request: (rest) => initial.with(rest).request({}),
    generate: (rest, control) =>
      runLlmRequest(initial.with(rest).request({}), control, (request, settleControl) =>
        runLegacyRequester(request, requester, settleControl),
      ),
  };
}

async function runLegacyRequester(
  request: ReturnType<InitializedLlmRequester['request']>,
  requester: LlmRequester,
  control: LlmSettleControl,
): Promise<LlmOutcome> {
  const endpoint = await resolveEndpoint(request.endpoint);
  const options = request.protocol.options as { readonly extras?: unknown } | undefined;
  const config: LlmRequestConfig = {
    model: {
      provider: request.model.spec.provider,
      model: request.model.spec.name,
      capability: legacyCapability(request.model.spec),
      maxContextSize: request.model.spec.maxContextSize,
      maxInputSize: request.model.spec.maxInputSize,
      baseUrl: endpoint.baseUrl,
      defaultHeaders: endpoint.headers,
      apiKey: endpoint.apiKey,
    },
    systemPrompt: request.profile?.systemPrompt,
    tools: request.profile?.tools?.filter((tool) => tool.deferred !== true),
    cacheKey: request.model.cacheKey,
    thinking: request.model.thinking,
    responseFormat: request.model.responseFormat,
    maxCompletionTokens:
      request.model.maxOutputTokens === 'none' ? 0 : request.model.maxOutputTokens,
    maxContextTokens: request.model.spec.maxContextSize,
    extraParams:
      options?.extras === undefined
        ? undefined
        : ({ openai: options.extras } as LlmRequestConfig['extraParams']),
    stream: request.protocol.stream,
  };
  const content: LlmRequestContent = {
    messages: request.content.messages,
    usedContextTokens: request.content.usedTokens,
  };
  let requestStartedAt = Date.now();
  let requestSentAt: number | undefined;
  let firstChunkAt: number | undefined;
  let serverDecodeMs = 0;
  let clientConsumeMs = 0;
  let lastResumeAt = 0;
  let decodeEluStart: EventLoopUtilization | undefined;
  let decodeEluEnd: EventLoopUtilization | undefined;
  let headers: Record<string, string> | undefined;
  let requestId: string | undefined;
  let usage: Parameters<typeof mergeUsagePatch>[0];
  let finish: FinishInfo | undefined;
  let messageId: string | undefined;
  let failure: { readonly error: import('#human/llm/response').LlmErrorMessage; readonly rawError?: unknown } | undefined;
  const failed = (
    current: { error: import('#human/llm/response').LlmErrorMessage; rawError?: unknown },
  ): LlmOutcome => ({
    type: 'failed',
    ...current,
    diagnostics:
      errorDiagnostics(current.rawError) ??
      request.protocol.base.diagnoseError?.({
        error: current.error,
        rawError: current.rawError,
        headers,
      }),
  });
  const accumulator = createMessageAccumulator();
  try {
    await requester.generate(config, content, {
      signal: control.signal,
      onEvent: (event) => {
        switch (event.type) {
          case 'llm.sent':
            if (requestSentAt !== undefined) requestStartedAt = Date.now();
            requestSentAt = Date.now();
            control.onEvent?.(event);
            return;
          case 'llm.streaming.headers':
            headers = event.headers;
            requestId = request.protocol.base.requestId?.(event.headers);
            control.onEvent?.(event);
            return;
          case 'llm.streaming.part': {
            const arrivedAt = Date.now();
            if (firstChunkAt === undefined) {
              firstChunkAt = arrivedAt;
              decodeEluStart = performance.eventLoopUtilization();
            } else {
              serverDecodeMs += arrivedAt - lastResumeAt;
            }
            accumulator.push(event.part);
            control.onEvent?.(event);
            lastResumeAt = Date.now();
            clientConsumeMs += lastResumeAt - arrivedAt;
            return;
          }
          case 'llm.streaming.usage':
            usage = mergeUsagePatch(usage, event.usage);
            return;
          case 'llm.streaming.finish':
            finish = event.finish;
            return;
          case 'llm.streaming.message_id':
            messageId = event.messageId;
            return;
          case 'llm.failed.syntax':
          case 'llm.failed.remote':
            failure = { error: event.error, rawError: 'rawError' in event ? event.rawError : undefined };
            return;
          case 'llm.request.retrying':
            return;
          case 'llm.done':
            return;
        }
      },
    });
  } catch (error) {
    if (control.signal.aborted || isAbortError(error)) {
      return { type: 'aborted', message: null, reason: error };
    }
    const raw = unwrapErrorCause(error);
    const classified = llmMessageFromError(raw);
    const normalized =
      classified?.kind === 'status' && isImageFormatError(raw)
        ? { ...classified, kind: 'image_format' as const }
        : classified?.kind === 'status' && isRecoverableRequestStructureError(raw)
          ? { ...classified, kind: 'request_structure' as const }
          : classified;
    return failed({ error: normalized ?? toLlmErrorMessage(raw), rawError: error });
  }
  if (failure !== undefined) {
    return failed(failure);
  }
  const message = accumulator.finish();
  const empty = emptyResponseError(message, config.model, finish ?? NO_FINISH);
  if (empty !== null) return failed({ error: empty });
  const streamEndedAt = Date.now();
  if (firstChunkAt !== undefined) {
    serverDecodeMs += streamEndedAt - lastResumeAt;
    if (decodeEluStart !== undefined) decodeEluEnd = performance.eventLoopUtilization(decodeEluStart);
  }
  return {
    type: 'done',
    message,
    usage,
    headers,
    requestId,
    finish,
    messageId,
    timing:
      firstChunkAt === undefined
        ? undefined
        : buildStreamTiming(
            requestStartedAt,
            requestSentAt,
            firstChunkAt,
            streamEndedAt,
            finalizeDecodeStats(decodeEluEnd, { serverDecodeMs, clientConsumeMs }),
          ) as LlmTiming,
  };
}


function legacyCapability(
  spec: ReturnType<InitializedLlmRequester['request']>['model']['spec'],
): LlmRequestConfig['model']['capability'] {
  const capability = spec.capability;
  if (capability === undefined) return UNKNOWN_CAPABILITY;
  return {
    image_in: capability.image_in === true,
    video_in: capability.video_in === true,
    audio_in: capability.audio_in === true,
    thinking: capability.thinking === true,
    tool_use: capability.tool_use ?? true,
    dynamically_loaded_tools: capability.dynamically_loaded_tools === true,
  };
}


export interface ModelEventRequester {
  readonly model: Model;
  request(
    input: ModelRequestInput,
    signal?: AbortSignal,
    params?: ModelRequestParams,
  ): AsyncIterable<ModelRequestEvent>;
}

export function aRequesterFromModelEvents(requester: ModelEventRequester): LlmRequester {
  return {
    async generate(config, content, control) {
      const input: ModelRequestInput = {
        systemPrompt: config.systemPrompt ?? '',
        tools: config.tools ?? [],
        messages: content.messages,
        responseFormat: config.responseFormat,
      };
      const params: ModelRequestParams = {
        cacheKey: config.cacheKey,
        sampling: samplingFromExtraParams(config.extraParams),
        thinkingEffort: config.thinking?.effort,
        thinkingKeep: config.thinking?.keep,
        maxCompletionTokens: config.maxCompletionTokens,
        usedContextTokens: content.usedContextTokens,
        maxContextTokens: config.maxContextTokens,
        stream: config.stream,
        onRequestId: (requestId) => {
          control.onEvent?.({
            type: 'llm.streaming.headers',
            headers:
              requestId === undefined
                ? {}
                : { 'x-request-id': requestId, 'x-trace-id': requestId },
          });
        },
      };
      let sawPart = false;
      for await (const event of requester.request(input, control.signal, params)) {
        switch (event.type) {
          case 'part':
            sawPart = true;
            control.onEvent?.({ type: 'llm.streaming.part', part: event.part });
            break;
          case 'usage':
            control.onEvent?.({ type: 'llm.streaming.usage', usage: event.usage });
            break;
          case 'finish': {
            if (!sawPart) {
              for (const part of partsFromGeneratedMessage(event.message)) {
                control.onEvent?.({ type: 'llm.streaming.part', part });
              }
            }
            if (event.requestId !== undefined) {
              control.onEvent?.({
                type: 'llm.streaming.headers',
                headers: { 'x-request-id': event.requestId, 'x-trace-id': event.requestId },
              });
            }
            control.onEvent?.({
              type: 'llm.streaming.finish',
              finish: {
                finishReason: event.providerFinishReason ?? null,
                rawFinishReason: event.rawFinishReason ?? null,
              },
            });
            if (event.id !== undefined) {
              control.onEvent?.({ type: 'llm.streaming.message_id', messageId: event.id });
            }
            break;
          }
          case 'timing':
            break;
        }
      }
      control.onEvent?.({ type: 'llm.done' });
    },
  };
}


interface StreamDecodeStats {
  readonly serverDecodeMs: number;
  readonly clientConsumeMs: number;
  readonly clientBlockedMs?: number;
}

function finalizeDecodeStats(
  elu: EventLoopUtilization | undefined,
  raw: StreamDecodeStats,
): StreamDecodeStats {
  if (elu === undefined) return raw;
  return {
    serverDecodeMs: raw.serverDecodeMs,
    clientConsumeMs: raw.clientConsumeMs,
    clientBlockedMs: Math.max(0, Math.round(elu.active) - raw.clientConsumeMs),
  };
}

type MutableModelRequestTiming = { -readonly [K in keyof ModelRequestTiming]: ModelRequestTiming[K] };

export function buildStreamTiming(
  requestStartedAt: number,
  requestSentAt: number | undefined,
  firstChunkAt: number,
  streamEndedAt: number | undefined,
  decodeStats: StreamDecodeStats | undefined,
): ModelRequestTiming {
  const outputEndedAt = streamEndedAt ?? Date.now();
  const timing: MutableModelRequestTiming = {
    firstTokenLatencyMs: Math.max(0, firstChunkAt - requestStartedAt),
    streamDurationMs: Math.max(0, outputEndedAt - firstChunkAt),
  };
  if (requestSentAt !== undefined) {
    const sentAt = Math.min(Math.max(requestSentAt, requestStartedAt), firstChunkAt);
    timing.requestBuildMs = sentAt - requestStartedAt;
    timing.serverFirstTokenMs = firstChunkAt - sentAt;
  }
  if (decodeStats !== undefined) {
    timing.serverDecodeMs = Math.max(0, decodeStats.serverDecodeMs);
    timing.clientConsumeMs = Math.max(0, decodeStats.clientConsumeMs);
    if (decodeStats.clientBlockedMs !== undefined) {
      timing.clientBlockedMs = Math.max(0, decodeStats.clientBlockedMs);
    }
  }
  return timing;
}

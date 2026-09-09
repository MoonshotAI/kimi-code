import * as fs from 'node:fs';
import * as nodePath from 'node:path';
import { performance, type EventLoopUtilization } from 'node:perf_hooks';

import { AsyncEventQueue } from '#/_base/asyncEventQueue';
import type { LlmErrorMessage } from '#human/llm/errors';
import { emptyResponseError } from '#human/llm/empty-response';
import { NO_FINISH, type FinishInfo } from '#human/llm/finish-reason';
import type { ProviderMediaContribution, VideoUploadInput } from '#human/llm/media/upload';
import { createMessageAccumulator, type VideoURLPart } from '#human/llm/message';
import type { LlmModel } from '#human/llm/model';
import type { ProtocolName } from '#human/llm/protocol/base';
import {
  mergeRequestHeaders,
  type ExtraParams,
  type LlmRequestConfig,
  type LlmRequestContent,
  type LlmRequestControl,
  type LlmRequestEvent,
  type LlmRequester,
} from '#human/llm/requester/requester';
import type { TokenUsage } from '#human/llm/usage';
import type { CredentialSource } from '#human/kimi-oauth/credential-source';

import {
  ChatProviderError,
  errorFromLlmMessage,
  isAbortError,
  isUnauthorizedLlmError,
  llmMessageFromError,
  traceIdFromHeadersRecord,
  VideoUploadUnsupportedError,
} from '../contract/errors';
import { fromLlmAssistantMessage, toLlmMessage, type Tool } from '../contract/message';
import { mergeUsagePatch } from '#human/llm/usage';

import type { Model, ProviderRequestAuth } from './catalog';
import type {
  ModelRequestEvent,
  ModelRequestInput,
  ModelRequestParams,
  ModelRequester,
  ModelRequestTiming,
  SamplingOptions,
} from './model-requester';
import { translateProviderError } from '../protocol/errors';

export interface ResolvedLlmModel {
  readonly requester: LlmRequester;
  readonly protocol: ProtocolName;
  readonly model: LlmModel;
  readonly media?: ProviderMediaContribution;
}

export interface ModelLlmGateway {
  resolve(model: Model): ResolvedLlmModel;
}

interface StreamDecodeStats {
  readonly serverDecodeMs: number;
  readonly clientConsumeMs: number;
  readonly clientBlockedMs?: number;
}

export class ModelRequesterImpl implements ModelRequester {
  private cached: ResolvedLlmModel | undefined;

  constructor(
    readonly model: Model,
    private readonly gateway: ModelLlmGateway,
  ) {}

  private resolve(): ResolvedLlmModel {
    if (this.cached === undefined) {
      this.cached = this.gateway.resolve(this.model);
    }
    return this.cached;
  }

  private readonly credentialSource: CredentialSource = {
    resolve: async (model, options) => {
      const auth = await this.model.authProvider.getAuth({ force: options?.force });
      return applyAuth(model, auth);
    },
    canRecover: (_model, error) =>
      this.model.authProvider.canRefresh === true && isUnauthorizedLlmError(error),
  };

  request(
    input: ModelRequestInput,
    signal?: AbortSignal,
    params?: ModelRequestParams,
  ): AsyncIterable<ModelRequestEvent> {
    const queue = new AsyncEventQueue<ModelRequestEvent>();
    void this.runRequest(input, signal, queue, params).then(
      () => queue.end(),
      (error) => queue.fail(error),
    );
    return queue;
  }

  async uploadVideo(
    input: string | VideoUploadInput,
    options?: { readonly signal?: AbortSignal },
  ): Promise<VideoURLPart> {
    const resolved = this.resolve();
    const uploader = resolved.media?.uploadVideo;
    if (uploader === undefined) {
      throw new VideoUploadUnsupportedError(
        `Model "${this.model.id}" (protocol=${this.model.protocol}) does not support video upload`,
      );
    }
    const video = typeof input === 'string' ? readVideoFile(input) : input;
    const source = this.credentialSource;
    const credentialed = await source.resolve(resolved.model);
    try {
      return await uploader(video, { model: credentialed, signal: options?.signal });
    } catch (error) {
      if (options?.signal?.aborted === true || source.canRecover?.(credentialed, error) !== true) {
        throw error;
      }
    }
    const refreshed = await source.resolve(resolved.model, { force: true });
    return uploader(video, { model: refreshed, signal: options?.signal });
  }

  private async generateAttempt(
    requester: LlmRequester,
    config: LlmRequestConfig,
    content: LlmRequestContent,
    control: LlmRequestControl,
  ): Promise<LlmErrorMessage | undefined> {
    let failed: LlmErrorMessage | undefined;
    try {
      await requester.generate(config, content, {
        ...control,
        onEvent: (event) => {
          if (event.type === 'llm.failed.remote' || event.type === 'llm.failed.syntax') {
            failed = event.error;
            return;
          }
          control.onEvent?.(event);
        },
      });
    } catch (error) {
      if (isAbortError(error)) throw error;
      const message = llmMessageFromError(error);
      if (message === undefined) throw translateProviderError(error);
      failed = message;
    }
    return failed;
  }

  private async runRequest(
    input: ModelRequestInput,
    signal: AbortSignal | undefined,
    queue: AsyncEventQueue<ModelRequestEvent>,
    params?: ModelRequestParams,
  ): Promise<void> {
    signal?.throwIfAborted();
    const resolved = this.resolve();
    const requester = resolved.requester;

    let requestStartedAt = Date.now();
    let requestSentAt: number | undefined;
    let firstChunkAt: number | undefined;
    let streamEndedAt: number | undefined;
    let serverDecodeMs = 0;
    let clientConsumeMs = 0;
    let lastResumeAt = 0;
    let decodeEluStart: EventLoopUtilization | undefined;
    let decodeEluEnd: EventLoopUtilization | undefined;

    let accumulator = createMessageAccumulator();
    let usage: TokenUsage | undefined;
    let finish: FinishInfo | undefined;
    let messageId: string | undefined;
    let traceId: string | null | undefined;

    const config: LlmRequestConfig = {
      model: resolved.model,
      systemPrompt: input.systemPrompt,
      tools: wireTools(input.tools),
      cacheKey: params?.cacheKey,
      thinking:
        params?.thinkingEffort === undefined
          ? undefined
          : { effort: params.thinkingEffort, keep: params.thinkingKeep },
      responseFormat: input.responseFormat,
      maxCompletionTokens: params?.maxCompletionTokens,
      maxContextTokens: params?.maxContextTokens,
      extraParams: samplingExtraParams(resolved.protocol, params?.sampling),
    };
    const content: LlmRequestContent = {
      messages: input.messages.map(toLlmMessage),
      usedContextTokens: params?.usedContextTokens,
    };

    const control: LlmRequestControl = {
      signal: signal ?? new AbortController().signal,
      onEvent: (event: LlmRequestEvent) => {
        switch (event.type) {
          case 'llm.sent': {
            const now = Date.now();
            if (requestSentAt !== undefined) {
              requestStartedAt = now;
              accumulator = createMessageAccumulator();
              usage = undefined;
              finish = undefined;
              messageId = undefined;
            }
            requestSentAt = now;
            return;
          }
          case 'llm.streaming.headers': {
            traceId = traceIdFromHeadersRecord(event.headers);
            params?.onTraceId?.(traceId);
            return;
          }
          case 'llm.streaming.part': {
            const arrivedAt = Date.now();
            if (firstChunkAt === undefined) {
              firstChunkAt = arrivedAt;
              decodeEluStart = performance.eventLoopUtilization();
            } else {
              serverDecodeMs += arrivedAt - lastResumeAt;
            }
            accumulator.push(event.part);
            queue.push({ type: 'part', part: event.part });
            lastResumeAt = Date.now();
            clientConsumeMs += lastResumeAt - arrivedAt;
            return;
          }
          case 'llm.streaming.usage': {
            usage = mergeUsagePatch(usage, event.usage);
            return;
          }
          case 'llm.streaming.finish': {
            finish = event.finish;
            return;
          }
          case 'llm.streaming.message_id': {
            messageId = event.messageId;
            return;
          }
          case 'llm.done': {
            streamEndedAt = Date.now();
            if (firstChunkAt !== undefined) {
              serverDecodeMs += streamEndedAt - lastResumeAt;
              if (decodeEluStart !== undefined) {
                decodeEluEnd = performance.eventLoopUtilization(decodeEluStart);
              }
            }
            return;
          }
        }
      },
    };

    const source = this.credentialSource;
    const credentialed = await source.resolve(config.model);
    let failure = await this.generateAttempt(
      requester,
      { ...config, model: credentialed },
      content,
      control,
    );
    if (
      failure !== undefined &&
      !control.signal.aborted &&
      source.canRecover?.(credentialed, failure) === true
    ) {
      const refreshed = await source.resolve(config.model, { force: true });
      failure = await this.generateAttempt(
        requester,
        { ...config, model: refreshed },
        content,
        control,
      );
    }
    if (failure !== undefined) {
      throw errorFromLlmMessage(failure);
    }

    const emptyError = emptyResponseError(accumulator.finish(), config.model, finish ?? NO_FINISH);
    if (emptyError !== null) {
      throw errorFromLlmMessage(emptyError);
    }

    if (usage !== undefined) {
      queue.push({ type: 'usage', usage, model: this.model.name });
    }
    queue.push({
      type: 'finish',
      message: fromLlmAssistantMessage(accumulator.finish()),
      providerFinishReason: finish?.finishReason ?? undefined,
      rawFinishReason: finish?.rawFinishReason ?? undefined,
      id: messageId,
      traceId: traceId ?? undefined,
    });
    if (firstChunkAt !== undefined) {
      const elu =
        decodeEluEnd ??
        (decodeEluStart === undefined
          ? undefined
          : performance.eventLoopUtilization(decodeEluStart));
      queue.push({
        type: 'timing',
        ...buildStreamTiming(
          requestStartedAt,
          requestSentAt,
          firstChunkAt,
          streamEndedAt,
          finalizeDecodeStats(elu, {
            serverDecodeMs,
            clientConsumeMs,
          }),
        ),
      });
    }
  }
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

function applyAuth(model: LlmModel, auth: ProviderRequestAuth | undefined): LlmModel {
  if (auth === undefined) return model;
  return {
    ...model,
    apiKey: auth.apiKey ?? model.apiKey,
    defaultHeaders: mergeRequestHeaders(model.defaultHeaders, auth.headers),
  };
}

function wireTools(tools: readonly Tool[]): readonly Tool[] {
  if (!tools.some((tool) => tool.deferred === true)) return tools;
  return tools.filter((tool) => tool.deferred !== true);
}

function samplingExtraParams(
  protocol: ProtocolName,
  sampling: SamplingOptions | undefined,
): ExtraParams | undefined {
  if (sampling === undefined) return undefined;
  const { temperature, topP } = sampling;
  if (temperature === undefined && topP === undefined) return undefined;
  switch (protocol) {
    case 'openai':
      return { openai: { temperature, top_p: topP } };
    case 'openai_responses':
      return { responses: { temperature, top_p: topP } };
    case 'anthropic':
      return { anthropic: { temperature, top_p: topP } };
    case 'google-genai':
      return { googleGenai: { temperature, topP } };
  }
}

const EXT_TO_MIME: Record<string, string> = {
  mp4: 'video/mp4',
  mpeg: 'video/mpeg',
  mov: 'video/quicktime',
  webm: 'video/webm',
  mkv: 'video/x-matroska',
  avi: 'video/x-msvideo',
  flv: 'video/x-flv',
  '3gp': 'video/3gpp',
};

function readVideoFile(path: string): VideoUploadInput {
  if (!fs.existsSync(path)) {
    throw new ChatProviderError(`Video file not found: ${path}`);
  }
  const filename = nodePath.basename(path);
  const ext = filename.includes('.') ? filename.split('.').pop()!.toLowerCase() : '';
  const mimeType = EXT_TO_MIME[ext];
  if (mimeType === undefined) {
    throw new ChatProviderError(
      `KimiFiles.uploadVideo: file extension does not indicate a video type: ${filename}`,
    );
  }
  const data = fs.readFileSync(path);
  return { data: new Uint8Array(data), mimeType, filename };
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

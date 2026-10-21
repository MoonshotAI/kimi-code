import * as fs from 'node:fs';
import * as nodePath from 'node:path';
import { performance, type EventLoopUtilization } from 'node:perf_hooks';

import { AsyncEventQueue } from '#/_base/asyncEventQueue';
import type { ILogService } from '#/_base/log/log';
import type { LlmRequestSanitizedEvent } from '#/app/telemetry/events';
import type { ITelemetryService } from '#/app/telemetry/telemetry';
import type { LlmErrorMessage } from '#human/llm/errors';
import { emptyResponseError } from '#human/llm/empty-response';
import { NO_FINISH, type FinishInfo } from '#human/llm/finish-reason';
import type { ProviderMediaContribution, ImageUploadInput, VideoUploadInput } from '#human/llm/media/upload';
import { createMessageAccumulator, type ImageURLPart, type VideoURLPart } from '#human/llm/message';
import type { LlmModel } from '#human/llm/model';
import type { ProtocolName } from '#human/llm/protocol/base';
import { applyCredential } from '#human/credentials/credentials';
import {
  type ExtraParams,
  type LlmRequestConfig,
  type LlmRequestContent,
  type LlmRequestEvent,
  type LlmRequester,
} from '#human/llm/requester/requester';
import type { TokenUsage } from '#human/llm/usage';

import {
  ChatProviderError,
  errorFromLlmMessage,
  ImageUploadUnsupportedError,
  isAbortError,
  llmMessageFromError,
  traceIdFromHeadersRecord,
  VideoUploadUnsupportedError,
} from '../contract/errors';
import { fromLlmAssistantMessage, toLlmMessage, type Message, type Tool } from '../contract/message';
import { mergeUsagePatch } from '#human/llm/usage';

import type { Model } from './catalog';
import type {
  ModelRequestEvent,
  ModelRequestInput,
  ModelRequestParams,
  ModelRequester,
  ModelRequestTiming,
  SamplingOptions,
} from './model-requester';
import {
  REQUEST_SANITIZE_ENV,
  resolveRequestSanitizeEnabled,
  sanitizeRequestMessages,
  sanitizeRequestSurface,
  type RequestSanitizeRepair,
  type RequestSanitizeRepairKind,
} from './requestSanitize';
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

export interface ModelRequesterObservability {
  readonly log?: ILogService;
  readonly telemetry?: ITelemetryService;
  readonly env?: (name: string) => string | undefined;
}

interface StreamDecodeStats {
  readonly serverDecodeMs: number;
  readonly clientConsumeMs: number;
  readonly clientBlockedMs?: number;
}

interface SanitizedOutgoing {
  readonly messages: readonly Message[];
  readonly systemPrompt: string;
  readonly tools: readonly Tool[];
}

export class ModelRequesterImpl implements ModelRequester {
  private cached: ResolvedLlmModel | undefined;
  private cachedRequester: LlmRequester | undefined;
  private lastSanitizeSignature: string | undefined;

  constructor(
    readonly model: Model,
    private readonly gateway: ModelLlmGateway,
    private readonly observability: ModelRequesterObservability = {},
  ) {}

  private resolve(): ResolvedLlmModel {
    if (this.cached === undefined) {
      this.cached = this.gateway.resolve(this.model);
    }
    return this.cached;
  }

  private requesterFor(resolved: ResolvedLlmModel): LlmRequester {
    if (this.cachedRequester === undefined) {
      this.cachedRequester = throwToEvent(resolved.requester);
    }
    return this.cachedRequester;
  }

  private sanitizeOutgoing(input: ModelRequestInput, protocol: ProtocolName): SanitizedOutgoing {
    if (!this.requestSanitizeEnabled()) {
      return {
        messages: input.messages,
        systemPrompt: input.systemPrompt,
        tools: input.tools,
      };
    }
    const { messages, repairs } = sanitizeRequestMessages(input.messages, { protocol });
    const surface = sanitizeRequestSurface(input.systemPrompt, input.tools);
    const allRepairs = [...repairs, ...surface.repairs];
    if (allRepairs.length === 0) {
      this.lastSanitizeSignature = undefined;
    } else {
      this.reportSanitizeRepairs(allRepairs, protocol);
    }
    return { messages, systemPrompt: surface.systemPrompt, tools: surface.tools };
  }

  private requestSanitizeEnabled(): boolean {
    const env = this.observability.env;
    if (env === undefined) return resolveRequestSanitizeEnabled();
    return resolveRequestSanitizeEnabled({ [REQUEST_SANITIZE_ENV]: env(REQUEST_SANITIZE_ENV) });
  }

  private reportSanitizeRepairs(
    repairs: readonly RequestSanitizeRepair[],
    protocol: ProtocolName,
  ): void {
    const signature = repairs
      .map((repair) => `${repair.kind}:${repair.role}:${repair.toolCallId ?? ''}:${repair.count}`)
      .toSorted()
      .join('|');
    if (signature === this.lastSanitizeSignature) return;
    this.lastSanitizeSignature = signature;
    const countOf = (kind: RequestSanitizeRepairKind): number =>
      repairs.reduce((total, repair) => (repair.kind === kind ? total + repair.count : total), 0);
    const loneSurrogates = countOf('lone_surrogate');
    const emptyToolContent = countOf('empty_tool_content');
    const toolMediaDowngraded = countOf('unsupported_tool_media');
    const toolCallIds = [
      ...new Set(repairs.flatMap((repair) => (repair.toolCallId === undefined ? [] : [repair.toolCallId]))),
    ].slice(0, 5);
    this.observability.log?.warn('sanitized the outgoing request to keep it wire-valid', {
      loneSurrogates,
      emptyToolContent,
      toolMediaDowngraded,
      toolCallIds,
      model: this.model.id,
      protocol,
    });
    const properties: LlmRequestSanitizedEvent = {
      lone_surrogates: loneSurrogates,
      empty_tool_content: emptyToolContent,
      tool_media_downgraded: toolMediaDowngraded,
      model: this.model.id,
      protocol,
    };
    this.observability.telemetry?.track2('llm_request_sanitized', properties);
  }

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
    const credential = await this.model.credentialProvider?.resolve();
    const model = applyCredential(resolved.model, credential);
    return uploader(video, { model, signal: options?.signal });
  }

  async uploadImage(
    input: ImageUploadInput,
    options?: { readonly signal?: AbortSignal },
  ): Promise<ImageURLPart> {
    const resolved = this.resolve();
    const uploader = resolved.media?.uploadImage;
    if (uploader === undefined) {
      throw new ImageUploadUnsupportedError(
        `Model "${this.model.id}" (protocol=${this.model.protocol}) does not support image upload`,
      );
    }
    const credential = await this.model.credentialProvider?.resolve();
    const model = applyCredential(resolved.model, credential);
    return uploader(input, { model, signal: options?.signal });
  }

  private async runRequest(
    input: ModelRequestInput,
    signal: AbortSignal | undefined,
    queue: AsyncEventQueue<ModelRequestEvent>,
    params?: ModelRequestParams,
  ): Promise<void> {
    signal?.throwIfAborted();
    const resolved = this.resolve();
    const requester = this.requesterFor(resolved);

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
    let failed: LlmErrorMessage | undefined;

    const outgoing = this.sanitizeOutgoing(input, resolved.protocol);
    const config: LlmRequestConfig = {
      model: resolved.model,
      systemPrompt: outgoing.systemPrompt,
      tools: wireTools(outgoing.tools),
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
      messages: outgoing.messages.map(toLlmMessage),
      usedContextTokens: params?.usedContextTokens,
    };

    const credential = await this.model.credentialProvider?.resolve();
    await requester.generate(
      { ...config, model: applyCredential(resolved.model, credential) },
      content,
      {
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
            case 'llm.failed.syntax':
            case 'llm.failed.remote': {
              failed = event.error;
              return;
            }
            case 'llm.request.retrying': {
              accumulator = createMessageAccumulator();
              usage = undefined;
              finish = undefined;
              messageId = undefined;
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
      },
    );

    if (failed !== undefined) {
      throw errorFromLlmMessage(failed);
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

function throwToEvent(inner: LlmRequester): LlmRequester {
  return {
    async generate(config, content, control) {
      try {
        await inner.generate(config, content, control);
      } catch (error) {
        if (isAbortError(error)) throw error;
        const message = llmMessageFromError(error);
        if (message === undefined) throw translateProviderError(error);
        control.onEvent?.({ type: 'llm.failed.remote', error: message });
      }
    },
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

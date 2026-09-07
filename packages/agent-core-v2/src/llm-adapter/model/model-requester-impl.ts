import * as fs from 'node:fs';
import * as nodePath from 'node:path';

import { AsyncEventQueue } from '#/_base/asyncEventQueue';
import type { LlmErrorMessage } from '#human/llm/errors';
import type { FinishInfo } from '#human/llm/finish-reason';
import type { ProviderMediaContribution, VideoUploadInput } from '#human/llm/media/upload';
import { createMessageAccumulator, type VideoURLPart } from '#human/llm/message';
import type { LlmModel } from '#human/llm/model';
import type { ProtocolName } from '#human/llm/protocol/base';
import { withEmptyResponseGuard } from '#human/llm/requester/empty-response';
import {
  mergeRequestHeaders,
  type ExtraParams,
  type LlmRequestConfig,
  type LlmRequestContent,
  type LlmRequestEvent,
  type LlmRequester,
} from '#human/llm/requester/requester';
import type { TokenUsage } from '#human/llm/usage';
import {
  withAuth,
  withAuthUpload,
  type CredentialSource,
} from '#human/kimi-oauth/credential-source';

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
}

export class ModelRequesterImpl implements ModelRequester {
  private cached: ResolvedLlmModel | undefined;
  private cachedRequester: LlmRequester | undefined;

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

  private requesterFor(resolved: ResolvedLlmModel): LlmRequester {
    if (this.cachedRequester === undefined) {
      this.cachedRequester = withEmptyResponseGuard(
        withAuth(throwToEvent(resolved.requester), this.credentialSource),
      );
    }
    return this.cachedRequester;
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
    const wrapped = withAuthUpload(uploader, this.credentialSource);
    return wrapped(video, { model: resolved.model, signal: options?.signal });
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

    let accumulator = createMessageAccumulator();
    let usage: TokenUsage | undefined;
    let finish: FinishInfo | undefined;
    let messageId: string | undefined;
    let traceId: string | null | undefined;
    let failed: LlmErrorMessage | undefined;

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

    await requester.generate(config, content, {
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
          case 'llm.headers': {
            traceId = traceIdFromHeadersRecord(event.headers);
            params?.onTraceId?.(traceId);
            return;
          }
          case 'llm.delta': {
            const arrivedAt = Date.now();
            if (firstChunkAt === undefined) {
              firstChunkAt = arrivedAt;
            } else {
              serverDecodeMs += arrivedAt - lastResumeAt;
            }
            accumulator.push(event.part);
            queue.push({ type: 'part', part: event.part });
            lastResumeAt = Date.now();
            clientConsumeMs += lastResumeAt - arrivedAt;
            return;
          }
          case 'llm.usage': {
            usage = mergeUsagePatch(usage, event.usage);
            return;
          }
          case 'llm.finish': {
            finish = event.finish;
            return;
          }
          case 'llm.message-id': {
            messageId = event.messageId;
            return;
          }
          case 'llm.failed.syntax':
          case 'llm.failed.remote': {
            failed = event.error;
            return;
          }
          case 'llm.done': {
            streamEndedAt = Date.now();
            if (firstChunkAt !== undefined) {
              serverDecodeMs += streamEndedAt - lastResumeAt;
            }
            return;
          }
        }
      },
    });

    if (failed !== undefined) {
      throw errorFromLlmMessage(failed);
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
      queue.push({
        type: 'timing',
        ...buildStreamTiming(requestStartedAt, requestSentAt, firstChunkAt, streamEndedAt, {
          serverDecodeMs,
          clientConsumeMs,
        }),
      });
    }
  }
}

function applyAuth(model: LlmModel, auth: ProviderRequestAuth | undefined): LlmModel {
  if (auth === undefined) return model;
  return {
    ...model,
    apiKey: auth.apiKey ?? model.apiKey,
    defaultHeaders: mergeRequestHeaders(model.defaultHeaders, auth.headers),
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
    case 'anthropic_beta':
      return { anthropic: { temperature, top_p: topP } };
    case 'google-genai':
    case 'google-vertex':
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
  }
  return timing;
}

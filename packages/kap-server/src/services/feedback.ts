import { createHash } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';

import type { FeedbackTurnContext, IOAuthService } from '@moonshot-ai/agent-core-v2';
import { abortable } from '@moonshot-ai/agent-core-v2/_base/utils/abort';
import {
  fetchCompleteFeedbackUpload,
  fetchCreateFeedbackUploadUrl,
  fetchSubmitFeedback,
  fetchUpdateFeedback,
  KIMI_CODE_PROVIDER_NAME,
  kimiCodeFeedbackUpdateUrl,
  kimiCodeFeedbackUrl,
  uploadArchive,
  type FeedbackUploadUrlApi,
} from '@moonshot-ai/kimi-code-oauth';

import type { CreateFeedbackRequest, UpdateFeedbackRequest } from '../protocol/rest-feedback';

const MAX_ATTACHMENT_SIZE = 524_288_000;

export class FeedbackRouteError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

export class ManagedFeedbackGateway {
  constructor(
    private readonly oauth: IOAuthService,
    private readonly baseUrl: () => string,
  ) {}

  async create(input: CreateFeedbackRequest, replyContext?: FeedbackTurnContext): Promise<number> {
    const accessToken = await this.accessToken();
    const result = await fetchSubmitFeedback(kimiCodeFeedbackUrl(this.baseUrl()), accessToken, {
      session_id: input.session_id,
      content: input.content,
      version: input.version,
      os: input.os,
      model: input.info.kind === 'reply' ? (replyContext?.model ?? null) : null,
      info: input.info.kind === 'reply'
        ? {
            ...input.info,
            trace_id: replyContext?.traceId,
            provider: replyContext?.provider,
            participant_models: replyContext?.participantModels,
          }
        : input.info,
    });
    if (result.kind === 'error') throw upstreamError(result);
    return result.feedbackId;
  }

  async update(input: UpdateFeedbackRequest): Promise<void> {
    const accessToken = await this.accessToken();
    const result = await fetchUpdateFeedback(kimiCodeFeedbackUpdateUrl(this.baseUrl()), accessToken, {
      feedback_id: input.feedback_id,
      content: input.content,
      info: input.info,
    });
    if (result.kind === 'error') throw upstreamError(result);
  }

  async upload(
    feedbackId: number,
    input: {
      readonly filename: string;
      readonly declaredSize: number;
      readonly bytes: AsyncIterable<Uint8Array>;
    },
    options: { readonly signal?: AbortSignal } = {},
  ): Promise<void> {
    const tempDir = await mkdtemp(join(tmpdir(), 'kimi-feedback-attachment-'));
    try {
      const path = join(tempDir, 'attachment');
      const staged = await stageBytes(input.bytes, path, options.signal);
      if (staged.size !== input.declaredSize) {
        throw new FeedbackRouteError('attachment size does not match x-feedback-file-size', 400);
      }
      options.signal?.throwIfAborted();
      await uploadArchive(this.uploadApi(() => this.accessToken(options.signal), this.baseUrl(), options.signal), staged, feedbackId, {
        filename: input.filename,
        maxRetries: 0,
        signal: options.signal,
      });
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  }

  private uploadApi(getAccessToken: () => Promise<string>, baseUrl: string, signal?: AbortSignal): FeedbackUploadUrlApi {
    return {
      createUploadUrl: async (input) => {
        const accessToken = await getAccessToken();
        const result = await fetchCreateFeedbackUploadUrl(accessToken, {
          file_hash: input.sha256,
          file_name: input.filename,
          file_size: input.size,
          feedback_id: input.feedbackId,
        }, { baseUrl, signal });
        if (result.kind === 'error') throw upstreamError(result);
        return {
          uploadId: result.upload_id,
          parts: result.parts.map((part) => ({
            partNumber: part.part_number,
            url: part.url,
            method: part.method,
            size: part.size,
          })),
        };
      },
      completeUpload: async (input) => {
        const accessToken = await getAccessToken();
        const result = await fetchCompleteFeedbackUpload(accessToken, {
          upload_id: input.uploadId,
          parts: input.parts.map((part) => ({ part_number: part.partNumber, etag: part.etag })),
        }, { baseUrl, signal });
        if (result.kind === 'error') throw upstreamError(result);
      },
    };
  }

  private async accessToken(signal?: AbortSignal): Promise<string> {
    const provider = this.oauth.resolveTokenProvider(KIMI_CODE_PROVIDER_NAME);
    if (provider === undefined) {
      throw new FeedbackRouteError('managed Kimi OAuth is unavailable', 502);
    }
    try {
      return await (signal === undefined
        ? provider.getAccessToken()
        : abortable(provider.getAccessToken(), signal));
    } catch (error) {
      signal?.throwIfAborted();
      throw new FeedbackRouteError(error instanceof Error ? error.message : String(error), 502);
    }
  }
}

async function stageBytes(
  bytes: AsyncIterable<Uint8Array>,
  path: string,
  signal?: AbortSignal,
): Promise<{ readonly path: string; readonly size: number; readonly sha256: string }> {
  const hash = createHash('sha256');
  let size = 0;
  const meter = new Transform({
    transform(chunk: Uint8Array, _encoding, callback) {
      size += chunk.byteLength;
      if (size > MAX_ATTACHMENT_SIZE) {
        callback(new FeedbackRouteError('attachment exceeds the 500 MiB limit', 413));
        return;
      }
      hash.update(chunk);
      callback(undefined, chunk);
    },
  });
  await pipeline(bytes, meter, createWriteStream(path, { flags: 'wx' }), { signal });
  return { path, size, sha256: hash.digest('hex') };
}

function upstreamError(result: { readonly status?: number; readonly message: string }): FeedbackRouteError {
  const status = result.status;
  const preserveStatus = status !== undefined && status >= 400 && status < 500 && status !== 401;
  return new FeedbackRouteError(result.message, preserveStatus ? status : 502);
}

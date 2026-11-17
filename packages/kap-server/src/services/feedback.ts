import { createHash } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';

import type { IOAuthService } from '@moonshot-ai/agent-core-v2';
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
    private readonly baseUrl: string | undefined,
  ) {}

  async create(input: CreateFeedbackRequest): Promise<number> {
    const accessToken = await this.accessToken();
    const result = await fetchSubmitFeedback(kimiCodeFeedbackUrl(this.baseUrl), accessToken, {
      session_id: input.session_id,
      content: input.content,
      version: input.version,
      os: input.os,
      model: null,
      info: input.info,
    });
    if (result.kind === 'error') throw upstreamError(result);
    return result.feedbackId;
  }

  async update(input: UpdateFeedbackRequest): Promise<void> {
    const accessToken = await this.accessToken();
    const result = await fetchUpdateFeedback(kimiCodeFeedbackUpdateUrl(this.baseUrl), accessToken, {
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
  ): Promise<void> {
    const accessToken = await this.accessToken();
    const tempDir = await mkdtemp(join(tmpdir(), 'kimi-feedback-attachment-'));
    try {
      const path = join(tempDir, 'attachment');
      const staged = await stageBytes(input.bytes, path);
      if (staged.size !== input.declaredSize) {
        throw new FeedbackRouteError('attachment size does not match x-feedback-file-size', 400);
      }
      await uploadArchive(this.uploadApi(accessToken), staged, feedbackId, {
        filename: input.filename,
        maxRetries: 0,
      });
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  }

  private uploadApi(accessToken: string): FeedbackUploadUrlApi {
    return {
      createUploadUrl: async (input) => {
        const result = await fetchCreateFeedbackUploadUrl(accessToken, {
          file_hash: input.sha256,
          file_name: input.filename,
          file_size: input.size,
          feedback_id: input.feedbackId,
        }, { baseUrl: this.baseUrl });
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
        const result = await fetchCompleteFeedbackUpload(accessToken, {
          upload_id: input.uploadId,
          parts: input.parts.map((part) => ({ part_number: part.partNumber, etag: part.etag })),
        }, { baseUrl: this.baseUrl });
        if (result.kind === 'error') throw upstreamError(result);
      },
    };
  }

  private async accessToken(): Promise<string> {
    const provider = this.oauth.resolveTokenProvider(KIMI_CODE_PROVIDER_NAME);
    if (provider === undefined) {
      throw new FeedbackRouteError('managed Kimi OAuth is unavailable', 502);
    }
    try {
      return await provider.getAccessToken();
    } catch (error) {
      throw new FeedbackRouteError(error instanceof Error ? error.message : String(error), 502);
    }
  }
}

async function stageBytes(
  bytes: AsyncIterable<Uint8Array>,
  path: string,
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
  await pipeline(bytes, meter, createWriteStream(path, { flags: 'wx' }));
  return { path, size, sha256: hash.digest('hex') };
}

function upstreamError(result: { readonly status?: number; readonly message: string }): FeedbackRouteError {
  const status = result.status;
  const preserveStatus = status !== undefined && status >= 400 && status < 500 && status !== 401;
  return new FeedbackRouteError(result.message, preserveStatus ? status : 502);
}

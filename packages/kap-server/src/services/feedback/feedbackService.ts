import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { pipeline } from 'node:stream/promises';

import {
  IBootstrapService,
  IOAuthService,
  IProviderService,
  MAIN_AGENT_ID,
  type Scope,
} from '@moonshot-ai/agent-core-v2';
import { uploadArchive } from '@moonshot-ai/agent-core-v2/app/auth/feedback/upload';
import {
  fetchCompleteFeedbackUpload,
  fetchCreateFeedbackUploadUrl,
  fetchSubmitFeedback,
  fetchUpdateFeedback,
  isManagedKimiCodeBaseUrl,
  KIMI_CODE_PROVIDER_NAME,
  kimiCodeFeedbackUrl,
  OAuthUnauthorizedError,
  type SubmitFeedbackBody,
} from '@moonshot-ai/kimi-code-oauth';
import type { z } from 'zod';

import { ErrorCode, type ErrorCode as FeedbackErrorCode } from '../../protocol/error-codes';
import type { createFeedbackSchema, updateFeedbackSchema } from '../../protocol/rest-feedback';
import type { ConversationService } from '../conversation/conversationService';

type CreateFeedback = z.infer<typeof createFeedbackSchema>;
type UpdateFeedback = z.infer<typeof updateFeedbackSchema>;
type FeedbackFile = { filename: string; path: string; size: number; sha256: string };

export class FeedbackError extends Error {
  constructor(readonly code: FeedbackErrorCode, message: string) {
    super(message);
  }
}

export async function requireFeedbackToken(core: Scope): Promise<string> {
  const oauth = core.accessor.get(IOAuthService);
  const tokenProvider = oauth.resolveTokenProvider(KIMI_CODE_PROVIDER_NAME);
  if (tokenProvider === undefined) {
    throw new FeedbackError(ErrorCode.AUTH_TOKEN_MISSING, 'Sign in to Kimi to send feedback.');
  }
  try {
    return await tokenProvider.getAccessToken();
  } catch (error) {
    if (error instanceof OAuthUnauthorizedError) {
      throw new FeedbackError(ErrorCode.AUTH_TOKEN_MISSING, 'Sign in to Kimi to send feedback.');
    }
    throw error;
  }
}

export async function openFeedbackGateway(core: Scope): Promise<FeedbackGateway> {
  const token = await requireFeedbackToken(core);
  const configuredUrl = core.accessor.get(IProviderService).get(KIMI_CODE_PROVIDER_NAME)?.baseUrl;
  const managedUrl = isManagedKimiCodeBaseUrl(configuredUrl) ? configuredUrl : undefined;
  const override = core.accessor.get(IBootstrapService).getEnv('KIMI_CODE_FEEDBACK_BASE_URL');
  return new FeedbackGateway(feedbackUrl(override ?? managedUrl), token);
}

export class FeedbackGateway {
  constructor(private readonly url: URL, private readonly token: string) {}

  async create(input: CreateFeedback, client: { kind: 'desktop' | 'web'; version: string; os: string }, conversations: ConversationService): Promise<number> {
    const info: Record<string, unknown> = input.kind === 'global'
      ? { kind: input.kind, source: input.source, category: input.category, upload_session: input.upload_session, upload_logs: input.upload_logs }
      : { kind: input.kind, source: 'rating', rating: input.rating, turn_id: input.turn_id, reply_id: input.reply_id };
    info['client'] = client.kind;
    let model: string | null = null;
    if (input.kind === 'turn') {
      const feed = await conversations.feed(input.session_id, MAIN_AGENT_ID);
      const turn = feed.feedbackTurn(input.turn_id, input.reply_id);
      if (turn === undefined) throw new FeedbackError(ErrorCode.TURN_NOT_FOUND, 'Feedback turn not found.');
      if (turn.requestId !== undefined) info['request_id'] = turn.requestId;
      if (turn.replyModel !== undefined) {
        model = turn.replyModel.model;
        info['model_id'] = model;
        info['provider'] = turn.replyModel.provider;
        if (turn.replyModel.isKfc !== undefined) info['is_kfc'] = turn.replyModel.isKfc;
      }
      if (turn.modelSteps !== undefined) {
        info['participating_models'] = turn.modelSteps.map(({ role, step, model, provider, isKfc }) => ({
          role, step, model_id: model, provider, is_kfc: isKfc,
        }));
      }
    }
    const body: SubmitFeedbackBody = {
      session_id: input.session_id,
      content: input.kind === 'global' ? input.content : 'null',
      version: client.version,
      os: client.os,
      model,
      info,
    };
    const result = await fetchSubmitFeedback(this.url.href, this.token, body, { redirect: 'error' });
    if (result.kind === 'error') throw gatewayError(result.status);
    return result.feedbackId;
  }

  async update(feedbackId: number, input: UpdateFeedback): Promise<void> {
    const result = await fetchUpdateFeedback(this.url.href, this.token, {
      feedback_id: feedbackId,
      content: input.kind === 'details' ? input.content : undefined,
      info: input.kind === 'details' ? { reasons: input.reasons, upload_session: input.upload_session } : { cancel: true },
    });
    if (result.kind === 'error') throw gatewayError(result.status);
  }

  async upload(feedbackId: number, file: FeedbackFile, signal?: AbortSignal): Promise<number> {
    const options = { feedbackUrl: this.url.href, redirect: 'error', signal } as const;
    return uploadArchive({
      createUploadUrl: async (input) => {
        const result = await fetchCreateFeedbackUploadUrl(this.token, {
          file_hash: input.sha256,
          file_name: input.filename,
          file_size: input.size,
          feedback_id: input.feedbackId,
        }, options);
        if (result.kind === 'error') throw gatewayError(result.status);
        return {
          uploadId: result.upload_id,
          parts: result.parts.map((part) => ({
            partNumber: part.part_number,
            method: part.method,
            url: this.uploadUrl(part.url, part.method),
            size: part.size,
          })),
        };
      },
      completeUpload: async (input) => {
        const result = await fetchCompleteFeedbackUpload(this.token, {
          upload_id: input.uploadId,
          parts: input.parts.map((part) => ({ part_number: part.partNumber, etag: part.etag })),
        }, options);
        if (result.kind === 'error') throw gatewayError(result.status);
      },
    }, file, feedbackId, { filename: file.filename, signal, redirect: 'error' });
  }

  private uploadUrl(raw: string, method: string): string {
    const url = new URL(raw);
    const allowed = url.protocol === 'https:' || url.origin === this.url.origin;
    if (!allowed || url.username || url.password || (method !== 'PUT' && method !== 'POST')) {
      throw new FeedbackError(ErrorCode.INTERNAL_ERROR, 'The feedback service returned an invalid upload URL.');
    }
    return url.href;
  }
}

export async function readFeedbackFile(filename: string, path: string, signal?: AbortSignal): Promise<FeedbackFile> {
  const { size } = await stat(path);
  if (size === 0) throw new FeedbackError(ErrorCode.VALIDATION_FAILED, 'The feedback attachment is empty.');
  const hash = createHash('sha256');
  await pipeline(createReadStream(path), hash, { signal });
  return { filename, path, size, sha256: hash.digest('hex') };
}

function feedbackUrl(base?: string): URL {
  const url = new URL(kimiCodeFeedbackUrl(base));
  const loopback = url.hostname === 'localhost' || url.hostname === '127.0.0.1' || url.hostname === '[::1]';
  if (
    (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback)) ||
    url.username || url.password || url.search || url.hash
  ) {
    throw new FeedbackError(ErrorCode.INTERNAL_ERROR, 'Invalid feedback service URL.');
  }
  return url;
}

function gatewayError(status?: number): FeedbackError {
  switch (status ?? 0) {
    case 400:
    case 422:
      return new FeedbackError(ErrorCode.VALIDATION_FAILED, 'The feedback service rejected the submitted data.');
    case 401:
    case 403:
      return new FeedbackError(ErrorCode.AUTH_TOKEN_UNAUTHORIZED, 'The feedback service did not authorize this operation.');
    case 404:
    case 409:
      return new FeedbackError(ErrorCode.FEEDBACK_REJECTED, 'The feedback is unavailable or can no longer be changed.');
    case 413:
      return new FeedbackError(ErrorCode.FILE_TOO_LARGE, 'The feedback attachment is too large.');
    default:
      return new FeedbackError(ErrorCode.INTERNAL_ERROR, 'The feedback service could not complete the request.');
  }
}

import { createWriteStream } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { arch, platform, release, tmpdir } from 'node:os';
import { join } from 'node:path';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';

import { ErrorCodes, ISessionExportService, isError2, type Scope } from '@moonshot-ai/agent-core-v2';
import { desktopFeedbackFlag } from '@moonshot-ai/agent-core-v2/app/auth/feedback/flag';
import { IFlagService } from '@moonshot-ai/agent-core-v2/app/flag/flag';
import { registerFlagDefinition } from '@moonshot-ai/agent-core-v2/app/flag/flagRegistry';
import type { KimiHostIdentity } from '@moonshot-ai/kimi-code-oauth';
import type { FastifyReply, FastifyRequest, RouteHandlerMethod } from 'fastify';

import { requestLog } from '../lib/requestLog';
import { defineRoute } from '../middleware/defineRoute';
import { errEnvelope, okEnvelope } from '../protocol/envelope';
import { ErrorCode } from '../protocol/error-codes';
import {
  createFeedbackSchema,
  feedbackAttachmentQuerySchema,
  feedbackAttachmentResponseSchema,
  feedbackParamsSchema,
  feedbackResponseSchema,
  feedbackSessionAttachmentSchema,
  updateFeedbackSchema,
} from '../protocol/rest-feedback';
import type { ConversationService } from '../services/conversation/conversationService';
import { FeedbackError, openFeedbackGateway, readFeedbackFile } from '../services/feedback/feedbackService';

const MIB = 1024 * 1024;
const VIDEO_LIMIT = 100 * MIB;
const IMAGE_LIMIT = 10 * MIB;
const ARCHIVE_LIMIT = 500 * MIB;

registerFlagDefinition(desktopFeedbackFlag);

const feedbackErrors = {
  [ErrorCode.VALIDATION_FAILED]: {},
  [ErrorCode.AUTH_TOKEN_MISSING]: {},
  [ErrorCode.AUTH_TOKEN_UNAUTHORIZED]: {},
  [ErrorCode.FEEDBACK_REJECTED]: {},
  [ErrorCode.INTERNAL_ERROR]: {},
};

type FeedbackRouteRegistration = (path: string, options: ReturnType<typeof defineRoute>['options'], handler: RouteHandlerMethod) => unknown;

export function registerFeedbackRoutes(
  app: { post: FeedbackRouteRegistration; patch: FeedbackRouteRegistration },
  core: Scope,
  options: { readonly hostIdentity: KimiHostIdentity; readonly conversations: ConversationService },
): void {
  const create = defineRoute({
    method: 'POST',
    path: '/feedback',
    body: createFeedbackSchema,
    success: { data: feedbackResponseSchema },
    errors: {
      ...feedbackErrors,
      [ErrorCode.SESSION_NOT_FOUND]: {},
      [ErrorCode.TURN_NOT_FOUND]: {},
    },
    description: 'Create global feedback or rate a completed assistant reply',
    tags: ['feedback'],
  }, async (req, reply) => {
    await withFeedback(req, reply, core, async () => {
      const gateway = await openFeedbackGateway(core);
      const kind = req.body.client ?? (req.headers['x-kimi-client-ui-mode'] === 'web' ? 'web' : 'desktop');
      const client = {
        kind,
        version: clientVersion(req.headers['x-kimi-client-version']) ?? options.hostIdentity.version,
        os: browserOs(req.headers['sec-ch-ua-platform'], req.headers['user-agent'])
          ?? (kind === 'web' ? 'unknown' : `${platform()} ${release()} ${arch()}`),
      };
      return { feedback_id: await gateway.create(req.body, client, options.conversations) };
    });
  });
  app.post(create.path, create.options, create.handler as RouteHandlerMethod);

  const update = defineRoute({
    method: 'PATCH',
    path: '/feedback/{feedback_id}',
    params: feedbackParamsSchema,
    body: updateFeedbackSchema,
    success: { data: feedbackResponseSchema },
    errors: feedbackErrors,
    description: 'Add details to a reply rating or cancel it',
    tags: ['feedback'],
  }, async (req, reply) => {
    await withFeedback(req, reply, core, async () => {
      const gateway = await openFeedbackGateway(core);
      await gateway.update(req.params.feedback_id, req.body);
      return { feedback_id: req.params.feedback_id };
    });
  });
  app.patch(update.path, update.options, update.handler as RouteHandlerMethod);

  const attachFile = defineRoute({
    method: 'POST',
    path: '/feedback/{feedback_id}/attachments',
    params: feedbackParamsSchema,
    querystring: feedbackAttachmentQuerySchema,
    success: { data: feedbackAttachmentResponseSchema },
    errors: { ...feedbackErrors, [ErrorCode.FILE_TOO_LARGE]: {} },
    consumes: ['multipart/form-data'],
    description: 'Upload one user-selected media file or an authorized desktop diagnostics archive',
    tags: ['feedback'],
  }, async (req, reply) => {
    await withFeedback(req, reply, core, async () => {
      const gateway = await openFeedbackGateway(core);
      return withAttachment(reply as FastifyReply, async (scratch, signal) => {
        const path = join(scratch, 'attachment');
        const filename = await receiveFile(req as FastifyRequest, req.query.kind, path, signal);
        const file = await readFeedbackFile(filename, path, signal);
        return { upload_id: await gateway.upload(req.params.feedback_id, file, signal) };
      });
    });
  });
  app.post(attachFile.path, attachFile.options, attachFile.handler as RouteHandlerMethod);

  const attachSession = defineRoute({
    method: 'POST',
    path: '/feedback/{feedback_id}/attachments/session',
    params: feedbackParamsSchema,
    body: feedbackSessionAttachmentSchema,
    success: { data: feedbackAttachmentResponseSchema },
    errors: {
      ...feedbackErrors,
      [ErrorCode.SESSION_NOT_FOUND]: {},
      [ErrorCode.FILE_TOO_LARGE]: {},
    },
    description: 'Export and upload an authorized session without global diagnostics',
    tags: ['feedback'],
  }, async (req, reply) => {
    await withFeedback(req, reply, core, async () => {
      const gateway = await openFeedbackGateway(core);
      return withAttachment(reply as FastifyReply, async (scratch, signal) => {
        const filename = 'session.zip';
        const path = join(scratch, filename);
        await core.accessor.get(ISessionExportService).export({
          sessionId: req.body.session_id,
          outputPath: path,
          includeGlobalLog: false,
          includeDesktopLog: false,
          version: options.hostIdentity.version,
        }, { signal });
        const file = await readFeedbackFile(filename, path, signal);
        if (file.size > ARCHIVE_LIMIT) throw fileTooLarge();
        return { upload_id: await gateway.upload(req.params.feedback_id, file, signal) };
      });
    });
  });
  app.post(attachSession.path, attachSession.options, attachSession.handler as RouteHandlerMethod);
}

async function withFeedback(
  req: { id: string },
  reply: { send(payload: unknown): unknown },
  core: Scope,
  operation: () => Promise<unknown>,
): Promise<void> {
  if (!core.accessor.get(IFlagService).enabled(desktopFeedbackFlag.id)) {
    reply.send(errEnvelope(ErrorCode.FEEDBACK_REJECTED, 'Desktop feedback is disabled.', req.id));
    return;
  }
  try {
    reply.send(okEnvelope(await operation(), req.id));
  } catch (error) {
    if (error instanceof FeedbackError) {
      reply.send(errEnvelope(error.code, error.message, req.id));
      return;
    }
    if (isError2(error) && [ErrorCodes.SESSION_NOT_FOUND, ErrorCodes.SESSION_EXPORT_NOT_FOUND, ErrorCodes.AGENT_NOT_FOUND].some((code) => error.code === code)) {
      reply.send(errEnvelope(ErrorCode.SESSION_NOT_FOUND, 'Feedback session not found.', req.id));
      return;
    }
    requestLog(req)?.warn({
      errorType: error instanceof Error ? error.name : typeof error,
      coreCode: isError2(error) ? error.code : undefined,
    }, 'Feedback request failed');
    reply.send(errEnvelope(ErrorCode.INTERNAL_ERROR, 'The feedback request failed.', req.id));
  }
}

async function withAttachment<T>(
  reply: FastifyReply,
  operation: (scratch: string, signal: AbortSignal) => Promise<T>,
): Promise<T> {
  const abort = new AbortController();
  const onClose = (): void => {
    if (!reply.raw.writableFinished) abort.abort();
  };
  reply.raw.once('close', onClose);
  let scratch: string | undefined;
  try {
    scratch = await mkdtemp(join(tmpdir(), 'kimi-feedback-'));
    return await operation(scratch, abort.signal);
  } finally {
    reply.raw.off('close', onClose);
    if (scratch !== undefined) {
      await rm(scratch, { recursive: true, force: true, maxRetries: 3 }).catch(() => {
        requestLog(reply.request)?.warn('Feedback attachment cleanup failed');
      });
    }
  }
}

async function receiveFile(
  req: FastifyRequest,
  kind: 'media' | 'diagnostics',
  target: string,
  signal: AbortSignal,
): Promise<string> {
  if (!req.isMultipart()) throw badFile();
  const { RequestFileTooLargeError, FilesLimitError, FieldsLimitError, PartsLimitError } = req.server.multipartErrors;
  let filename: string | undefined;
  try {
    for await (const part of req.parts({
      limits: { files: 1, fields: 0, parts: 2, fileSize: kind === 'media' ? VIDEO_LIMIT + 1 : ARCHIVE_LIMIT + 1 },
    })) {
      if (part.type !== 'file') throw badFile();
      if (part.fieldname !== 'file') {
        part.file.resume();
        throw badFile();
      }
      const limit = attachmentLimit(kind, part.mimetype);
      if (limit === undefined) {
        part.file.resume();
        throw new FeedbackError(ErrorCode.VALIDATION_FAILED, 'Unsupported feedback attachment type.');
      }
      filename = safeFilename(part.filename);
      await pipeline(part.file, limitBytes(limit), createWriteStream(target, { flags: 'wx' }), { signal });
      if (part.file.truncated) throw fileTooLarge();
    }
  } catch (error) {
    if (error instanceof RequestFileTooLargeError) throw fileTooLarge();
    if (error instanceof FilesLimitError || error instanceof FieldsLimitError || error instanceof PartsLimitError) {
      throw badFile();
    }
    throw error;
  }
  if (filename === undefined) throw badFile();
  return filename;
}

function clientVersion(header: unknown): string | undefined {
  if (typeof header !== 'string') return undefined;
  const version = header.trim();
  return version.length > 0 && version.length <= 128 ? version : undefined;
}

function browserOs(hint: unknown, userAgent: unknown): string | undefined {
  const reported = typeof hint === 'string' ? /^"(Android|Chrome OS|Chromium OS|iOS|Linux|macOS|Windows)"$/.exec(hint)?.[1] : undefined;
  if (reported !== undefined || typeof userAgent !== 'string') return reported;
  if (/iPhone|iPad|iPod/.test(userAgent)) return 'iOS';
  if (userAgent.includes('Android')) return 'Android';
  if (userAgent.includes('CrOS')) return 'Chrome OS';
  if (userAgent.includes('Windows')) return 'Windows';
  if (userAgent.includes('Mac OS X')) return 'macOS';
  if (userAgent.includes('Linux')) return 'Linux';
}

function safeFilename(filename: string): string {
  const name = filename.split(/[\\/]/).at(-1)?.trim() ?? '';
  const clean = name.replaceAll(/[\u0000-\u001F\u007F]/g, '').slice(0, 200);
  return clean === '.' || clean === '..' || clean === '' ? 'attachment' : clean;
}

function attachmentLimit(kind: 'media' | 'diagnostics', mime: string): number | undefined {
  if (kind === 'diagnostics') return mime === 'application/zip' ? ARCHIVE_LIMIT : undefined;
  if (mime.startsWith('image/')) return IMAGE_LIMIT;
  if (mime.startsWith('video/')) return VIDEO_LIMIT;
  return undefined;
}

function limitBytes(limit: number): Transform {
  let total = 0;
  return new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      total += chunk.length;
      if (total > limit) callback(fileTooLarge());
      else callback(null, chunk);
    },
  });
}

function badFile(): FeedbackError {
  return new FeedbackError(ErrorCode.VALIDATION_FAILED, 'Send exactly one multipart file named file.');
}

function fileTooLarge(): FeedbackError {
  return new FeedbackError(ErrorCode.FILE_TOO_LARGE, 'The feedback attachment is too large.');
}

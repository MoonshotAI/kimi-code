import { createReadStream, createWriteStream } from 'node:fs';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { arch, platform, release, tmpdir } from 'node:os';
import { join } from 'node:path';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';

import { ErrorCodes, type FeedbackAttachmentUploadEvent, IFileService, ISessionExportService, ITelemetryService, isError2, type Scope } from '@moonshot-ai/agent-core-v2';
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
  feedbackSessionArchiveResponseSchema,
  feedbackSessionArchiveSchema,
  feedbackSessionAttachmentSchema,
  updateFeedbackSchema,
} from '../protocol/rest-feedback';
import type { ConversationService } from '../services/conversation/conversationService';
import {
  classifyFeedbackUploadError,
  FeedbackError,
  feedbackSizeBucket,
  openFeedbackGateway,
  readFeedbackFile,
  requireFeedbackToken,
} from '../services/feedback/feedbackService';
import { FEEDBACK_ARCHIVE_LIMIT, fetchRemoteFeedbackArchive } from '../services/feedback/sessionArchive';
import type { HostBridgeManager } from '../services/hosts/hostBridgeManager';

const MIB = 1024 * 1024;
const VIDEO_LIMIT = 100 * MIB;
const IMAGE_LIMIT = 10 * MIB;
const ARCHIVE_TTL_SECONDS = 24 * 60 * 60;

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
  options: { readonly hostIdentity: KimiHostIdentity; readonly conversations: ConversationService; readonly hostBridges: HostBridgeManager },
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
    await withFeedback(req, reply, async () => {
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
    await withFeedback(req, reply, async () => {
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
    const kind = req.query.kind;
    await withFeedback(req, reply, () =>
      uploadWithTelemetry(core, reply as FastifyReply, { feedbackId: req.params.feedback_id, kind }, async (scratch, signal) => {
        const path = join(scratch, 'attachment');
        const filename = await receiveFile(req as FastifyRequest, kind, path, signal);
        return { filename, path };
      }),
    );
  });
  app.post(attachFile.path, attachFile.options, attachFile.handler as RouteHandlerMethod);

  async function exportSession(sessionId: string, outputPath: string, signal: AbortSignal, onSize?: (size: number) => void): Promise<void> {
    await core.accessor.get(ISessionExportService).export({
      sessionId, outputPath, includeGlobalLog: false, includeDesktopLog: false, version: options.hostIdentity.version,
    }, { signal });
    const { size } = await stat(outputPath);
    onSize?.(size);
    if (size > FEEDBACK_ARCHIVE_LIMIT) throw fileTooLarge();
  }

  const sessionErrors = { ...feedbackErrors, [ErrorCode.SESSION_NOT_FOUND]: {}, [ErrorCode.FILE_TOO_LARGE]: {} };
  const prepareSession = defineRoute({
    method: 'POST',
    path: '/feedback/session-archives',
    body: feedbackSessionArchiveSchema,
    success: { data: feedbackSessionArchiveResponseSchema },
    errors: sessionErrors,
    description: 'Prepare an expiring session-only archive for a feedback attachment on another host',
    tags: ['feedback'],
  }, async (req, reply) => {
    await withFeedback(req, reply, async () => {
      await requireFeedbackToken(core);
      return withAttachment(reply as FastifyReply, async (scratch, signal) => {
        const path = join(scratch, 'session.zip');
        await exportSession(req.body.session_id, path, signal);
        const files = core.accessor.get(IFileService);
        const meta = await files.save(createReadStream(path, { signal }), 'session.zip', {
          mimeType: 'application/zip', expiresInSec: ARCHIVE_TTL_SECONDS,
        });
        if (signal.aborted) {
          await files.delete(meta.id);
          signal.throwIfAborted();
        }
        return { file_id: meta.id, size: meta.size };
      });
    });
  });
  app.post(prepareSession.path, prepareSession.options, prepareSession.handler as RouteHandlerMethod);

  const attachSession = defineRoute({
    method: 'POST',
    path: '/feedback/{feedback_id}/attachments/session',
    params: feedbackParamsSchema,
    body: feedbackSessionAttachmentSchema,
    success: { data: feedbackAttachmentResponseSchema },
    errors: sessionErrors,
    description: 'Export and upload an authorized session without global diagnostics',
    tags: ['feedback'],
  }, async (req, reply) => {
    const { session_id: sessionId, host_id: hostId } = req.body;
    await withFeedback(req, reply, () =>
      uploadWithTelemetry(core, reply as FastifyReply, {
        feedbackId: req.params.feedback_id,
        kind: 'session',
        sessionId,
        hostKind: hostId === undefined ? 'local' : 'ssh',
      }, async (scratch, signal, onSize) => {
        const filename = 'session.zip';
        const path = join(scratch, filename);
        if (hostId === undefined) {
          await exportSession(sessionId, path, signal, onSize);
        } else {
          const host = await options.hostBridges.connect(hostId);
          await fetchRemoteFeedbackArchive(host, sessionId, path, signal);
          onSize((await stat(path)).size);
        }
        return { filename, path };
      }),
    );
  });
  app.post(attachSession.path, attachSession.options, attachSession.handler as RouteHandlerMethod);
}

interface AttachmentUploadTrace {
  stage: 'export' | 'presign' | 'upload' | 'complete';
  sizeBytes?: number;
  partCount?: number;
  aborted: boolean;
}

async function uploadWithTelemetry(
  core: Scope,
  reply: FastifyReply,
  meta: {
    feedbackId: number;
    kind: 'session' | 'diagnostics' | 'media';
    sessionId?: string;
    hostKind?: 'local' | 'ssh';
  },
  produce: (scratch: string, signal: AbortSignal, onSize: (size: number) => void) => Promise<{ filename: string; path: string }>,
): Promise<{ upload_id: number }> {
  const startedAt = Date.now();
  const rootTelemetry = core.accessor.get(ITelemetryService);
  const telemetry = meta.sessionId === undefined ? rootTelemetry : rootTelemetry.withContext({ session_id: meta.sessionId });
  const trace: AttachmentUploadTrace = { stage: 'export', aborted: false };
  const properties = () => ({
    emitter: 'server' as const,
    attachment_kind: meta.kind,
    stage: trace.stage,
    duration_ms: Date.now() - startedAt,
    feedback_id: meta.feedbackId,
    ...(meta.hostKind === undefined ? {} : { host_kind: meta.hostKind }),
    ...(trace.sizeBytes === undefined ? {} : { size_bytes: trace.sizeBytes, size_bucket: feedbackSizeBucket(trace.sizeBytes) }),
    ...(trace.partCount === undefined ? {} : { part_count: trace.partCount }),
  });
  try {
    const gateway = await openFeedbackGateway(core);
    return await withAttachment(reply, async (scratch, signal) => {
      signal.addEventListener('abort', () => { trace.aborted = true; }, { once: true });
      const { filename, path } = await produce(scratch, signal, (size) => { trace.sizeBytes = size; });
      const file = await readFeedbackFile(filename, path, signal);
      trace.sizeBytes = file.size;
      const uploadId = await gateway.upload(meta.feedbackId, file, signal, (stage, partCount) => {
        trace.stage = stage;
        if (partCount !== undefined) trace.partCount = partCount;
      });
      const succeeded: FeedbackAttachmentUploadEvent = { ...properties(), outcome: 'succeeded', upload_id: uploadId };
      telemetry.track2('feedback_attachment_upload', succeeded);
      return { upload_id: uploadId };
    });
  } catch (error) {
    const outcome = trace.aborted ? ('aborted' as const) : ('failed' as const);
    const failed: FeedbackAttachmentUploadEvent = { ...properties(), outcome, ...classifyFeedbackUploadError(error) };
    telemetry.track2('feedback_attachment_upload', failed);
    throw error;
  }
}

async function withFeedback(
  req: { id: string },
  reply: { send(payload: unknown): unknown },
  operation: () => Promise<unknown>,
): Promise<void> {
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
      limits: { files: 1, fields: 0, parts: 2, fileSize: kind === 'media' ? VIDEO_LIMIT + 1 : FEEDBACK_ARCHIVE_LIMIT + 1 },
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
  if (kind === 'diagnostics') return mime === 'application/zip' ? FEEDBACK_ARCHIVE_LIMIT : undefined;
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

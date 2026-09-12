import multipart from '@fastify/multipart';

import {
  ErrorCodes,
  IFileService,
  Error2,
  type Scope,
} from '@moonshot-ai/agent-core-v2';
import { z } from 'zod';

import { parseRangeHeader, pickHeader } from '../lib/httpRange';
import { requestLog } from '../lib/requestLog';
import { buildContentDisposition } from '../lib/contentDisposition';
import { defineRoute } from '../middleware/defineRoute';
import { ErrorCode } from '../protocol/error-codes';
import { errEnvelope, okEnvelope } from '../protocol/envelope';
import {
  deleteFileParamSchema,
  deleteFileResponseSchema,
  getFileParamSchema,
  uploadFileResponseSchema,
} from '../protocol/rest-file';

interface FilesRouteHost {
  register(plugin: unknown, opts?: unknown): unknown;
  post(
    path: string,
    options: { schema?: Record<string, unknown> },
    handler: (req: FastifyRequestLike, reply: FilesReply) => unknown,
  ): unknown;
  get(
    path: string,
    options: { preHandler: unknown[]; schema?: Record<string, unknown> },
    handler: (req: FastifyRequestLike, reply: FilesReply) => unknown,
  ): unknown;
  delete(
    path: string,
    options: { preHandler: unknown[]; schema?: Record<string, unknown> },
    handler: (req: FastifyRequestLike, reply: FilesReply) => unknown,
  ): unknown;
}

interface FastifyRequestLike {
  id: string;
  params: unknown;
  headers: Record<string, string | string[] | undefined>;
  file?: (opts?: unknown) => Promise<MultipartFileLike | undefined>;
}

interface MultipartFileLike {
  file: NodeJS.ReadableStream;
  filename: string;
  mimetype: string;
  fields: Record<string, unknown>;
}

interface FilesReply {
  type(mime: string): FilesReply;
  header(name: string, value: string | number): FilesReply;
  code(status: number): FilesReply;
  send(payload: unknown): unknown;
}

export function registerFilesRoutes(app: FilesRouteHost, core: Scope): void {
  app.register(multipart, {
    limits: {
      fileSize: Number.MAX_SAFE_INTEGER,
      files: 1,
    },
  });

  const uploadRoute = defineRoute(
    {
      method: 'POST',
      path: '/files',
      success: { data: uploadFileResponseSchema },
      consumes: ['multipart/form-data'],
      description: 'Upload a file',
      tags: ['files'],
    },
    async (req, reply) => {
      try {
        const fastifyReq = req as unknown as FastifyRequestLike;
        if (!fastifyReq.file) {
          reply.send(errEnvelope(ErrorCode.VALIDATION_FAILED, 'multipart not initialized', req.id));
          return;
        }
        const part = await fastifyReq.file();
        if (!part) {
          reply.send(errEnvelope(ErrorCode.VALIDATION_FAILED, 'missing `file` field', req.id));
          return;
        }

        const nameOverride = readFieldString(part.fields['name']);
        const expiresInSec = readFieldNumber(part.fields['expires_in_sec']);

        const store = core.accessor.get(IFileService);

        try {
          const meta = await store.save(
            part.file as unknown as import('node:stream').Readable,
            part.filename,
            {
              name: nameOverride ?? part.filename,
              mimeType: part.mimetype,
              expiresInSec,
            },
          );
          reply.send(okEnvelope(meta, req.id));
        } catch (error) {
          sendMappedError(reply as unknown as FilesReply, req, error);
        }
      } catch (error) {
        sendMappedError(reply as unknown as FilesReply, req, error);
      }
    },
  );
  app.post(
    uploadRoute.path,
    uploadRoute.options,
    uploadRoute.handler as unknown as Parameters<FilesRouteHost['post']>[2],
  );

  const downloadRoute = defineRoute(
    {
      method: 'GET',
      path: '/files/{file_id}',
      params: getFileParamSchema,
      rawResponse: {
        200: { type: 'string', format: 'binary' },
      },
      errors: {
        [ErrorCode.FILE_NOT_FOUND]: {},
      },
      description: 'Download a file by ID',
      tags: ['files'],
    },
    async (req, reply) => {
      try {
        const { file_id } = req.params;
        const store = core.accessor.get(IFileService);
        const file = await store.get(file_id);
        const r = reply as unknown as FilesReply;
        const { meta } = file;
        const size = meta.size;
        r.type(meta.media_type)
          .header('content-disposition', buildContentDisposition(meta.name, meta.media_type))
          .header('accept-ranges', 'bytes')
          .header('etag', `"${meta.id}-${size}"`);

        // Browsers load <video>/<audio> via byte-range requests (Range: bytes=…).
        // Without 206 Partial Content + Content-Range the media stalls at 0:00
        // and refuses to play or seek, so honor Range when the client sends one.
        const range = parseRangeHeader(pickHeader(req.headers, 'range'), size);
        if (range !== null) {
          r.header('content-range', `bytes ${range.start}-${range.end}/${size}`)
            .header('content-length', range.length)
            .code(206);
          return r.send(file.stream(range)) as unknown as void;
        }

        r.header('content-length', size).code(200);
        return r.send(file.stream()) as unknown as void;
      } catch (error) {
        sendMappedError(reply as unknown as FilesReply, req, error);
        return;
      }
    },
  );
  app.get(
    downloadRoute.path,
    downloadRoute.options,
    downloadRoute.handler as unknown as Parameters<FilesRouteHost['get']>[2],
  );

  const deleteRoute = defineRoute(
    {
      method: 'DELETE',
      path: '/files/{file_id}',
      params: deleteFileParamSchema,
      success: { data: deleteFileResponseSchema },
      description: 'Delete a file by ID',
      tags: ['files'],
    },
    async (req, reply) => {
      try {
        const { file_id } = req.params;
        const store = core.accessor.get(IFileService);
        await store.delete(file_id);
        requestLog(req)?.info({ file_id }, 'file deleted');
        reply.send(okEnvelope({ deleted: true as const }, req.id));
      } catch (error) {
        sendMappedError(reply as unknown as FilesReply, req, error);
      }
    },
  );
  app.delete(
    deleteRoute.path,
    deleteRoute.options,
    deleteRoute.handler as unknown as Parameters<FilesRouteHost['delete']>[2],
  );
}

function sendMappedError(reply: FilesReply, req: { id: string }, err: unknown): void {
  const requestId = req.id;
  if (err instanceof Error2 && err.code === ErrorCodes.FILE_NOT_FOUND) {
    reply.code(404).send(errEnvelope(ErrorCode.FILE_NOT_FOUND, 'file not found', requestId));
    return;
  }
  requestLog(req)?.error({ err }, 'file request failed');
  reply
    .code(500)
    .send(
      errEnvelope(
        ErrorCode.INTERNAL_ERROR,
        err instanceof Error ? err.message : 'internal error',
        requestId,
      ),
    );
}

const fieldValueSchema = z.object({ value: z.unknown() });

function readFieldString(field: unknown): string | undefined {
  const parsed = fieldValueSchema.safeParse(field);
  if (!parsed.success) return undefined;
  const v = parsed.data.value;
  return typeof v === 'string' && v.length > 0 ? v : undefined;
}

function readFieldNumber(field: unknown): number | undefined {
  const parsed = fieldValueSchema.safeParse(field);
  if (!parsed.success) return undefined;
  const v = parsed.data.value;
  if (typeof v === 'number' && Number.isFinite(v) && v >= 0) return Math.floor(v);
  if (typeof v === 'string') {
    const n = Number(v);
    if (Number.isFinite(n) && n >= 0) return Math.floor(n);
  }
  return undefined;
}

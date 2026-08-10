/**
 * `/files/*` REST routes — multipart upload, binary download, and delete.
 *
 *   POST   /files            upload a file (multipart/form-data) → FileMeta
 *   GET    /files/{file_id}  download a file (binary stream)
 *   DELETE /files/{file_id}  delete a file → { deleted: true }
 *
 * Backed by the host-owned `FileBlobStore` (stage 3b), which stores bytes on
 * disk under `<home>/server/files` with a JSON metadata index alongside them.
 * Mirrors the v1 server's wire behavior (envelope codes 40407 / 41301, 50 MiB
 * cap, content-disposition). The v2 `IFileService` backend was retired with
 * the v2 engine.
 */

import multipart from '@fastify/multipart';

import { z } from 'zod';

import { parseRangeHeader, pickHeader } from '../lib/httpRange';
import { requestLog } from '../lib/requestLog';
import { defineRoute } from '../middleware/defineRoute';
import { ErrorCode } from '../protocol/error-codes';
import { errEnvelope, okEnvelope } from '../protocol/envelope';
import type { FileBlobStore } from '../services/fileBlobStore';
import {
  deleteFileParamSchema,
  deleteFileResponseSchema,
  getFileParamSchema,
  uploadFileResponseSchema,
} from '../protocol/rest-file';

/** Upload cap, matching the v1 server's 50 MiB limit. Localized from
 *  `agent-core-v2/app/file/fileService.ts` (`DEFAULT_MAX_UPLOAD_BYTES`). */
const DEFAULT_MAX_UPLOAD_BYTES = 50 * 1024 * 1024;

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

export function registerFilesRoutes(
  app: FilesRouteHost,
  fileBlobStore: FileBlobStore,
): void {
  app.register(multipart, {
    limits: {
      fileSize: DEFAULT_MAX_UPLOAD_BYTES,
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

        const partFile = part.file as NodeJS.ReadableStream & { truncated?: boolean };
        let busboyTruncated = false;
        partFile.on('limit', () => {
          busboyTruncated = true;
        });
        try {
          // Stage 3b: host-owned blob store — no v2 IFileService.
          const meta = await fileBlobStore.save(
            partFile as unknown as import('node:stream').Readable,
            part.filename,
            {
              name: nameOverride ?? part.filename,
              mimeType: part.mimetype,
              expiresInSec,
            },
          );
          if (busboyTruncated || partFile.truncated === true) {
            await fileBlobStore.delete(meta.id);
            (reply as unknown as FilesReply)
              .code(413)
              .send(errEnvelope(ErrorCode.FILE_TOO_LARGE, 'upload too large (>50MB)', req.id));
            return;
          }
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
        // Stage 3b: host-owned blob store.
        const meta = await fileBlobStore.getMeta(file_id);
        if (meta === undefined) {
          const r = reply as unknown as FilesReply;
          r.code(404).send(
            errEnvelope(ErrorCode.FILE_NOT_FOUND, `file ${file_id} does not exist`, req.id),
          );
          return;
        }
        const r = reply as unknown as FilesReply;
        const etag = `"${meta.id}-${meta.size}"`;
        const headers = req.headers;

        const ifNoneMatch = pickHeader(headers, 'if-none-match');
        if (ifNoneMatch !== undefined && ifNoneMatch === etag) {
          r.code(304).header('etag', etag).send('');
          return;
        }

        r.header('etag', etag);
        r.header('accept-ranges', 'bytes');
        r.header('content-disposition', buildContentDisposition(meta.name, meta.media_type));
        r.type(meta.media_type);

        const rangeHeader = pickHeader(headers, 'range');
        const range = parseRangeHeader(rangeHeader, meta.size);
        if (range !== null) {
          r.code(206)
            .header('content-length', String(range.length))
            .header('content-range', `bytes ${range.start}-${range.end}/${meta.size}`);
          const stream = fileBlobStore.stream(file_id, { start: range.start, end: range.end });
          stream.on('error', (error: unknown) => {
            requestLog(req)?.warn({ file_id, err: error }, 'file download stream error');
            stream.destroy();
          });
          return r.send(stream) as unknown as void;
        }

        r.code(200).header('content-length', String(meta.size));
        const stream = fileBlobStore.stream(file_id);
        stream.on('error', (error: unknown) => {
          requestLog(req)?.warn({ file_id, err: error }, 'file download stream error');
          stream.destroy();
        });
        return r.send(stream) as unknown as void;
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
        const deleted = await fileBlobStore.delete(file_id);
        if (!deleted) {
          const r = reply as unknown as FilesReply;
          r.code(404).send(
            errEnvelope(ErrorCode.FILE_NOT_FOUND, `file ${file_id} does not exist`, req.id),
          );
          return;
        }
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
  if (
    typeof err === 'object' &&
    err !== null &&
    'name' in err &&
    (err as { name: string }).name === 'FST_REQ_FILE_TOO_LARGE'
  ) {
    reply.code(413).send(errEnvelope(ErrorCode.FILE_TOO_LARGE, 'upload too large (>50MB)', requestId));
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

function buildContentDisposition(name: string, mediaType?: string): string {
  const disposition = /^(image|video|audio)\//.test(mediaType ?? '') ? 'inline' : 'attachment';
  if (/^[\w. ()+[\]-]+$/.test(name)) {
    return `${disposition}; filename="${name}"`;
  }
  return disposition;
}

/**
 * `/files/*` REST routes — multipart upload, binary download, and delete.
 *
 *   POST   /files            upload a file (multipart/form-data) → FileMeta
 *   GET    /files/{file_id}  download a file (binary stream)
 *   DELETE /files/{file_id}  delete a file → { deleted: true }
 *
 * Backed by the v2 `IFileService` (Core scope), which stores bytes in
 * `IBlobStore` and the metadata index alongside them. Mirrors the v1 server's
 * wire behavior (envelope codes 40407 / 41301, 50 MiB cap, content-disposition)
 * but resolves the store through `core.accessor.get`.
 */

import multipart from '@fastify/multipart';

import {
  DEFAULT_MAX_UPLOAD_BYTES,
  ErrorCodes,
  IFileService,
  Error2,
  type Scope,
} from '@moonshot-ai/agent-core-v2';
import {
  ErrorCode,
  deleteFileParamSchema,
  deleteFileResponseSchema,
  errEnvelope,
  getFileParamSchema,
  okEnvelope,
  uploadFileResponseSchema,
} from '@moonshot-ai/protocol';
import { z } from 'zod';

import { defineRoute } from '../middleware/defineRoute';

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

        const store = core.accessor.get(IFileService);

        const partFile = part.file as NodeJS.ReadableStream & { truncated?: boolean };
        let busboyTruncated = false;
        partFile.on('limit', () => {
          busboyTruncated = true;
        });
        try {
          const meta = await store.save(
            partFile as unknown as import('node:stream').Readable,
            part.filename,
            {
              name: nameOverride ?? part.filename,
              mimeType: part.mimetype,
              expiresInSec,
            },
          );
          if (busboyTruncated || partFile.truncated === true) {
            try {
              await store.delete(meta.id);
            } catch {
              // best-effort cleanup of the truncated blob
            }
            sendMappedError(reply as unknown as FilesReply, req.id, new Error2(
              ErrorCodes.FILE_TOO_LARGE,
              `upload size exceeds limit ${DEFAULT_MAX_UPLOAD_BYTES} bytes`,
            ));
            return;
          }
          reply.send(okEnvelope(meta, req.id));
        } catch (error) {
          sendMappedError(reply as unknown as FilesReply, req.id, error);
        }
      } catch (error) {
        sendMappedError(reply as unknown as FilesReply, req.id, error);
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
        const range = parseRange(
          readRangeHeader((req as unknown as FastifyRequestLike).headers['range']),
          size,
        );
        if (range) {
          r.header('content-range', `bytes ${range.start}-${range.end}/${size}`)
            .header('content-length', range.end - range.start + 1)
            .code(206);
          return r.send(file.stream(range)) as unknown as void;
        }

        r.header('content-length', size).code(200);
        return r.send(file.stream()) as unknown as void;
      } catch (error) {
        sendMappedError(reply as unknown as FilesReply, req.id, error);
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
        reply.send(okEnvelope({ deleted: true as const }, req.id));
      } catch (error) {
        sendMappedError(reply as unknown as FilesReply, req.id, error);
      }
    },
  );
  app.delete(
    deleteRoute.path,
    deleteRoute.options,
    deleteRoute.handler as unknown as Parameters<FilesRouteHost['delete']>[2],
  );
}

function sendMappedError(reply: FilesReply, requestId: string, err: unknown): void {
  if (err instanceof Error2 && err.code === ErrorCodes.FILE_NOT_FOUND) {
    reply.code(404).send(errEnvelope(ErrorCode.FILE_NOT_FOUND, 'file not found', requestId));
    return;
  }
  if (err instanceof Error2 && err.code === ErrorCodes.FILE_TOO_LARGE) {
    reply.code(413).send(errEnvelope(ErrorCode.FILE_TOO_LARGE, 'upload too large (>50MB)', requestId));
    return;
  }
  if (
    typeof err === 'object' &&
    err !== null &&
    'name' in err &&
    (err as { name: string }).name === 'FST_REQ_FILE_TOO_LARGE'
  ) {
    reply.code(413).send(errEnvelope(ErrorCode.FILE_TOO_LARGE, 'upload too large (>50MB)', requestId));
    return;
  }
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

function readRangeHeader(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

function buildContentDisposition(name: string, mediaType?: string): string {
  const disposition = /^(image|video|audio)\//.test(mediaType ?? '') ? 'inline' : 'attachment';
  if (/^[\w. ()+[\]-]+$/.test(name)) {
    return `${disposition}; filename="${name}"`;
  }
  return disposition;
}

interface ByteRange {
  start: number;
  end: number;
}

/** Parse a `Range: bytes=start-end` header against the file size. Returns
 *  undefined for a missing / malformed / unsatisfiable range, in which case the
 *  caller serves the whole file with 200 (browsers accept that response). */
function parseRange(header: string | undefined, size: number): ByteRange | undefined {
  if (!header || size <= 0) return undefined;
  const m = /^bytes=(\d*)-(\d*)$/i.exec(header.trim());
  if (!m) return undefined;
  const startStr = m[1]!;
  const endStr = m[2]!;
  if (startStr === '' && endStr === '') return undefined;

  let start: number;
  let end: number;
  if (startStr === '') {
    // Suffix range: `bytes=-N` -> the last N bytes.
    const suffix = Number(endStr);
    if (!Number.isFinite(suffix) || suffix <= 0) return undefined;
    start = Math.max(size - suffix, 0);
    end = size - 1;
  } else {
    start = Number(startStr);
    if (!Number.isFinite(start) || start < 0 || start >= size) return undefined;
    end = endStr === '' ? size - 1 : Number(endStr);
    if (!Number.isFinite(end) || end < 0) return undefined;
  }
  if (start > end) return undefined;
  return { start, end: Math.min(end, size - 1) };
}

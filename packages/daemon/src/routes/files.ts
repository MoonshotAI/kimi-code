/**
 * `/files*` REST routes.
 *
 * Three endpoints:
 *
 *   POST   /files            multipart upload → FileMeta envelope
 *   GET    /files/{file_id}  binary stream (NO envelope) or 40407 envelope
 *   DELETE /files/{file_id}  `{deleted: true}` envelope
 *
 * **`@fastify/multipart` registration**: this module registers the
 * plugin against the captured Fastify instance on first call. The
 * plugin attaches `req.file()` / `req.parts()` to the request prototype.
 * We use `req.file()` to get the FIRST file field (the spec says the
 * `file` field is required).
 *
 * **Size cap enforcement**: we let `@fastify/multipart`'s `fileSize`
 * limit do the initial gate (busboy aborts the file stream when the
 * limit trips, raising `RequestFileTooLargeError`). `IFileStore.save`
 * does a second-layer check by tracking bytes during the write, so even
 * if the multipart layer's limit is misconfigured we still catch the
 * overrun. Cap is 50 MB (`DEFAULT_MAX_UPLOAD_BYTES`).
 *
 * **GET architectural exception**: REST.md §3.10 line 691 — the
 * download endpoint is the ONLY endpoint in the daemon that does NOT
 * use the envelope. Success: raw octet-stream + Content-Disposition +
 * ETag + Content-Length. 404: regular JSON envelope (clients
 * distinguish by `Content-Type`).
 *
 * **Anti-corruption**: route resolves `IFileStore` via the DI accessor;
 * zero SDK imports.
 */

import { createReadStream } from 'node:fs';

import multipart from '@fastify/multipart';

import {
  ErrorCode,
  deleteFileParamSchema,
  deleteFileResponseSchema,
  getFileParamSchema,
  uploadFileResponseSchema,
} from '@moonshot-ai/protocol';
import { z } from 'zod';

import type { IInstantiationService } from '@moonshot-ai/agent-core';

import { errEnvelope, okEnvelope } from '../envelope';
import { defineRoute } from '../middleware/defineRoute';
import {
  DEFAULT_MAX_UPLOAD_BYTES,
  FileNotFoundError,
  FileTooLargeError,
  IFileStore,
} from '#/services/fileStore';

/**
 * Structural Fastify-route host for the files family. Mirrors the
 * `fs.ts` / `tasks.ts` patterns: we narrow to the methods we actually
 * use to avoid pulling in heavy Fastify generics.
 *
 * `get` return type is widened to `Promise<unknown> | unknown` so
 * `return reply.send(stream)`
 * propagates without violating the declared return type.
 */
interface FilesRouteHost {
  register(plugin: unknown, opts?: unknown): unknown;
  post(
    path: string,
    options: { schema?: Record<string, unknown> },
    handler: (
      req: FastifyRequestLike,
      reply: FilesReply,
    ) => Promise<unknown> | unknown,
  ): unknown;
  get(
    path: string,
    options: { preHandler: unknown[]; schema?: Record<string, unknown> },
    handler: (
      req: FastifyRequestLike,
      reply: FilesReply,
    ) => Promise<unknown> | unknown,
  ): unknown;
  delete(
    path: string,
    options: { preHandler: unknown[]; schema?: Record<string, unknown> },
    handler: (
      req: FastifyRequestLike,
      reply: FilesReply,
    ) => Promise<unknown> | unknown,
  ): unknown;
}

interface FastifyRequestLike {
  id: string;
  params: unknown;
  headers: Record<string, string | string[] | undefined>;
  /** Provided by `@fastify/multipart`. */
  file?: (opts?: unknown) => Promise<MultipartFileLike | undefined>;
}

interface MultipartFileLike {
  /** Raw busboy stream — pipe into `IFileStore.save`. */
  file: NodeJS.ReadableStream;
  filename: string;
  mimetype: string;
  /** Field-name map (multipart `name` override comes via `fields.name.value`). */
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
  ix: IInstantiationService,
): void {
  // Register `@fastify/multipart` synchronously BEFORE `app.ready()` so
  // avvio queues it during boot. Setting `fileSize` to
  // `DEFAULT_MAX_UPLOAD_BYTES` short-circuits huge files
  // at the busboy layer; the route still re-checks inside
  // `IFileStore.save` for defense-in-depth.
  app.register(multipart, {
    limits: {
      fileSize: DEFAULT_MAX_UPLOAD_BYTES,
      files: 1,
    },
  });

  // POST /files ----------------------------------------------------
  //
  // `multipart/form-data` with required `file` field + optional `name`
  // / `expires_in_sec` fields. We stream the `file` directly into
  // `IFileStore.save` (no in-memory buffering).
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
          reply.send(
            errEnvelope(
              ErrorCode.VALIDATION_FAILED,
              'multipart not initialized',
              req.id,
            ),
          );
          return;
        }
        const part = await fastifyReq.file();
        if (!part) {
          reply.send(
            errEnvelope(
              ErrorCode.VALIDATION_FAILED,
              'missing `file` field',
              req.id,
            ),
          );
          return;
        }

        // Extract the optional `name` / `expires_in_sec` overrides from
        // sibling field parts. `fields` is populated by busboy as parts
        // arrive — the order matters: the field MUST appear BEFORE the
        // file in the multipart body for `fields` to be set at this
        // point. Browsers / `form-data` libs do this naturally.
        const nameOverride = readFieldString(part.fields['name']);
        const expiresInSec = readFieldNumber(part.fields['expires_in_sec']);

        const store = ix.invokeFunction((a) => a.get(IFileStore));
        // `@fastify/multipart`'s busboy underlay flips `part.file.truncated`
        // when the `fileSize` limit trips DURING streaming (it does not
        // throw — the stream just ends early). The IFileStore.save call
        // below also tracks bytes for defense in depth, but on the
        // boundary case where the bytes go through clean and only THEN
        // busboy reports truncation, we re-check `truncated` after the
        // save completes and rewind by deleting the (now-too-small) blob.
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
              ...(expiresInSec !== undefined ? { expiresInSec } : {}),
            },
          );
          if (busboyTruncated || partFile.truncated === true) {
            // Roll back the partial-on-disk blob; surface 41301.
            try {
              await store.delete(meta.id);
            } catch {
              /* ignore */
            }
            sendMappedError(
              reply as unknown as FilesReply,
              req.id,
              new FileTooLargeError(meta.size + 1, DEFAULT_MAX_UPLOAD_BYTES),
            );
            return;
          }
          reply.send(okEnvelope(meta, req.id));
        } catch (err) {
          sendMappedError(reply as unknown as FilesReply, req.id, err);
        }
      } catch (err) {
        sendMappedError(reply as unknown as FilesReply, req.id, err);
      }
    },
  );
  app.post(uploadRoute.path, uploadRoute.options, uploadRoute.handler as unknown as Parameters<FilesRouteHost['post']>[2]);

  // GET /files/{file_id} -------------------------------------------
  //
  // Architectural exception: the ONLY endpoint that does not use the
  // envelope on success (REST.md §3.10 line 691). 404 still returns a
  // JSON envelope; clients distinguish by `Content-Type`.
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
        const store = ix.invokeFunction((a) => a.get(IFileStore));
        const { meta, blobPath } = await store.get(file_id);
        const r = reply as unknown as FilesReply;
        r.type(meta.media_type)
          .header(
            'content-disposition',
            buildContentDisposition(meta.name),
          )
          .header('content-length', meta.size)
          // ETag pattern: `"<id>-<size>"`. Simple stable etag — the
          // blob bytes are immutable for the lifetime of `file_id`.
          .header('etag', `"${meta.id}-${meta.size}"`)
          .code(200);
        // CRITICAL: `return reply.send(stream)` so Fastify's
        // async-return discipline ties the response lifecycle to the
        // pipeline (mirrors `routes/fs.ts:368`).
        return r.send(createReadStream(blobPath)) as unknown as void;
      } catch (err) {
        sendMappedError(reply as unknown as FilesReply, req.id, err);
        return;
      }
    },
  );
  app.get(downloadRoute.path, downloadRoute.options, downloadRoute.handler as unknown as Parameters<FilesRouteHost['get']>[2]);

  // DELETE /files/{file_id} ----------------------------------------
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
        const store = ix.invokeFunction((a) => a.get(IFileStore));
        await store.delete(file_id);
        reply.send(okEnvelope({ deleted: true as const }, req.id));
      } catch (err) {
        sendMappedError(reply as unknown as FilesReply, req.id, err);
      }
    },
  );
  app.delete(deleteRoute.path, deleteRoute.options, deleteRoute.handler as unknown as Parameters<FilesRouteHost['delete']>[2]);
}

/* -------------------------------------------------------------------------
 * Error mapping
 * ----------------------------------------------------------------------- */

function sendMappedError(reply: FilesReply, requestId: string, err: unknown): void {
  if (err instanceof FileNotFoundError) {
    reply
      .code(404)
      .send(errEnvelope(ErrorCode.FILE_NOT_FOUND, 'file not found', requestId));
    return;
  }
  if (err instanceof FileTooLargeError) {
    reply
      .code(413)
      .send(
        errEnvelope(
          ErrorCode.FILE_TOO_LARGE,
          'upload too large (>50MB)',
          requestId,
        ),
      );
    return;
  }
  // `@fastify/multipart`'s `RequestFileTooLargeError`. We string-match
  // the name so we don't drag the plugin types into the routes layer.
  if (
    typeof err === 'object' &&
    err !== null &&
    'name' in err &&
    (err as { name: string }).name === 'FST_REQ_FILE_TOO_LARGE'
  ) {
    reply
      .code(413)
      .send(
        errEnvelope(
          ErrorCode.FILE_TOO_LARGE,
          'upload too large (>50MB)',
          requestId,
        ),
      );
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

/* -------------------------------------------------------------------------
 * Helpers
 * ----------------------------------------------------------------------- */

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

/**
 * Build a `Content-Disposition: attachment; filename="..."` header.
 * For names with non-ASCII or unsafe chars we fall back to the bare
 * `attachment` directive; we do not currently emit the RFC 5987
 * `filename*=UTF-8''...` form.
 */
function buildContentDisposition(name: string): string {
  if (/^[\w. \-()+\[\]]+$/.test(name)) {
    return `attachment; filename="${name}"`;
  }
  return 'attachment';
}

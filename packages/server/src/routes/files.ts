

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

import { DEFAULT_MAX_UPLOAD_BYTES, FileNotFoundError, FileTooLargeError, IFileStore, type IInstantiationService } from '@moonshot-ai/agent-core';

import { errEnvelope, okEnvelope } from '../envelope';
import { defineRoute } from '../middleware/defineRoute';

interface FilesRouteHost {
  register(plugin: unknown, opts?: unknown): unknown;
  post(
    path: string,
    options: { schema?: Record<string, unknown> },
    handler: (
      req: FastifyRequestLike,
      reply: FilesReply,
    ) => unknown,
  ): unknown;
  get(
    path: string,
    options: { preHandler: unknown[]; schema?: Record<string, unknown> },
    handler: (
      req: FastifyRequestLike,
      reply: FilesReply,
    ) => unknown,
  ): unknown;
  delete(
    path: string,
    options: { preHandler: unknown[]; schema?: Record<string, unknown> },
    handler: (
      req: FastifyRequestLike,
      reply: FilesReply,
    ) => unknown,
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
  ix: IInstantiationService,
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

        const nameOverride = readFieldString(part.fields['name']);
        const expiresInSec = readFieldNumber(part.fields['expires_in_sec']);

        const store = ix.invokeFunction((a) => a.get(IFileStore));

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

            try {
              await store.delete(meta.id);
            } catch {

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

          .header('etag', `"${meta.id}-${meta.size}"`)
          .code(200);

        return r.send(createReadStream(blobPath)) as unknown as void;
      } catch (err) {
        sendMappedError(reply as unknown as FilesReply, req.id, err);
        return;
      }
    },
  );
  app.get(downloadRoute.path, downloadRoute.options, downloadRoute.handler as unknown as Parameters<FilesRouteHost['get']>[2]);

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

function buildContentDisposition(name: string): string {
  if (/^[\w. ()+[\]-]+$/.test(name)) {
    return `attachment; filename="${name}"`;
  }
  return 'attachment';
}

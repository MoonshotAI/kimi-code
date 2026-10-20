import { Readable } from 'node:stream';

import type { Request, Response } from 'express';

import { useInject } from '@moonshot-ai/agent-core/kernel/index';

import { FilesRef } from '#/features/files/index';

import { useHttpRoute } from '../scope';
import { ErrorCode, param, sendErr, sendOk } from '../route/http';
import { parseRangeHeader } from './workspaces';

export function useFilesRoutes(prefix: string): void {
  const face = useInject(FilesRef);
  useHttpRoute({
    id: 'files.upload',
    method: 'POST',
    path: `${prefix}/files`,
    handler: async (request, response) => {
      const current = face.value;
      if (current === undefined) {
        sendErr(
          request,
          response,
          ErrorCode.FILES_UNAVAILABLE,
          'file library is unavailable (files feature is not installed)',
        );
        return;
      }
      let form: FormData;
      try {
        form = await readMultipart(request);
      } catch (error) {
        sendErr(
          request,
          response,
          ErrorCode.INTERNAL_ERROR,
          error instanceof Error && error.message !== '' ? error.message : 'internal error',
        );
        return;
      }
      let part: File | undefined;
      for (const value of form.values()) {
        if (value instanceof File) {
          part = value;
          break;
        }
      }
      if (part === undefined) {
        sendErr(request, response, ErrorCode.VALIDATION_FAILED, 'missing `file` field');
        return;
      }
      const meta = await current.save(Readable.fromWeb(part.stream()), part.name, {
        name: readFieldString(form.get('name')) ?? part.name,
        mimeType: part.type === '' ? undefined : part.type,
        expiresInSec: readFieldNumber(form.get('expires_in_sec')),
      });
      sendOk(request, response, meta);
    },
  });

  useHttpRoute({
    id: 'files.download',
    method: 'GET',
    path: `${prefix}/files/:file_id`,
    handler: async (request, response) => {
      const current = face.value;
      if (current === undefined) {
        sendErr(
          request,
          response,
          ErrorCode.FILES_UNAVAILABLE,
          'file library is unavailable (files feature is not installed)',
        );
        return;
      }
      const fileId = param(request, 'file_id');
      if (fileId === undefined) {
        sendErr(request, response, ErrorCode.VALIDATION_FAILED, 'file_id is required');
        return;
      }
      const file = await current.open(fileId);
      if (file === undefined) {
        sendErr(request, response, ErrorCode.FILE_NOT_FOUND, 'file not found');
        return;
      }
      sendBinaryFile(
        request,
        response,
        {
          name: file.meta.name,
          mediaType: file.meta.media_type,
          size: file.meta.size,
          stream: (range) => file.stream(range),
        },
        `"${file.meta.id}-${file.meta.size}"`,
      );
    },
  });
}

export interface BinaryFileRange {
  readonly start: number;
  readonly end: number;
}

export interface BinaryFile {
  readonly name: string;
  readonly mediaType: string;
  readonly size: number;
  stream(range?: BinaryFileRange): AsyncIterable<Uint8Array>;
}

export function sendBinaryFile(
  request: Request,
  response: Response,
  file: BinaryFile,
  etag: string,
): void {
  response.type(file.mediaType);
  response.setHeader('content-disposition', buildContentDisposition(file.name, file.mediaType));
  response.setHeader('accept-ranges', 'bytes');
  response.setHeader('etag', etag);
  const range = parseRangeHeader(request.get('range'), file.size);
  if (range !== null) {
    response
      .status(206)
      .setHeader('content-range', `bytes ${range.start}-${range.end}/${file.size}`)
      .setHeader('content-length', String(range.length));
    Readable.from(file.stream({ start: range.start, end: range.end })).pipe(response);
    return;
  }
  response.status(200).setHeader('content-length', String(file.size));
  Readable.from(file.stream()).pipe(response);
}

export function buildContentDisposition(name: string, mediaType?: string): string {
  const disposition = /^(image|video|audio)\//.test(mediaType ?? '') ? 'inline' : 'attachment';
  if (/^[\w. ()+[\]-]+$/.test(name)) {
    return `${disposition}; filename="${name}"`;
  }
  return disposition;
}

async function readMultipart(request: Request): Promise<FormData> {
  const contentType = request.get('content-type');
  const incoming = new Request('http://feature-http.local/api/v1/files', {
    method: 'POST',
    headers: contentType === undefined ? {} : { 'content-type': contentType },
    body: Readable.toWeb(request) as ReadableStream<Uint8Array>,
    duplex: 'half',
  });
  return incoming.formData();
}

function readFieldString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function readFieldNumber(value: unknown): number | undefined {
  if (typeof value !== 'string') return undefined;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) return undefined;
  return Math.floor(parsed);
}

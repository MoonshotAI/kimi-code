import type { IncomingRequest } from '#/model/transport';

export type UploadState = 'stored' | 'held' | 'aborted';

export interface FileUpload {
  readonly index: number;
  readonly id: string;
  readonly filename: string;
  readonly purpose: string;
  readonly contentType: string;
  readonly fileContentType?: string;
  readonly rawBody: string;
  readonly state: UploadState;
}

export interface UploadFacts {
  readonly filename: string;
  readonly purpose: string;
  readonly fileContentType?: string;
}

export function uploadFactsOf(incoming: IncomingRequest): UploadFacts {
  const body = incoming.body;
  const purpose = /name="purpose"\r?\n(?:[^\r\n]+\r?\n)*\r?\n([^\r\n]*)/.exec(body)?.[1] ?? '';
  const filename = /name="file";\s*filename="([^"]*)"/.exec(body)?.[1] ?? '';
  const fileContentType = /name="file";[^\r\n]*\r?\nContent-Type:\s*([^\r\n]+)/i.exec(body)?.[1];
  return fileContentType === undefined ? { filename, purpose } : { filename, purpose, fileContentType };
}

export function fileObjectOf(upload: FileUpload): Record<string, unknown> {
  return {
    id: upload.id,
    object: 'file',
    bytes: upload.rawBody.length,
    created_at: 0,
    filename: upload.filename,
    purpose: upload.purpose,
    status: 'ok',
  };
}

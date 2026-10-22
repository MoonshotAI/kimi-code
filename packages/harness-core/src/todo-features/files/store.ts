export interface FileMeta {
  readonly id: string;
  readonly name: string;
  readonly media_type: string;
  readonly size: number;
  readonly created_at: string;
  readonly expires_at?: string;
}

export interface FileReadRange {
  readonly start: number;
  readonly end: number;
}

export interface SaveFileOptions {
  readonly name?: string;
  readonly mimeType?: string;
  readonly expiresInSec?: number;
}

export interface StoredFile {
  readonly meta: FileMeta;
  stream(range?: FileReadRange): AsyncIterable<Uint8Array>;
}

export interface FilesFace {
  save(
    source: AsyncIterable<Uint8Array>,
    filename: string,
    options?: SaveFileOptions,
  ): Promise<FileMeta>;
  open(id: string): Promise<StoredFile | undefined>;
}

export async function readStoredFile(file: StoredFile, n?: number): Promise<Uint8Array> {
  const size = Math.min(n ?? file.meta.size, file.meta.size);
  if (size === 0) return new Uint8Array();
  const chunks: Uint8Array[] = [];
  for await (const chunk of file.stream({ start: 0, end: size - 1 })) chunks.push(chunk);
  const bytes = Buffer.concat(chunks);
  if (bytes.length !== size) throw new Error('Attachment changed or became unavailable while reading.');
  return bytes;
}

export const FILE_ID_PATTERN = /^f_[A-Za-z0-9][A-Za-z0-9_-]*$/;

export function isFileId(value: string): boolean {
  return FILE_ID_PATTERN.test(value);
}

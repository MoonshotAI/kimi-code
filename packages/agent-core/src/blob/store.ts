import { sha256Hex } from '#/utils/hash';

import type { BlobBackend } from './backend';

export interface BlobContent {
  readonly bytes: Uint8Array;
  readonly mimeType?: string;
  readonly filename?: string;
}

export interface BlobRef {
  readonly ref: string;
  readonly size: number;
}

export interface BlobStore {
  put(content: BlobContent): Promise<BlobRef>;
  get(ref: string): Promise<BlobContent | undefined>;
  has(ref: string): Promise<boolean>;
}

export class BlobIntegrityError extends Error {
  constructor(readonly ref: string) {
    super(`Blob '${ref}' failed its integrity check`);
    this.name = 'BlobIntegrityError';
  }
}

const blobRef = /^[0-9a-f]{64}$/;
const headerBytes = 4;

const keyOf = (ref: string): string => `data/${ref}`;

function encode(content: BlobContent): Uint8Array {
  const header = new TextEncoder().encode(JSON.stringify({ mimeType: content.mimeType, filename: content.filename }));
  const record = new Uint8Array(headerBytes + header.byteLength + content.bytes.byteLength);
  new DataView(record.buffer).setUint32(0, header.byteLength);
  record.set(header, headerBytes);
  record.set(content.bytes, headerBytes + header.byteLength);
  return record;
}

function decode(ref: string, record: Uint8Array): BlobContent {
  if (record.byteLength < headerBytes) throw new BlobIntegrityError(ref);
  const length = new DataView(record.buffer, record.byteOffset, record.byteLength).getUint32(0);
  const start = headerBytes + length;
  if (start > record.byteLength) throw new BlobIntegrityError(ref);
  let header: { mimeType?: unknown; filename?: unknown };
  try {
    header = JSON.parse(new TextDecoder().decode(record.subarray(headerBytes, start))) as typeof header;
  } catch {
    throw new BlobIntegrityError(ref);
  }
  const { mimeType, filename } = header;
  if (mimeType !== undefined && typeof mimeType !== 'string') throw new BlobIntegrityError(ref);
  if (filename !== undefined && typeof filename !== 'string') throw new BlobIntegrityError(ref);
  return {
    bytes: record.slice(start),
    ...(mimeType === undefined ? {} : { mimeType }),
    ...(filename === undefined ? {} : { filename }),
  };
}

export function openBlobStore(backend: BlobBackend): BlobStore {
  return {
    put: async (content) => {
      const record = encode(content);
      const ref = await sha256Hex(record);
      if (!(await backend.has(keyOf(ref)))) await backend.write(keyOf(ref), record);
      return { ref, size: content.bytes.byteLength };
    },
    get: async (ref) => {
      if (!blobRef.test(ref)) return undefined;
      const record = await backend.read(keyOf(ref));
      if (record === undefined) return undefined;
      if ((await sha256Hex(record)) !== ref) throw new BlobIntegrityError(ref);
      return decode(ref, record);
    },
    has: async (ref) => blobRef.test(ref) && (await backend.has(keyOf(ref))),
  };
}

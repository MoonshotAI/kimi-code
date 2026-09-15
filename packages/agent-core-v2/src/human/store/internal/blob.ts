import type { BlobBackend } from '../backend/backend';
import { StoreError } from '../types';

export async function sha256Hex(data: string): Promise<string> {
  const digest = await globalThis.crypto.subtle.digest('SHA-256', new TextEncoder().encode(data));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

export async function writeBlob(blobs: BlobBackend, data: string): Promise<string> {
  const ref = await sha256Hex(data);
  if (!(await blobs.has(ref))) {
    await blobs.write(ref, data);
  }
  return ref;
}

export async function readBlob(blobs: BlobBackend, ref: string): Promise<string> {
  if (!(await blobs.has(ref))) {
    throw new StoreError('blob-missing', `blob ${ref} is missing`);
  }
  const data = await blobs.read(ref);
  if ((await sha256Hex(data)) !== ref) {
    throw new StoreError('blob-crc', `blob ${ref} failed its hash check`);
  }
  return data;
}

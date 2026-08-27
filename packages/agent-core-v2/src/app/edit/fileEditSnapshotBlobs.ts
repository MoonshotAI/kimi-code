import { createHash } from 'node:crypto';

import type { IBlobStore } from '#/persistence/interface/blobStore';

import type { FileBlobRef } from './fileEditEvents';

async function putContentBlob(
  blobs: IBlobStore,
  scope: string,
  content: string,
): Promise<FileBlobRef> {
  const bytes = Buffer.from(content, 'utf8');
  const key = `file-edit/${createHash('sha256').update(bytes).digest('hex')}`;
  if (!(await blobs.has(scope, key))) {
    await blobs.put(scope, key, bytes);
  }
  return { key, bytes: bytes.byteLength };
}

export async function writeFileEditSnapshotBlobs(
  blobs: IBlobStore,
  scope: string,
  before: string | null | undefined,
  after: string | undefined,
): Promise<{ before?: FileBlobRef | null; after?: FileBlobRef }> {
  if (after === undefined) return {};
  const [beforeRef, afterRef] = await Promise.all([
    typeof before === 'string' ? putContentBlob(blobs, scope, before) : null,
    putContentBlob(blobs, scope, after),
  ]);
  return { before: beforeRef, after: afterRef };
}

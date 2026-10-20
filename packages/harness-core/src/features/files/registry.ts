import { randomUUID } from 'node:crypto';

import { BlobIntegrityError, type BlobContent, type BlobRef, type BlobStore } from '@moonshot-ai/agent-core/blob/index';
import { createFacadeToken } from '@moonshot-ai/agent-core/kernel/index';
import type { Projection } from '@moonshot-ai/agent-core/store/index';

import type { FeatureEvent, FeatureStore } from '#/runtime/index';

import { buildKimiFileUrl, parseKimiFileUrl } from './ref';
import type { FileMeta, FilesFace, StoredFile } from './store';

export interface KimiFileRecord {
  readonly meta: FileMeta;
  readonly blobRef: string;
}

export interface KimiFileRegisteredEvent extends FeatureEvent {
  readonly type: 'files.registered';
  readonly record: KimiFileRecord;
}

export type KimiFileState = Readonly<Record<string, KimiFileRecord>>;

export const kimiFileProjection: Projection<KimiFileState, KimiFileRegisteredEvent> = {
  initial: () => ({}),
  reduce: (state, { event }) => ({ ...state, [event.record.meta.id]: event.record }),
};

export interface KimiFileRegistry {
  put(content: BlobContent): Promise<BlobRef>;
  get(reference: string): Promise<BlobContent | undefined>;
  open(reference: string): Promise<StoredFile | undefined>;
  materialize(reference: string): Promise<StoredFile | undefined>;
}

export const KimiFileRegistryRef = createFacadeToken<KimiFileRegistry>('kimiFileRegistry');

export interface CreateKimiFileRegistryProps {
  readonly blobs: BlobStore;
  readonly store: FeatureStore<KimiFileState, KimiFileRegisteredEvent>;
  readonly files: () => FilesFace | undefined;
}

async function collect(source: AsyncIterable<Uint8Array>): Promise<Uint8Array> {
  const chunks: Uint8Array[] = [];
  let size = 0;
  for await (const chunk of source) {
    chunks.push(chunk);
    size += chunk.byteLength;
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

export function createKimiFileRegistry(props: CreateKimiFileRegistryProps): KimiFileRegistry {
  const local = new Map<string, KimiFileRecord>();
  let writing: Promise<void> = Promise.resolve();
  const recordOf = (fileId: string): KimiFileRecord | undefined =>
    local.get(fileId) ?? props.store.state.value[fileId];
  const read = async (record: KimiFileRecord): Promise<BlobContent | undefined> => {
    const content = await props.blobs.get(record.blobRef).catch((error: unknown) => {
      if (error instanceof BlobIntegrityError) return undefined;
      throw error;
    });
    if (content === undefined) return undefined;
    return {
      bytes: content.bytes,
      mimeType: record.meta.media_type,
      filename: record.meta.name,
    };
  };
  const storedFile = (record: KimiFileRecord, content: BlobContent): StoredFile => ({
    meta: record.meta,
    stream: async function* (range) {
      const start = range?.start ?? 0;
      const end = range?.end ?? content.bytes.byteLength - 1;
      yield content.bytes.slice(start, end + 1);
    },
  });
  const register = async (record: KimiFileRecord): Promise<void> => {
    await props.store.dispatch([{ type: 'files.registered', record }]);
    local.set(record.meta.id, record);
  };
  const serial = <T>(operation: () => Promise<T>): Promise<T> => {
    const result = writing.then(operation);
    writing = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  };
  const resolve = async (reference: string): Promise<{ record: KimiFileRecord; content: BlobContent } | undefined> => {
    const parsed = parseKimiFileUrl(reference);
    if (parsed === undefined) return undefined;
    await props.store.ready;
    const existing = recordOf(parsed.fileId);
    if (existing !== undefined) {
      const content = await read(existing);
      if (content !== undefined) return { record: existing, content };
    }
    return serial(async () => {
      const current = recordOf(parsed.fileId);
      if (current !== undefined) {
        const content = await read(current);
        if (content !== undefined) return { record: current, content };
      }
      const staged = await props.files()?.open(parsed.fileId);
      if (staged === undefined) return undefined;
      const bytes = await collect(staged.stream());
      const meta: FileMeta = {
        id: staged.meta.id,
        name: staged.meta.name,
        media_type: staged.meta.media_type,
        size: bytes.byteLength,
        created_at: staged.meta.created_at,
      };
      const blobRef = (await props.blobs.put({ bytes, mimeType: meta.media_type, filename: meta.name })).ref;
      const record = { meta, blobRef };
      await register(record);
      return { record, content: { bytes, mimeType: meta.media_type, filename: meta.name } };
    });
  };
  return {
    put: (content) =>
      serial(async () => {
        const id = `f_${randomUUID()}`;
        const meta: FileMeta = {
          id,
          name: content.filename ?? id,
          media_type: content.mimeType ?? 'application/octet-stream',
          size: content.bytes.byteLength,
          created_at: new Date().toISOString(),
        };
        const blobRef = (await props.blobs.put(content)).ref;
        await register({ meta, blobRef });
        return { ref: buildKimiFileUrl(id), size: content.bytes.byteLength };
      }),
    get: async (reference) => (await resolve(reference))?.content,
    open: async (reference) => {
      const resolved = await resolve(reference);
      return resolved === undefined ? undefined : storedFile(resolved.record, resolved.content);
    },
    materialize: async (reference) => {
      const resolved = await resolve(reference);
      return resolved === undefined ? undefined : storedFile(resolved.record, resolved.content);
    },
  };
}

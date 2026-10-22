import { randomUUID } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

import {
  BlobIntegrityError,
  type BlobContent,
  type BlobRef,
} from '@moonshot-ai/agent-core/blob/index';

import { createFeature, useApp, type App, type Feature, useBlobs, useFeatureStore } from '#/app/index';
import { createFacadeToken, useExpose, useInject } from '#/kernel/index';

import { buildKimiFileUrl, parseKimiFileUrl } from './ref';
import {
  KimiFileRegistryRef,
  kimiFileProjection,
  type KimiFileRecord,
  type KimiFileRegistry,
} from './registry';
import { isFileId, type FileMeta, type FilesFace, type SaveFileOptions, type StoredFile } from './store';

export const FilesRef = createFacadeToken<FilesFace>('files');

export interface CreateFilesProps {
  readonly dir: string;
}

interface FileIndex {
  readonly version: 1;
  readonly files: FileMeta[];
}

function isFileMeta(value: unknown): value is FileMeta {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const meta = value as Record<string, unknown>;
  return (
    typeof meta['id'] === 'string' &&
    isFileId(meta['id']) &&
    typeof meta['name'] === 'string' &&
    typeof meta['media_type'] === 'string' &&
    typeof meta['size'] === 'number' &&
    Number.isSafeInteger(meta['size']) &&
    meta['size'] >= 0 &&
    typeof meta['created_at'] === 'string' &&
    (meta['expires_at'] === undefined || typeof meta['expires_at'] === 'string')
  );
}

function isEnoent(error: unknown): boolean {
  return error instanceof Error && 'code' in error && error.code === 'ENOENT';
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

export function createFiles(props: CreateFilesProps): Feature<void> {
  const libraries = new WeakMap<App, FilesFace>();
  const createLibrary = (): FilesFace => {
    let index: Map<string, FileMeta> | undefined;
    let loading: Promise<void> | undefined;
    let writing: Promise<void> = Promise.resolve();

    const _writeIndex = async (): Promise<void> => {
      const write = writing.catch(() => undefined).then(async () => {
        const current = index;
        if (current === undefined) return;
        const payload: FileIndex = { version: 1, files: [...current.values()] };
        await mkdir(props.dir, { recursive: true });
        const path = join(props.dir, 'index.json');
        await writeFile(`${path}.tmp`, JSON.stringify(payload), 'utf8');
        await rename(`${path}.tmp`, path);
      });
      writing = write;
      await write;
    };

    const _loadIndex = async (): Promise<void> => {
      let raw: string;
      try {
        raw = await readFile(join(props.dir, 'index.json'), 'utf8');
      } catch (error) {
        if (isEnoent(error)) {
          index = new Map();
          return;
        }
        throw error;
      }
      try {
        const parsed = JSON.parse(raw) as FileIndex;
        const map = new Map<string, FileMeta>();
        if (Array.isArray(parsed.files)) {
          for (const entry of parsed.files) {
            if (isFileMeta(entry)) map.set(entry.id, entry);
          }
        }
        index = map;
      } catch {
        index = new Map();
      }
    };

    const _ensureIndex = (): Promise<void> => {
      if (index !== undefined) return Promise.resolve();
      if (loading !== undefined) return loading;
      loading = _loadIndex().finally(() => {
        loading = undefined;
      });
      return loading;
    };

    const _pruneExpired = async (): Promise<void> => {
      const current = index;
      if (current === undefined) return;
      const now = Date.now();
      const expired = [...current.values()].filter(
        (meta) => meta.expires_at !== undefined && Date.parse(meta.expires_at) <= now,
      );
      if (expired.length === 0) return;
      for (const meta of expired) {
        current.delete(meta.id);
        await rm(join(props.dir, meta.id), { force: true }).catch(() => undefined);
      }
      await _writeIndex().catch(() => undefined);
    };

    const save = async (
      source: AsyncIterable<Uint8Array>,
      filename: string,
      options: SaveFileOptions = {},
    ): Promise<FileMeta> => {
      await _ensureIndex();
      await _pruneExpired();
      const id = `f_${randomUUID()}`;
      await mkdir(props.dir, { recursive: true });
      const path = join(props.dir, id);
      try {
        await pipeline(Readable.from(source), createWriteStream(path));
      } catch (error) {
        await rm(path, { force: true }).catch(() => undefined);
        throw error;
      }
      const { size } = await stat(path);
      const now = Date.now();
      const meta: FileMeta = {
        id,
        name: options.name ?? filename,
        media_type: options.mimeType ?? 'application/octet-stream',
        size,
        created_at: new Date(now).toISOString(),
        expires_at:
          options.expiresInSec === undefined
            ? undefined
            : new Date(now + options.expiresInSec * 1000).toISOString(),
      };
      index!.set(id, meta);
      await _writeIndex();
      return meta;
    };

    const open = async (id: string): Promise<StoredFile | undefined> => {
      if (!isFileId(id)) return undefined;
      await _ensureIndex();
      await _pruneExpired();
      const meta = index!.get(id);
      if (meta === undefined) return undefined;
      const path = join(props.dir, id);
      try {
        if (!(await stat(path)).isFile()) return undefined;
      } catch (error) {
        if (isEnoent(error)) {
          index!.delete(id);
          await _writeIndex();
          return undefined;
        }
        throw error;
      }
      return {
        meta,
        stream: (range) =>
          createReadStream(path, range === undefined ? {} : { start: range.start, end: range.end }),
      };
    };

    return { save, open };
  };

  return createFeature('files', {
    app() {
      const app = useApp();
      let face = libraries.get(app);
      if (face === undefined) {
        face = createLibrary();
        libraries.set(app, face);
      }
      useExpose(FilesRef, face);
    },
    session() {
      const files = useInject(FilesRef);
      const store = useFeatureStore('session', 'files', kimiFileProjection);
      const blobs = useBlobs();
      const local = new Map<string, KimiFileRecord>();
      let writing: Promise<void> = Promise.resolve();

      const _recordOf = (fileId: string): KimiFileRecord | undefined =>
        local.get(fileId) ?? store.state.value[fileId];

      const _read = async (record: KimiFileRecord): Promise<BlobContent | undefined> => {
        const content = await blobs.get(record.blobRef).catch((error: unknown) => {
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

      const _storedFile = (record: KimiFileRecord, content: BlobContent): StoredFile => ({
        meta: record.meta,
        stream: async function* (range) {
          const start = range?.start ?? 0;
          const end = range?.end ?? content.bytes.byteLength - 1;
          yield content.bytes.slice(start, end + 1);
        },
      });

      const _register = async (record: KimiFileRecord): Promise<void> => {
        await store.dispatch([{ type: 'files.registered', record }]);
        local.set(record.meta.id, record);
      };

      const _serial = <T>(operation: () => Promise<T>): Promise<T> => {
        const result = writing.then(operation);
        writing = result.then(
          () => undefined,
          () => undefined,
        );
        return result;
      };

      const _resolve = async (
        reference: string,
      ): Promise<{ record: KimiFileRecord; content: BlobContent } | undefined> => {
        const parsed = parseKimiFileUrl(reference);
        if (parsed === undefined) return undefined;
        await store.ready;
        const existing = _recordOf(parsed.fileId);
        if (existing !== undefined) {
          const content = await _read(existing);
          if (content !== undefined) return { record: existing, content };
        }
        return _serial(async () => {
          const current = _recordOf(parsed.fileId);
          if (current !== undefined) {
            const content = await _read(current);
            if (content !== undefined) return { record: current, content };
          }
          const staged = await files.value?.open(parsed.fileId);
          if (staged === undefined) return undefined;
          const bytes = await collect(staged.stream());
          const meta: FileMeta = {
            id: staged.meta.id,
            name: staged.meta.name,
            media_type: staged.meta.media_type,
            size: bytes.byteLength,
            created_at: staged.meta.created_at,
          };
          const blobRef = (
            await blobs.put({ bytes, mimeType: meta.media_type, filename: meta.name })
          ).ref;
          const record = { meta, blobRef };
          await _register(record);
          return { record, content: { bytes, mimeType: meta.media_type, filename: meta.name } };
        });
      };

      const put = (content: BlobContent): Promise<BlobRef> =>
        _serial(async () => {
          const id = `f_${randomUUID()}`;
          const meta: FileMeta = {
            id,
            name: content.filename ?? id,
            media_type: content.mimeType ?? 'application/octet-stream',
            size: content.bytes.byteLength,
            created_at: new Date().toISOString(),
          };
          const blobRef = (await blobs.put(content)).ref;
          await _register({ meta, blobRef });
          return { ref: buildKimiFileUrl(id), size: content.bytes.byteLength };
        });

      const get = async (reference: string): Promise<BlobContent | undefined> =>
        (await _resolve(reference))?.content;

      const open = async (reference: string): Promise<StoredFile | undefined> => {
        const resolved = await _resolve(reference);
        return resolved === undefined ? undefined : _storedFile(resolved.record, resolved.content);
      };

      const materialize = async (reference: string): Promise<StoredFile | undefined> => {
        const resolved = await _resolve(reference);
        return resolved === undefined ? undefined : _storedFile(resolved.record, resolved.content);
      };

      const registry: KimiFileRegistry = { put, get, open, materialize };
      useExpose(KimiFileRegistryRef, registry);
    },
  });
}

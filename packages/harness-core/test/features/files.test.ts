import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { createFeature } from '@moonshot-ai/agent-core/app/index';
import { useInject, type ShallowRef } from '@moonshot-ai/agent-core/kernel/index';

import {
  createFiles,
  FileLibrary,
  FilesRef,
  isFileId,
  type FilesFace,
} from '#/features/files/index';
import { createHarness, memoryHarnessSpace, type Harness } from '#/runtime/index';

const tmpDirs: string[] = [];
const harnesses: Harness[] = [];

afterEach(async () => {
  await Promise.all(harnesses.splice(0).map((harness) => harness.close()));
  await Promise.all(tmpDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function tempDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  tmpDirs.push(dir);
  return dir;
}

const tick = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

async function collect(stream: AsyncIterable<Uint8Array>): Promise<Buffer> {
  const chunks: Uint8Array[] = [];
  for await (const chunk of stream) {
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

async function* sourceOf(...chunks: Uint8Array[]): AsyncIterable<Uint8Array> {
  for (const chunk of chunks) {
    yield chunk;
  }
}

describe('files library', () => {
  it('saves a streamed upload to disk and reads it back with inclusive ranges', async () => {
    const dir = await tempDir('files-store-');
    const library = new FileLibrary(dir);
    const bytes = Buffer.from('0123456789');

    const meta = await library.save(sourceOf(bytes.subarray(0, 4), bytes.subarray(4)), 'data.bin', {
      mimeType: 'application/octet-stream',
    });
    expect(isFileId(meta.id)).toBe(true);
    expect(meta).toMatchObject({
      name: 'data.bin',
      media_type: 'application/octet-stream',
      size: bytes.length,
    });
    expect(Number.isNaN(Date.parse(meta.created_at))).toBe(false);
    expect(meta.expires_at).toBeUndefined();
    expect(await readFile(join(dir, meta.id))).toEqual(bytes);

    const file = await library.open(meta.id);
    expect(file?.meta).toEqual(meta);
    expect(await collect(file!.stream())).toEqual(bytes);
    expect(await collect(file!.stream({ start: 2, end: 5 }))).toEqual(bytes.subarray(2, 6));
    expect(await collect(file!.stream({ start: 8, end: 9 }))).toEqual(bytes.subarray(8));
  });

  it('defaults the display name and mime type from the upload filename', async () => {
    const dir = await tempDir('files-store-');
    const library = new FileLibrary(dir);
    const meta = await library.save(sourceOf(new Uint8Array([1])), 'photo.png');
    expect(meta.name).toBe('photo.png');
    expect(meta.media_type).toBe('application/octet-stream');
  });

  it('reloads the index from disk across instances', async () => {
    const dir = await tempDir('files-store-');
    const first = new FileLibrary(dir);
    const meta = await first.save(sourceOf(Buffer.from('persisted')), 'keep.txt', {
      mimeType: 'text/plain',
    });

    const reloaded = new FileLibrary(dir);
    const file = await reloaded.open(meta.id);
    expect(file?.meta).toEqual(meta);
    expect(await collect(file!.stream())).toEqual(Buffer.from('persisted'));
  });

  it('returns undefined for unknown or malformed ids', async () => {
    const dir = await tempDir('files-store-');
    const library = new FileLibrary(dir);
    expect(await library.open('f_00000000-0000-0000-0000-000000000000')).toBeUndefined();
    expect(await library.open('not-a-file-id')).toBeUndefined();
    expect(await library.open('../escape')).toBeUndefined();
  });

  it('prunes expired files on save and open', async () => {
    const dir = await tempDir('files-store-');
    const library = new FileLibrary(dir);
    const expired = await library.save(sourceOf(Buffer.from('gone')), 'gone.txt', {
      expiresInSec: 0,
    });
    expect(expired.expires_at).toBeDefined();

    expect(await library.open(expired.id)).toBeUndefined();
    expect((await readdir(dir)).filter((name) => name.startsWith('f_'))).toHaveLength(0);

    const fresh = await library.save(sourceOf(Buffer.from('alive')), 'alive.txt');
    const reloaded = new FileLibrary(dir);
    expect((await reloaded.open(fresh.id))?.meta.id).toBe(fresh.id);
  });
});

describe('files feature', () => {
  it('exposes the files facade at app level and reuses the library across remounts', async () => {
    const dir = await tempDir('files-feature-');
    let exposed: Readonly<ShallowRef<FilesFace | undefined>> | undefined;
    const probe = createFeature('files-probe', {
      app: () => {
        exposed = useInject(FilesRef);
      },
    });
    const harness = createHarness({ space: memoryHarnessSpace() });
    harnesses.push(harness);
    const spec = createFiles({ dir });
    const remove = harness.app.features.add(spec);
    harness.app.features.add(probe);
    await tick();
    const face = exposed?.value;
    if (face === undefined) throw new Error('files face was not exposed');

    const meta = await face.save(sourceOf(Buffer.from('facade')), 'facade.txt');
    expect(isFileId(meta.id)).toBe(true);
    const file = await face.open(meta.id);
    expect(await collect(file!.stream())).toEqual(Buffer.from('facade'));

    await remove();
    await tick();
    expect(exposed?.value).toBeUndefined();

    harness.app.features.add(spec);
    await tick();
    const remounted = exposed?.value;
    if (remounted === undefined) throw new Error('files face was not re-exposed');
    expect(remounted).toBe(face);
    expect((await remounted.open(meta.id))?.meta).toEqual(meta);
  });
});

/**
 * Scenario: session-canonical media persists through the byte-storage boundary.
 */

import { mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { DisposableStore } from '#/_base/di/lifecycle';
import { createServices, type TestInstantiationService } from '#/_base/di/test';
import { ISessionMediaStore } from '#/agent/media/sessionMediaStore';
import { SessionMediaStoreService } from '#/agent/media/sessionMediaStoreService';
import { JsonAtomicDocumentStore } from '#/persistence/backends/node-fs/atomicDocumentStore';
import { FileStorageService } from '#/persistence/backends/node-fs/fileStorageService';
import { InMemoryStorageService } from '#/persistence/backends/memory/inMemoryStorageService';
import { IAtomicDocumentStore } from '#/persistence/interface/atomicDocumentStore';
import { IFileSystemStorageService } from '#/persistence/interface/storage';
import { ISessionContext, makeSessionContext } from '#/session/sessionContext/sessionContext';

const BYTES = Buffer.from('media bytes');

function streamOf(bytes: Buffer): () => NodeJS.ReadableStream {
  return () => Readable.from([bytes]);
}

describe('SessionMediaStoreService', () => {
  let disposables: DisposableStore;
  let ix: TestInstantiationService;
  let homeDir: string;
  let sessionDir: string;
  let store: ISessionMediaStore;

  beforeEach(async () => {
    disposables = new DisposableStore();
    homeDir = await mkdtemp(join(tmpdir(), 'session-media-store-home-'));
    sessionDir = join(homeDir, 'sessions', 's1');
    await mkdir(sessionDir, { recursive: true });
    ix = createServices(disposables, {
      strict: true,
      additionalServices: (reg) => {
        reg.defineInstance(ISessionContext, makeSessionContext({
          sessionId: 's1',
          workspaceId: 'w1',
          sessionDir,
          sessionScope: join('sessions', 's1'),
          cwd: '/tmp',
        }));
        reg.defineInstance(IFileSystemStorageService, new FileStorageService(homeDir));
        reg.define(IAtomicDocumentStore, JsonAtomicDocumentStore);
        reg.define(ISessionMediaStore, SessionMediaStoreService);
      },
    });
    store = ix.get(ISessionMediaStore);
  });

  afterEach(async () => {
    disposables.dispose();
    await rm(homeDir, { recursive: true, force: true });
  });

  function input(overrides: Partial<Parameters<ISessionMediaStore['materialize']>[0]> = {}) {
    return {
      fileId: 'f_1',
      size: BYTES.length,
      name: 'clip.mp4',
      mimeType: 'video/mp4',
      stream: streamOf(BYTES),
      ...overrides,
    };
  }

  function pathFor(fileId: string, ext: string): string {
    const path = store.pathFor(fileId, ext);
    expect(path).toBeDefined();
    return path!;
  }

  it('materializes at the storage-backed canonical path', async () => {
    const target = await store.materialize(input());
    expect(target).toBe(pathFor('f_1', '.mp4'));
    expect(target).toBe(join(sessionDir, 'media', 'f_1.mp4'));
    expect(await readFile(target!)).toEqual(BYTES);
  });

  it('keeps a same-size copy without re-reading the stream', async () => {
    await store.materialize(input());
    const again = await store.materialize(
      input({
        stream: () => {
          throw new Error('must not be read');
        },
      }),
    );
    expect(again).toBe(pathFor('f_1', '.mp4'));
    expect(await readFile(again!)).toEqual(BYTES);
  });

  it('overwrites a wrong-size copy', async () => {
    const target = await store.materialize(input());
    await writeFile(target!, 'xx');
    await store.materialize(input());
    expect(await readFile(target!)).toEqual(BYTES);
  });

  it('leaves no temporary storage entry when the stream fails', async () => {
    await expect(
      store.materialize(
        input({
          stream: () =>
            Readable.from(
              (async function* () {
                yield Buffer.from('partial');
                throw new Error('stream broke');
              })(),
            ),
        }),
      ),
    ).rejects.toMatchObject({ code: 'storage.io_failed' });
    const entries = await readdir(join(sessionDir, 'media')).catch(() => [] as string[]);
    expect(entries.filter((name) => name.includes('.tmp.'))).toEqual([]);
    expect(entries).not.toContain('f_1.mp4');
  });

  it('derives the extension from the hint, then the name, then the MIME fallback', async () => {
    expect(await store.materialize(input({ hintPath: '/elsewhere/x.mov' }))).toBe(
      pathFor('f_1', '.mov'),
    );
    expect(await store.materialize(input({ fileId: 'f_2', name: 'noext' }))).toBe(
      pathFor('f_2', '.mp4'),
    );
    expect(await store.materialize(input({ fileId: 'f_3', name: 'noext', mimeType: 'odd/type' }))).toBe(
      pathFor('f_3', '.bin'),
    );
  });

  it('reads canonical bytes independently from the daemon file store', async () => {
    const target = await store.materialize(input());
    await expect(store.read('f_1', target)).resolves.toEqual({
      data: BYTES,
      name: 'f_1.mp4',
    });
  });

  it('opens canonical media with its persisted download metadata', async () => {
    await store.materialize(input({ name: 'original clip.mp4', mimeType: 'video/mp4' }));

    const file = await store.open('f_1');

    expect(file).toMatchObject({
      path: join(sessionDir, 'media', 'f_1.mp4'),
      name: 'original clip.mp4',
      mediaType: 'video/mp4',
      size: BYTES.length,
    });
    expect(file === undefined ? undefined : Buffer.from(await collect(file.stream()))).toEqual(BYTES);
  });

  it('streams only the requested canonical byte range', async () => {
    await store.materialize(input());

    const file = await store.open('f_1');

    expect(
      file === undefined
        ? undefined
        : Buffer.from(await collect(file.stream({ start: 2, end: 6 }))),
    ).toEqual(BYTES.subarray(2, 7));
  });

  it('resolves the display path to the canonical copy, else the hint, else undefined', async () => {
    const target = await store.materialize(input());
    await expect(store.resolveDisplayPath('f_1', '/stale/elsewhere.mp4')).resolves.toBe(target);
    await expect(store.resolveDisplayPath('f_missing', '/hint/x.mp4')).resolves.toBe('/hint/x.mp4');
    await expect(store.resolveDisplayPath('f_missing', undefined)).resolves.toBeUndefined();
    await expect(store.resolveDisplayPath('f_missing', '')).resolves.toBeUndefined();
  });

  it('probes the extensionless canonical location for an extensionless hint', async () => {
    const target = await store.materialize(input({ name: 'noext', mimeType: 'odd/type' }));
    expect(target).toBe(pathFor('f_1', '.bin'));
    const extless = pathFor('f_1', '');
    await rm(target!);
    await writeFile(extless, BYTES);
    await expect(store.resolveDisplayPath('f_1', '/stale/noext')).resolves.toBe(extless);
  });

  it('treats a hint already equal to the canonical path as-is', async () => {
    const canonical = pathFor('f_1', '.mp4');
    await expect(store.resolveDisplayPath('f_1', canonical)).resolves.toBe(canonical);
    await expect(stat(canonical)).rejects.toThrow();
  });

  it('never turns a non-upload id into a storage key (path traversal guard)', async () => {
    // A crafted daemon reference (`kimi-file://../../…?path=…`) reaches the
    // store through the request-time resolver's canonical-read fallback; the
    // id must be rejected before it can become a filesystem key.
    const evil = '../../../../etc/passwd';
    expect(store.pathFor(evil, '')).toBeUndefined();
    expect(store.pathFor(evil, '.png')).toBeUndefined();
    await expect(store.read(evil, 'a.png')).resolves.toBeUndefined();
    await expect(store.read(evil)).resolves.toBeUndefined();
    await expect(store.materialize(input({ fileId: evil }))).resolves.toBeUndefined();
    // The display path falls back to the caller's own hint, like a missing copy.
    await expect(store.resolveDisplayPath(evil, '/hint/x.png')).resolves.toBe('/hint/x.png');
    // Legit ids still work after the guard.
    expect(store.pathFor('f_1', '.mp4')).toBe(join(sessionDir, 'media', 'f_1.mp4'));
  });
});

it('retains canonical bytes without inventing a path for a non-filesystem backend', async () => {
  const disposables = new DisposableStore();
  const ix = createServices(disposables, {
    strict: true,
    additionalServices: (reg) => {
      reg.defineInstance(ISessionContext, makeSessionContext({
        sessionId: 's1',
        workspaceId: 'w1',
        sessionDir: '/unused',
        sessionScope: 'sessions/w1/s1',
        cwd: '/tmp',
      }));
      reg.defineInstance(IFileSystemStorageService, new InMemoryStorageService());
      reg.define(IAtomicDocumentStore, JsonAtomicDocumentStore);
      reg.define(ISessionMediaStore, SessionMediaStoreService);
    },
  });
  const store = ix.get(ISessionMediaStore);
  await expect(store.materialize({
    fileId: 'f_1',
    size: BYTES.length,
    name: 'clip.mp4',
    mimeType: 'video/mp4',
    stream: streamOf(BYTES),
  })).resolves.toBeUndefined();
  const canonical = await store.read('f_1');
  expect(canonical?.name).toBe('f_1.mp4');
  expect(canonical === undefined ? undefined : Buffer.from(canonical.data)).toEqual(BYTES);
  expect((await store.open('f_1'))?.path).toBeUndefined();
  disposables.dispose();
});

async function collect(source: AsyncIterable<Uint8Array>): Promise<Uint8Array> {
  const chunks: Uint8Array[] = [];
  for await (const chunk of source) chunks.push(chunk);
  return Buffer.concat(chunks);
}

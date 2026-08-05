import { mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { SessionMediaStoreService } from '#/agent/media/sessionMediaStoreService';
import { makeSessionContext } from '#/session/sessionContext/sessionContext';

const BYTES = Buffer.from('media bytes');

function streamOf(bytes: Buffer): () => NodeJS.ReadableStream {
  return () => Readable.from([bytes]);
}

describe('SessionMediaStoreService', () => {
  let sessionDir: string;
  let store: SessionMediaStoreService;

  beforeEach(async () => {
    sessionDir = await mkdtemp(join(tmpdir(), 'session-media-store-'));
    store = new SessionMediaStoreService(
      makeSessionContext({
        sessionId: 's1',
        workspaceId: 'w1',
        sessionDir,
        sessionScope: 'sessions/w1/s1',
        cwd: '/tmp',
      }),
    );
  });

  afterEach(async () => {
    await rm(sessionDir, { recursive: true, force: true });
  });

  function input(overrides: Partial<Parameters<SessionMediaStoreService['materialize']>[0]> = {}) {
    return {
      fileId: 'f_1',
      size: BYTES.length,
      name: 'clip.mp4',
      mimeType: 'video/mp4',
      stream: streamOf(BYTES),
      ...overrides,
    };
  }

  it('materializes at the canonical path and reports it from pathFor', async () => {
    const target = await store.materialize(input());
    expect(target).toBe(store.pathFor('f_1', '.mp4'));
    expect(target).toBe(join(sessionDir, 'media', 'f_1.mp4'));
    expect(await readFile(target)).toEqual(BYTES);
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
    expect(again).toBe(store.pathFor('f_1', '.mp4'));
    expect(await readFile(again)).toEqual(BYTES);
  });

  it('overwrites a wrong-size copy', async () => {
    const target = await store.materialize(input());
    await writeFile(target, 'xx');
    await store.materialize(input());
    expect(await readFile(target)).toEqual(BYTES);
  });

  it('leaves no tmp file behind when the stream fails', async () => {
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
    ).rejects.toThrow('stream broke');
    const entries = await readdir(join(sessionDir, 'media')).catch(() => [] as string[]);
    expect(entries.filter((name) => name.endsWith('.tmp'))).toEqual([]);
    expect(entries).not.toContain('f_1.mp4');
  });

  it('derives the extension from the hint, then the name, then the MIME fallback', async () => {
    expect(await store.materialize(input({ hintPath: '/elsewhere/x.mov' }))).toBe(
      store.pathFor('f_1', '.mov'),
    );
    expect(await store.materialize(input({ fileId: 'f_2', name: 'noext' }))).toBe(
      store.pathFor('f_2', '.mp4'),
    );
    expect(await store.materialize(input({ fileId: 'f_3', name: 'noext', mimeType: 'odd/type' }))).toBe(
      store.pathFor('f_3', '.bin'),
    );
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
    expect(target).toBe(store.pathFor('f_1', '.bin'));
    const extless = store.pathFor('f_1', '');
    await rm(target);
    await writeFile(extless, BYTES);
    await expect(store.resolveDisplayPath('f_1', '/stale/noext')).resolves.toBe(extless);
  });

  it('treats a hint already equal to the canonical path as-is', async () => {
    const canonical = store.pathFor('f_1', '.mp4');
    await expect(store.resolveDisplayPath('f_1', canonical)).resolves.toBe(canonical);
    await expect(stat(canonical)).rejects.toThrow();
  });
});

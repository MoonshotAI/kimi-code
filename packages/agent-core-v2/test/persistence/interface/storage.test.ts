import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { IFileSystemStorageService } from '#/persistence/interface/storage';
import { FileStorageService } from '#/persistence/backends/node-fs/fileStorageService';
import { InMemoryStorageService } from '#/persistence/backends/memory/inMemoryStorageService';

const enc = new TextEncoder();
const dec = new TextDecoder();

interface ServiceHandle {
  readonly service: IFileSystemStorageService;
  readonly cleanup?: () => Promise<void>;
}

function storageServiceSuite(
  name: string,
  setup: () => Promise<ServiceHandle>,
): void {
  describe(name, () => {
    let service: IFileSystemStorageService;
    let cleanup: (() => Promise<void>) | undefined;

    beforeEach(async () => {
      const handle = await setup();
      service = handle.service;
      cleanup = handle.cleanup;
    });
    afterEach(async () => {
      await cleanup?.();
    });

    const settle = (): Promise<void> =>
      new Promise((resolve) => setTimeout(resolve, 100));

    it('read returns undefined for a missing key', async () => {
      expect(await service.read('s', 'missing')).toBeUndefined();
    });

    it('write then read round-trips bytes', async () => {
      await service.write('s', 'k', enc.encode('hello'));
      expect(dec.decode(await service.read('s', 'k'))).toBe('hello');
    });

    it('write replaces the whole value (not append)', async () => {
      await service.write('s', 'k', enc.encode('first'));
      await service.write('s', 'k', enc.encode('second'));
      expect(dec.decode(await service.read('s', 'k'))).toBe('second');
    });

    it('append extends bytes in order', async () => {
      await service.append('s', 'k', enc.encode('a'));
      await service.append('s', 'k', enc.encode('b'));
      await service.append('s', 'k', enc.encode('c'));
      expect(dec.decode(await service.read('s', 'k'))).toBe('abc');
    });

    it('append on a missing key creates it', async () => {
      await service.append('s', 'k', enc.encode('created'));
      expect(dec.decode(await service.read('s', 'k'))).toBe('created');
    });

    it('scopes are isolated', async () => {
      await service.write('scope-a', 'k', enc.encode('A'));
      await service.write('scope-b', 'k', enc.encode('B'));
      expect(dec.decode(await service.read('scope-a', 'k'))).toBe('A');
      expect(dec.decode(await service.read('scope-b', 'k'))).toBe('B');
    });

    it('list returns keys, optionally filtered by prefix', async () => {
      await service.write('s', 'alpha', enc.encode('1'));
      await service.write('s', 'beta', enc.encode('2'));
      await service.write('s', 'alphabet', enc.encode('3'));
      expect((await service.list('s')).toSorted()).toEqual(['alpha', 'alphabet', 'beta']);
      expect((await service.list('s', 'alpha')).toSorted()).toEqual(['alpha', 'alphabet']);
    });

    it('list on a missing scope returns []', async () => {
      expect(await service.list('nope')).toEqual([]);
    });

    it('delete removes a key; deleting a missing key is a no-op', async () => {
      await service.write('s', 'k', enc.encode('x'));
      await service.delete('s', 'k');
      expect(await service.read('s', 'k')).toBeUndefined();
      await expect(service.delete('s', 'k')).resolves.toBeUndefined();
    });

    it('watch fires when a watched key is written', async ({ skip }) => {
      if (service.watch === undefined) skip();
      const fired = new Promise<void>((resolve) => {
        const sub = service.watch!('s', 'k')(() => {
          sub.dispose();
          resolve();
        });
      });
      await settle();
      await service.write('s', 'k', enc.encode('v'));
      await expect(fired).resolves.toBeUndefined();
    });

    it('watch does not fire for an unrelated key', async ({ skip }) => {
      if (service.watch === undefined) skip();
      let count = 0;
      const sub = service.watch!('s', 'k')(() => {
        count++;
      });
      await service.write('s', 'other', enc.encode('v'));
      await new Promise((r) => setTimeout(r, 300));
      sub.dispose();
      expect(count).toBe(0);
    });

    it('watch fires when a watched key is deleted', async ({ skip }) => {
      if (service.watch === undefined) skip();
      await service.write('s', 'k', enc.encode('x'));
      const fired = new Promise<void>((resolve) => {
        const sub = service.watch!('s', 'k')(() => {
          sub.dispose();
          resolve();
        });
      });
      await settle();
      await service.delete('s', 'k');
      await expect(fired).resolves.toBeUndefined();
    });
  });
}

storageServiceSuite('InMemoryStorageService', async () => ({
  service: new InMemoryStorageService(),
}));

storageServiceSuite('FileStorageService', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'storage-service-test-'));
  return {
    service: new FileStorageService(dir),
    cleanup: () => rm(dir, { recursive: true, force: true }),
  };
});

describe('FileStorageService', () => {
  it('treats directory fsync on a removed scope dir as a no-op', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'storage-service-test-'));
    try {
      const service = new FileStorageService(dir);
      await expect(
        (service as unknown as { syncDirOnce(dir: string): Promise<void> }).syncDirOnce(
          join(dir, 'missing'),
        ),
      ).resolves.toBeUndefined();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

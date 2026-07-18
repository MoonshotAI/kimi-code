import { mkdtemp, mkdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';

import { join } from 'pathe';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { FileStorageService } from '#/persistence/backends/node-fs/fileStorageService';

const isWin = process.platform === 'win32';
const encoder = new TextEncoder();

describe('FileStorageService — file permissions', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'fss-perm-'));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it.skipIf(isWin)('creates scope directories with dirMode (0700)', async () => {
    const svc = new FileStorageService(dir, 0o700, 0o600);
    await svc.write('cron/ws', 'abc.json', encoder.encode('{}'));

    const dirStat = await stat(join(dir, 'cron/ws'));
    expect(dirStat.mode & 0o777).toBe(0o700);
  });

  it.skipIf(isWin)('writes documents with fileMode (0600)', async () => {
    const svc = new FileStorageService(dir, 0o700, 0o600);
    await svc.write('cron/ws', 'abc.json', encoder.encode('{"x":1}'));

    const fileStat = await stat(join(dir, 'cron/ws', 'abc.json'));
    expect(fileStat.mode & 0o777).toBe(0o600);
  });

  it.skipIf(isWin)('defaults to the process umask when modes are omitted', async () => {
    const svc = new FileStorageService(dir);
    await svc.write('scope', 'k.json', encoder.encode('{}'));
    const fileStat = await stat(join(dir, 'scope', 'k.json'));
    expect(fileStat.mode & 0o400).toBe(0o400);
  });
});

describe('FileStorageService — error translation', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'fss-err-'));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('keeps ENOENT semantics: read returns undefined, list returns []', async () => {
    const svc = new FileStorageService(dir);
    expect(await svc.read('scope', 'missing.json')).toBeUndefined();
    expect(await svc.list('missing-scope')).toEqual([]);
    await expect(svc.delete('scope', 'missing.json')).resolves.toBeUndefined();
  });

  it.skipIf(isWin)('translates non-ENOENT failures into StorageError(io_failed)', async () => {
    const svc = new FileStorageService(dir);
    await mkdir(join(dir, 'scope', 'adir'), { recursive: true });
    await expect(svc.read('scope', 'adir')).rejects.toSatisfy((error: unknown) => {
      expect(error).toMatchObject({ code: 'storage.io_failed' });
      const io = error as { details?: Record<string, unknown>; cause?: unknown };
      expect(io.details).toMatchObject({
        path: join(dir, 'scope', 'adir'),
        op: 'read',
        errno: 'EISDIR',
      });
      expect(io.cause).toBeInstanceOf(Error);
      return true;
    });
  });

  it.skipIf(isWin)('translates write failures into StorageError(io_failed)', async () => {
    const svc = new FileStorageService(dir);
    await writeFile(join(dir, 'blocked'), 'x');
    await expect(svc.write('blocked', 'k.json', encoder.encode('{}'))).rejects.toMatchObject({
      code: 'storage.io_failed',
      details: { op: 'write', errno: expect.any(String) },
    });
  });
});

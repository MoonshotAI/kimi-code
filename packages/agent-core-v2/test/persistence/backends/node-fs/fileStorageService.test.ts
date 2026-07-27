import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';

import { join } from 'pathe';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { Error2, ErrorCodes } from '#/errors';
import { CrossProcessLockService } from '#/os/backends/node-local/crossProcessLockService';
import { FileStorageService } from '#/persistence/backends/node-fs/fileStorageService';
import { StorageWriteAdmissionService } from '#/persistence/backends/node-fs/storageWriteAdmissionService';
import type { ISessionWriteAdmission } from '#/persistence/interface/sessionWriteAdmission';

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

describe('FileStorageService — session write admission', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'fss-fence-'));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('runs write, append, and delete through session write admission', async () => {
    const registry = new StorageWriteAdmissionService();
    let writable = true;
    const assertCanWriteNow = (): void => {
      if (!writable) {
        throw new Error2(ErrorCodes.SESSION_LEASE_LOST, 'session lease lost');
      }
    };
    const admission: ISessionWriteAdmission = {
      _serviceBrand: undefined,
      assertCanWriteNow,
      withPhysicalWrite: async (io) => {
        assertCanWriteNow();
        return io();
      },
      sealAndDrain: async () => {},
    };
    const registration = registry.registerSession('sessions/workspace/session', admission);
    expect(() => registry.registerSession('sessions/workspace/session', admission)).toThrow(
      /already registered/,
    );
    const svc = new FileStorageService(dir, undefined, undefined, undefined, registry);
    const scope = 'sessions/workspace/session/agents/main/tool-results';

    await svc.write(scope, 'result.txt', encoder.encode('a'));
    await svc.append(scope, 'result.txt', encoder.encode('b'));
    expect(await readFile(join(dir, scope, 'result.txt'), 'utf8')).toBe('ab');

    writable = false;
    await expect(svc.write(scope, 'result.txt', encoder.encode('c'))).rejects.toMatchObject({
      code: ErrorCodes.SESSION_LEASE_LOST,
    });
    await expect(svc.append(scope, 'result.txt', encoder.encode('c'))).rejects.toMatchObject({
      code: ErrorCodes.SESSION_LEASE_LOST,
    });
    await expect(svc.delete(scope, 'result.txt')).rejects.toMatchObject({
      code: ErrorCodes.SESSION_LEASE_LOST,
    });
    expect(await readFile(join(dir, scope, 'result.txt'), 'utf8')).toBe('ab');
    registration.dispose();
    await expect(svc.append(scope, 'result.txt', encoder.encode('c'))).rejects.toMatchObject({
      code: ErrorCodes.SESSION_LEASE_LOST,
    });
  });

  it('fails closed without session admission and leaves non-session scopes unrestricted', async () => {
    const registry = new StorageWriteAdmissionService();
    const svc = new FileStorageService(dir, undefined, undefined, undefined, registry);

    await expect(
      svc.write('sessions/workspace/session/agents/main/blobs', 'blob', encoder.encode('x')),
    ).rejects.toMatchObject({ code: ErrorCodes.SESSION_LEASE_LOST });
    await expect(svc.write('cron/workspace', 'task.json', encoder.encode('{}'))).resolves.toBeUndefined();
  });

  it('revalidates session admission after acquiring the exclusive key mutation', async () => {
    const registry = new StorageWriteAdmissionService();
    let checks = 0;
    const admission: ISessionWriteAdmission = {
      _serviceBrand: undefined,
      assertCanWriteNow: () => {
        checks++;
        if (checks > 1) {
          throw new Error2(
            ErrorCodes.SESSION_LEASE_LOST,
            'session admission sealed while waiting',
          );
        }
      },
      withPhysicalWrite: (io) => io(),
      sealAndDrain: async () => {},
    };
    registry.registerSession('sessions/workspace/session', admission);
    const svc = new FileStorageService(
      dir,
      undefined,
      undefined,
      new CrossProcessLockService(),
      registry,
    );
    let mutationRan = false;

    await expect(
      svc.withExclusiveKeyMutation(
        'sessions/workspace/session',
        'state.json',
        async () => {
          mutationRan = true;
        },
      ),
    ).rejects.toMatchObject({ code: ErrorCodes.SESSION_LEASE_LOST });
    expect(mutationRan).toBe(false);
  });
});

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { LocalKaos } from '@moonshot-ai/kaos';

import type { ILogService, ILogger } from '#/log/log';

import { SessionKaosService } from '#/kaos/sessionKaosService';
import { FsService } from '#/fs/fsService';

const noopLogger: ILogger = {
  error: () => {},
  warn: () => {},
  info: () => {},
  debug: () => {},
  child: () => noopLogger,
};
const noopLog: ILogService = {
  ...noopLogger,
  _serviceBrand: undefined,
  level: 'info',
  setLevel: () => {},
};

describe('FsService', () => {
  let dir: string;
  let fs: FsService;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'fs-test-'));
    const base = await LocalKaos.create();
    const sessionKaos = new SessionKaosService(noopLog);
    sessionKaos.setToolKaos(base.withCwd(dir));
    fs = new FsService(sessionKaos, noopLog);
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('write then read round-trips', async () => {
    await fs.write('hello.txt', 'world');
    expect(await fs.read('hello.txt')).toBe('world');
  });

  it('mkdir creates a directory', async () => {
    await fs.mkdir('sub/deep');
    const st = (await fs.stat('sub/deep')) as { isDirectory?: () => boolean };
    expect(typeof st).toBe('object');
  });
});

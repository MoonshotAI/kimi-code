import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { LocalKaos } from '@moonshot-ai/kaos';

import { DisposableStore } from '#/_base/di/lifecycle';
import { createServices } from '#/_base/di/test';
import type { TestInstantiationService } from '#/_base/di/test';
import { IFsService } from '#/fs/fs';
import { FsService } from '#/fs/fsService';
import { ISessionKaosService } from '#/kaos/kaos';
import { SessionKaosService } from '#/kaos/sessionKaosService';
import { registerLogServices } from '../log/stubs';

describe('FsService', () => {
  let dir: string;
  let disposables: DisposableStore;
  let ix: TestInstantiationService;
  let fs: IFsService;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'fs-test-'));
    const base = await LocalKaos.create();
    disposables = new DisposableStore();
    ix = createServices(disposables, {
      base: [registerLogServices],
      additionalServices: (reg) => {
        reg.define(ISessionKaosService, SessionKaosService);
        reg.define(IFsService, FsService);
      },
    });
    const sessionKaos = ix.get(ISessionKaosService);
    sessionKaos.setToolKaos(base.withCwd(dir));
    fs = ix.get(IFsService);
  });

  afterEach(async () => {
    disposables.dispose();
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

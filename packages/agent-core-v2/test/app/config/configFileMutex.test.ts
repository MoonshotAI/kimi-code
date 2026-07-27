/**
 * Scenario: config.toml atomic read-modify-write.
 *
 * Two independent `ConfigService` instances share one storage root on the real
 * filesystem. The atomic-document Store owns cross-process exclusion, so
 * interleaved writes merge without lost updates and `ConfigService` never
 * handles lock paths or lock services itself. Watch-based reloads ride real
 * chokidar (150ms debounce), so assertions poll with real timers.
 */

import { existsSync, readFileSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { SyncDescriptor } from '#/_base/di/descriptors';
import { DisposableStore } from '#/_base/di/lifecycle';
import { TestInstantiationService } from '#/_base/di/test';
import { ILogService } from '#/_base/log/log';
import { IBootstrapService } from '#/app/bootstrap/bootstrap';
import { IConfigRegistry, IConfigService } from '#/app/config/config';
import { ConfigRegistry, ConfigService } from '#/app/config/configService';
import { CrossProcessLockService } from '#/os/backends/node-local/crossProcessLockService';
import {
  CrossProcessLockErrorCode,
  type ICrossProcessLockService,
  type ICrossProcessLockHandle,
} from '#/os/interface/crossProcessLock';
import { TomlAtomicDocumentStore } from '#/persistence/backends/node-fs/atomicDocumentStore';
import { FileStorageService } from '#/persistence/backends/node-fs/fileStorageService';
import { IAtomicTomlDocumentStore } from '#/persistence/interface/atomicDocumentStore';
import {
  IFileSystemStorageService,
  StorageErrors,
} from '#/persistence/interface/storage';

import { stubLog } from '../../_base/log/stubs';
import { stubBootstrap } from '../bootstrap/stubs';

const realSleep = (ms: number): Promise<void> =>
  new Promise((resolvePromise) => setTimeout(resolvePromise, ms));

async function waitFor(cond: () => boolean, timeoutMs = 5_000): Promise<void> {
  const start = Date.now();
  for (;;) {
    if (cond()) return;
    if (Date.now() - start > timeoutMs) throw new Error('waitFor timed out');
    await realSleep(25);
  }
}

describe('ConfigService config.toml lock-in-RMW', () => {
  let homeDir: string;
  let disposables: DisposableStore;

  beforeEach(async () => {
    homeDir = await mkdtemp(join(tmpdir(), 'config-rmw-'));
    disposables = new DisposableStore();
  });

  afterEach(async () => {
    disposables.dispose();
    await rm(homeDir, { recursive: true, force: true });
  });

  function createContainer(
    lock: ICrossProcessLockService = new CrossProcessLockService(),
    configPath = join(homeDir, 'config.toml'),
  ): IConfigService {
    const ix = disposables.add(new TestInstantiationService());
    ix.stub(ILogService, stubLog());
    ix.stub(IBootstrapService, {
      ...stubBootstrap(homeDir, {}),
      configPath,
      configKey: relative(homeDir, configPath),
    });
    ix.stub(
      IFileSystemStorageService,
      new FileStorageService(homeDir, undefined, undefined, lock),
    );
    ix.set(IAtomicTomlDocumentStore, new SyncDescriptor(TomlAtomicDocumentStore));
    ix.set(IConfigRegistry, new SyncDescriptor(ConfigRegistry));
    ix.set(IConfigService, new SyncDescriptor(ConfigService));
    return ix.get(IConfigService);
  }

  it('two containers interleave set()s without losing section updates', async () => {
    await writeFile(join(homeDir, 'config.toml'), '[hand_written]\nkeep = "me"\n');
    const a = createContainer();
    const b = createContainer();
    await a.ready;
    await b.ready;

    const rounds = 4;
    for (let i = 0; i < rounds; i++) {
      await Promise.all([a.set(`alphaSide${i}`, { v: i }), b.set(`betaSide${i}`, { v: i })]);
    }

    const toml = readFileSync(join(homeDir, 'config.toml'), 'utf8');
    expect(toml).toContain('[hand_written]');
    for (let i = 0; i < rounds; i++) {
      expect(toml).toContain(`[alpha_side${i}]`);
      expect(toml).toContain(`[beta_side${i}]`);
    }

    await a.reload();
    await b.reload();
    expect(b.get('alphaSide0')).toEqual({ v: 0 });
    expect(a.get('betaSide3')).toEqual({ v: 3 });
  });

  it('writes and locks a custom config path at its actual location', async () => {
    const configPath = join(homeDir, 'nested', 'custom.toml');
    const config = createContainer(new CrossProcessLockService(), configPath);
    await config.set('alphaSection', { one: 1 });

    expect(readFileSync(configPath, 'utf8')).toContain('[alpha_section]');
    expect(existsSync(join(homeDir, 'custom.toml'))).toBe(false);
    expect(existsSync(`${configPath}.lock`)).toBe(true);
  });

  it('fails set() with storage.locked while another holder is stuck, leaving config.toml intact', async () => {
    let nowValue = 1_000_000;
    let lockSeq = 0;
    const victim = new CrossProcessLockService({
      selfPid: 1001,
      instanceId: 'victim',
      now: () => nowValue,
      newLockId: () => `victim-${++lockSeq}`,
      sleep: (ms) => {
        nowValue += ms;
        return Promise.resolve();
      },
    });
    const config = createContainer(victim);
    await config.set('seedSection', { ok: true });
    const before = readFileSync(join(homeDir, 'config.toml'), 'utf8');

    const attacker = new CrossProcessLockService({
      selfPid: 2002,
      instanceId: 'attacker',
      newLockId: () => 'attacker-lock',
    });
    const lockPath = join(homeDir, 'config.toml.lock');
    const handle: ICrossProcessLockHandle = await attacker.acquire(lockPath);
    try {
      await expect(config.set('blockedSection', { no: true })).rejects.toMatchObject({
        code: StorageErrors.codes.STORAGE_LOCKED,
        cause: { code: CrossProcessLockErrorCode.WaitTimeout },
      });
      expect(readFileSync(join(homeDir, 'config.toml'), 'utf8')).toBe(before);
    } finally {
      handle.release();
    }
    expect(existsSync(lockPath)).toBe(true);
  });
});

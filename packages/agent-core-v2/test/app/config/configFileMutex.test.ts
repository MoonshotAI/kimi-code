/**
 * Scenario: config.toml cross-process lock-in-RMW (design:
 * .tmp/refactor-watch-design-v2.md §3.6).
 *
 * Two independent `ConfigService` instances share one home dir on the real
 * filesystem; interleaved writes must merge without lost updates, the lock
 * file must be released after each critical section, and a held lock must
 * surface OS_LOCK_WAIT_TIMEOUT while leaving config.toml intact. Watch-based
 * reloads ride real chokidar (150ms debounce), so assertions poll with real
 * timers. Run with `pnpm --filter @moonshot-ai/agent-core-v2 exec vitest run
 * test/app/config/configFileMutex.test.ts`.
 */

import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

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
  ICrossProcessLockService,
  type ICrossProcessLockHandle,
} from '#/os/interface/crossProcessLock';
import { TomlAtomicDocumentStore } from '#/persistence/backends/node-fs/atomicDocumentStore';
import { FileStorageService } from '#/persistence/backends/node-fs/fileStorageService';
import { IAtomicTomlDocumentStore } from '#/persistence/interface/atomicDocumentStore';
import { IFileSystemStorageService } from '#/persistence/interface/storage';

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

  function createContainer(lock?: ICrossProcessLockService): IConfigService {
    const ix = disposables.add(new TestInstantiationService());
    ix.stub(ILogService, stubLog());
    ix.stub(IBootstrapService, stubBootstrap(homeDir, {}));
    ix.stub(IFileSystemStorageService, new FileStorageService(homeDir));
    ix.set(IAtomicTomlDocumentStore, new SyncDescriptor(TomlAtomicDocumentStore));
    ix.stub(ICrossProcessLockService, lock ?? new CrossProcessLockService());
    ix.set(IConfigRegistry, new SyncDescriptor(ConfigRegistry));
    ix.set(IConfigService, new SyncDescriptor(ConfigService));
    return ix.get(IConfigService);
  }

  it('merges repeated set()s of different sections within one container', async () => {
    const config = createContainer();
    await config.set('alphaSection', { one: 1 });
    await config.set('betaSection', { two: 2 });

    const toml = readFileSync(join(homeDir, 'config.toml'), 'utf8');
    expect(toml).toContain('[alpha_section]');
    expect(toml).toContain('[beta_section]');
    expect(config.get('alphaSection')).toEqual({ one: 1 });
    expect(config.get('betaSection')).toEqual({ two: 2 });

    await config.reload();
    expect(config.get('alphaSection')).toEqual({ one: 1 });
    expect(config.get('betaSection')).toEqual({ two: 2 });
  });

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

    // Each container's own watcher reloads the other side's sections.
    await waitFor(() => {
      for (let i = 0; i < rounds; i++) if (b.get(`alphaSide${i}`) === undefined) return false;
      return true;
    });
    await waitFor(() => {
      for (let i = 0; i < rounds; i++) if (a.get(`betaSide${i}`) === undefined) return false;
      return true;
    });
    expect(b.get('alphaSide0')).toEqual({ v: 0 });
    expect(a.get('betaSide3')).toEqual({ v: 3 });
  });

  it('releases config.toml.lock after the critical section and leaves no stale files', async () => {
    const config = createContainer();
    await config.set('alphaSection', { one: 1 });
    await config.set('betaSection', { two: 2 });

    expect(existsSync(join(homeDir, 'config.toml.lock'))).toBe(false);
    expect(readdirSync(homeDir).filter((entry) => entry.includes('.stale.'))).toEqual([]);
  });

  it('fails set() with OS_LOCK_WAIT_TIMEOUT while another holder is stuck, leaving config.toml intact', async () => {
    let nowValue = 1_000_000;
    let lockSeq = 0;
    const victim = new CrossProcessLockService({
      selfPid: 1001,
      instanceId: 'victim',
      probeProcess: () => ({ alive: true }),
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
      probeProcess: () => ({ alive: true }),
      newLockId: () => 'attacker-lock',
    });
    const lockPath = join(homeDir, 'config.toml.lock');
    const handle: ICrossProcessLockHandle = attacker.acquire(lockPath);
    try {
      await expect(config.set('blockedSection', { no: true })).rejects.toMatchObject({
        code: CrossProcessLockErrorCode.WaitTimeout,
      });
      expect(readFileSync(join(homeDir, 'config.toml'), 'utf8')).toBe(before);
    } finally {
      handle.release();
    }
    expect(existsSync(lockPath)).toBe(false);
  });
});

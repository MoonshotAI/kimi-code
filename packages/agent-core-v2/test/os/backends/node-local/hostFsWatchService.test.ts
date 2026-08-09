/**
 * Scenario: precise host watches and coarse native signal watches.
 * Responsibilities: event delivery, filtering, recovery, disposal, and the
 * macOS descriptor bound. Wiring: real temporary files for integration and an
 * injected native-watch boundary with a manual retry scheduler for recovery.
 * Run: `pnpm --filter @moonshot-ai/agent-core-v2 exec vitest run
 * test/os/backends/node-local/hostFsWatchService.test.ts`.
 */

import { readdirSync } from 'node:fs';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  resetUnexpectedErrorHandler,
  setUnexpectedErrorHandler,
} from '#/_base/errors/unexpectedError';
import { HostFsWatchService } from '#/os/backends/node-local/hostFsWatchService';
import type {
  HostFsChange,
  IHostFsWatchHandle,
  IHostFsWatchService,
} from '#/os/interface/hostFsWatch';

const wait = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

type HostFsWatchRuntime = NonNullable<ConstructorParameters<typeof HostFsWatchService>[0]>;

class TestNativeWatcher {
  private errorListener: ((error: NodeJS.ErrnoException) => void) | undefined;
  closed = false;

  on(_event: 'error', listener: (error: NodeJS.ErrnoException) => void): this {
    this.errorListener = listener;
    return this;
  }

  close(): void {
    this.closed = true;
  }

  fail(code = 'EIO'): void {
    this.errorListener?.(Object.assign(new Error('native watch failed'), { code }));
  }
}

interface TestNativeAttempt {
  readonly watcher: TestNativeWatcher;
  emit(filename: string | null): void;
}

interface TestRetry {
  readonly delayMs: number;
  readonly active: boolean;
  run(): void;
}

function signalRig(options?: { readonly synchronousFailures?: number }): {
  readonly service: IHostFsWatchService;
  readonly attempts: TestNativeAttempt[];
  readonly retries: TestRetry[];
  attempt(index: number): TestNativeAttempt;
  retry(index: number): TestRetry;
} {
  const attempts: TestNativeAttempt[] = [];
  const retries: TestRetry[] = [];
  let synchronousFailures = options?.synchronousFailures ?? 0;
  const runtime: HostFsWatchRuntime = {
    platform: 'darwin',
    watchNative: (_root, listener) => {
      if (synchronousFailures > 0) {
        synchronousFailures -= 1;
        throw Object.assign(new Error('native watch creation failed'), { code: 'EIO' });
      }
      const watcher = new TestNativeWatcher();
      attempts.push({
        watcher,
        emit: (filename) => {
          listener('rename', filename);
        },
      });
      return watcher;
    },
    scheduleRetry: (callback, delayMs) => {
      let active = true;
      retries.push({
        delayMs,
        get active() {
          return active;
        },
        run: () => {
          if (!active) return;
          active = false;
          callback();
        },
      });
      return {
        dispose: () => {
          active = false;
        },
      };
    },
  };
  return {
    service: new HostFsWatchService(runtime),
    attempts,
    retries,
    attempt: (index) => requiredAt(attempts, index),
    retry: (index) => requiredAt(retries, index),
  };
}

function requiredAt<T>(values: readonly T[], index: number): T {
  const value = values[index];
  if (value === undefined) throw new Error(`missing test value at index ${index}`);
  return value;
}

describe('host filesystem change notifications', () => {
  let root: string;
  let handle: IHostFsWatchHandle | undefined;

  beforeEach(() => {
    setUnexpectedErrorHandler(() => undefined);
  });

  afterEach(async () => {
    handle?.dispose();
    handle = undefined;
    if (root) await rm(root, { recursive: true, force: true });
    root = '';
    resetUnexpectedErrorHandler();
  });

  async function start(recursive = true): Promise<HostFsChange[]> {
    const events: HostFsChange[] = [];
    const svc = new HostFsWatchService();
    handle = svc.watch(root, { recursive });
    handle.onDidChange((e) => events.push(e));
    await handle.ready;
    return events;
  }

  async function startSignal(ignored?: (path: string) => boolean): Promise<HostFsChange[]> {
    const events: HostFsChange[] = [];
    const svc = new HostFsWatchService();
    handle = svc.watch(root, { recursive: true, signal: true, ignored });
    handle.onDidChange((e) => events.push(e));
    await handle.ready;
    return events;
  }

  it('emits a coarse root invalidation when a native signal path changes', () => {
    const rig = signalRig();
    const events: HostFsChange[] = [];
    handle = rig.service.watch('/repo', { signal: true });
    handle.onDidChange((event) => events.push(event));

    rig.attempt(0).emit('skills/demo/SKILL.md');

    expect(events).toEqual([{ path: '/repo', action: 'modified', kind: 'directory' }]);
  });

  it('does not invalidate when a native signal path is ignored', () => {
    const rig = signalRig();
    const events: HostFsChange[] = [];
    handle = rig.service.watch('/repo', {
      signal: true,
      ignored: (path) => path.includes('node_modules'),
    });
    handle.onDidChange((event) => events.push(event));

    rig.attempt(0).emit('node_modules/pkg/index.js');

    expect(events).toEqual([]);
  });

  it('increases the retry delay after consecutive native failures', () => {
    const rig = signalRig();
    handle = rig.service.watch('/repo', { signal: true });

    rig.attempt(0).watcher.fail();
    rig.retry(0).run();
    rig.attempt(1).watcher.fail();
    rig.retry(1).run();
    rig.attempt(2).watcher.fail();

    expect(rig.retries.map((retry) => retry.delayMs)).toEqual([1000, 2000, 4000]);
  });

  it('invalidates again after a native watch is rearmed', () => {
    const rig = signalRig();
    const events: HostFsChange[] = [];
    handle = rig.service.watch('/repo', { signal: true });
    handle.onDidChange((event) => events.push(event));

    rig.attempt(0).watcher.fail();
    rig.retry(0).run();

    expect(events).toEqual([
      { path: '/repo', action: 'modified', kind: 'directory' },
      { path: '/repo', action: 'modified', kind: 'directory' },
    ]);
  });

  it('invalidates after recovering from a synchronous native-watch creation failure', () => {
    const rig = signalRig({ synchronousFailures: 1 });
    const events: HostFsChange[] = [];
    handle = rig.service.watch('/repo', { signal: true });
    handle.onDidChange((event) => events.push(event));

    rig.retry(0).run();

    expect(rig.attempts).toHaveLength(1);
    expect(events).toEqual([{ path: '/repo', action: 'modified', kind: 'directory' }]);
  });

  it('resets the retry delay after the recovered native watch emits an event', () => {
    const rig = signalRig();
    handle = rig.service.watch('/repo', { signal: true });

    rig.attempt(0).watcher.fail();
    rig.retry(0).run();
    rig.attempt(1).emit('skills/demo/SKILL.md');
    rig.attempt(1).watcher.fail();

    expect(rig.retries.map((retry) => retry.delayMs)).toEqual([1000, 1000]);
  });

  it('cancels a pending native retry when the watch handle is disposed', () => {
    const rig = signalRig();
    handle = rig.service.watch('/repo', { signal: true });
    rig.attempt(0).watcher.fail();

    handle.dispose();
    handle = undefined;
    rig.retry(0).run();

    expect(rig.retry(0).active).toBe(false);
    expect(rig.attempt(0).watcher.closed).toBe(true);
    expect(rig.attempts).toHaveLength(1);
  });

  it('reports create / modify / delete for a file', async () => {
    root = await mkdtemp(join(tmpdir(), 'hostfswatch-'));
    const events = await start();

    const file = join(root, 'a.txt');
    await writeFile(file, 'v1');
    await wait(300);
    await writeFile(file, 'v2');
    await wait(300);
    await rm(file);
    await wait(300);

    const actions = events.filter((e) => e.path === file).map((e) => e.action);
    expect(actions).toContain('created');
    expect(actions).toContain('modified');
    expect(actions).toContain('deleted');
    expect(events.find((e) => e.path === file)?.kind).toBe('file');
  });

  it('does not fire for paths ignored by default (.git)', async () => {
    root = await mkdtemp(join(tmpdir(), 'hostfswatch-'));
    const events = await start();

    await mkdir(join(root, '.git'));
    await writeFile(join(root, '.git', 'config'), 'x');
    await wait(300);

    expect(events.some((e) => e.path.includes('/.git/') || e.path.endsWith('/.git'))).toBe(false);
  });

  it('does not fire for pre-existing files (ignoreInitial)', async () => {
    root = await mkdtemp(join(tmpdir(), 'hostfswatch-'));
    const preexisting = join(root, 'pre.txt');
    await writeFile(preexisting, 'v0');

    const events = await start();
    await wait(300);

    expect(events.some((e) => e.path === preexisting)).toBe(false);
  });

  it('stops firing after the handle is disposed', async () => {
    root = await mkdtemp(join(tmpdir(), 'hostfswatch-'));
    const events = await start();

    handle?.dispose();
    handle = undefined;

    await writeFile(join(root, 'after-dispose.txt'), 'x');
    await wait(300);

    expect(events).toHaveLength(0);
  });

  it.skipIf(process.platform !== 'darwin')(
    'signal mode keeps the fd footprint bounded on a fat subtree',
    async () => {
      root = await mkdtemp(join(tmpdir(), 'hostfswatch-fat-'));
      const fat = join(root, 'fat');
      await mkdir(fat, { recursive: true });
      for (let i = 0; i < 1200; i++) {
        await writeFile(join(fat, `f${i}.txt`), 'x');
      }

      const fdsBefore = readdirSync('/dev/fd').length;
      await startSignal();
      const fdsAfter = readdirSync('/dev/fd').length;

      expect(fdsAfter - fdsBefore).toBeLessThan(50);
    },
    30000,
  );
});

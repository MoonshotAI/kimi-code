import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import type { NativeFsWatcher, WatchHandle, WatchRuntime } from '../../../src/human/utils/watch';
import { createWatchService } from '../../../src/human/utils/watch';

interface FakeWatchRuntime {
  readonly runtime: WatchRuntime;
  readonly reportedErrors: unknown[];
  readonly retryCallbacks: Array<() => void>;
  watchCalls(): number;
}

function fakeWatchRuntime(errorForCall: (call: number) => NodeJS.ErrnoException | undefined): FakeWatchRuntime {
  const reportedErrors: unknown[] = [];
  const retryCallbacks: Array<() => void> = [];
  let calls = 0;
  const runtime: WatchRuntime = {
    platform: 'darwin',
    watchNative: () => {
      const error = errorForCall(calls++);
      if (error !== undefined) throw error;
      const listeners = new Set<(error: NodeJS.ErrnoException) => void>();
      return {
        on: (event, listener) => {
          if (event === 'error') listeners.add(listener);
          return undefined as unknown as NativeFsWatcher;
        },
        close: () => {
          listeners.clear();
        },
      } as unknown as NativeFsWatcher;
    },
    scheduleRetry: (callback) => {
      retryCallbacks.push(callback);
      return { dispose: () => {} };
    },
    reportError: (error) => {
      reportedErrors.push(error);
    },
  };
  return {
    runtime,
    reportedErrors,
    retryCallbacks,
    watchCalls: () => calls,
  };
}

function errno(code: string): NodeJS.ErrnoException {
  return Object.assign(new Error(code), { code });
}

describe('createWatchService native failures', () => {
  const handles: WatchHandle[] = [];
  const tempDirs: string[] = [];

  afterEach(() => {
    for (const handle of handles.splice(0)) handle.dispose();
    for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  function watch(service: ReturnType<typeof createWatchService>, path: string): WatchHandle {
    const handle = service.watch(path, { listing: false });
    handles.push(handle);
    return handle;
  }

  it('forgives ENOENT for a missing target and settles ready without reporting', async () => {
    const fake = fakeWatchRuntime(() => errno('ENOENT'));
    const missing = join(tmpdir(), `kimi-watch-missing-${Date.now()}`);
    const handle = watch(createWatchService(fake.runtime), missing);

    await handle.ready;

    expect(fake.reportedErrors).toEqual([]);
    expect(fake.retryCallbacks.length).toBe(1);
  });

  it('forgives EPERM for a missing target on macOS and settles ready without reporting', async () => {
    const fake = fakeWatchRuntime(() => errno('EPERM'));
    const missing = join(tmpdir(), `kimi-watch-missing-${Date.now()}`);
    const handle = watch(createWatchService(fake.runtime), missing);

    await handle.ready;

    expect(fake.reportedErrors).toEqual([]);
    expect(fake.retryCallbacks.length).toBe(1);
  });

  it('reports EPERM when the watched path exists', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'kimi-watch-existing-'));
    tempDirs.push(dir);
    const fake = fakeWatchRuntime(() => errno('EPERM'));
    const handle = watch(createWatchService(fake.runtime), dir);

    await handle.ready;

    expect(fake.reportedErrors).toHaveLength(1);
    expect((fake.reportedErrors[0] as NodeJS.ErrnoException).code).toBe('EPERM');
    expect(fake.retryCallbacks.length).toBe(1);
  });

  it('reports EACCES for a missing target because only EPERM and ENOENT are forgiven', async () => {
    const missing = join(tmpdir(), `kimi-watch-missing-${Date.now()}`);
    const fake = fakeWatchRuntime(() => errno('EACCES'));
    const handle = watch(createWatchService(fake.runtime), missing);

    await handle.ready;

    expect(fake.reportedErrors).toHaveLength(1);
    expect((fake.reportedErrors[0] as NodeJS.ErrnoException).code).toBe('EACCES');
  });

  it('keeps retrying in the background after a forgiven failure', async () => {
    const fake = fakeWatchRuntime(() => errno('EPERM'));
    const missing = join(tmpdir(), `kimi-watch-missing-${Date.now()}`);
    const handle = watch(createWatchService(fake.runtime), missing);

    await handle.ready;
    expect(fake.watchCalls()).toBe(1);

    fake.retryCallbacks[0]!();
    await vi.waitFor(() => expect(fake.watchCalls()).toBe(2));
    await handle.ready;
    expect(fake.reportedErrors).toEqual([]);
  });
});

/* eslint-disable import/first -- vi.mock setup must run before the imports it stubs out. */
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  execFile: vi.fn(),
  resolveCommandPath: vi.fn(),
  watchers: [] as Array<{
    options: unknown;
    add: ReturnType<typeof vi.fn>;
    close: ReturnType<typeof vi.fn>;
    emit: (event: string) => void;
  }>,
}));

vi.mock('node:child_process', () => ({
  execFile: mocks.execFile,
}));

vi.mock('#/utils/process/resolve-command', () => ({
  resolveCommandPath: mocks.resolveCommandPath,
}));

vi.mock('chokidar', () => {
  class FSWatcher {
    options: unknown;
    add = vi.fn();
    close = vi.fn(() => Promise.resolve());
    private listeners = new Map<string, Array<() => void>>();

    constructor(options: unknown) {
      this.options = options;
      mocks.watchers.push(this);
    }

    on(event: string, cb: () => void): this {
      const list = this.listeners.get(event) ?? [];
      list.push(cb);
      this.listeners.set(event, list);
      return this;
    }

    emit(event: string): void {
      for (const cb of this.listeners.get(event) ?? []) cb();
    }
  }

  return { FSWatcher };
});

import type { GitPullRequest, GitStatusSummary } from '@moonshot-ai/kimi-code-sdk';

import { createGitStatusCache, formatGitBadge, type GitStatusSource } from '#/utils/git/git-status';

beforeEach(() => {
  mocks.resolveCommandPath.mockImplementation((command: string) => `/usr/bin/${command}`);
  mocks.execFile.mockImplementation(
    (_cmd: string, _args: string[], _options: unknown, callback: (error: Error | null, stdout: string) => void) => {
      callback(null, 'C:/repo/.git\n');
    },
  );
  mocks.watchers.length = 0;
});

afterEach(() => {
  vi.useRealTimers();
  vi.clearAllMocks();
});

async function drain(): Promise<void> {
  for (let i = 0; i < 30; i++) await Promise.resolve();
}

function summary(overrides: Partial<GitStatusSummary> = {}): GitStatusSummary {
  return { branch: 'main', dirty: false, ahead: 0, behind: 0, additions: 0, deletions: 0, ...overrides };
}

function fakeSource(
  status: () => Promise<GitStatusSummary | null>,
  pullRequest: () => Promise<GitPullRequest | null> = async () => null,
): GitStatusSource & { status: ReturnType<typeof vi.fn>; pullRequest: ReturnType<typeof vi.fn> } {
  return { status: vi.fn(status), pullRequest: vi.fn(pullRequest), localWorkDir: '/tmp/repo' };
}

describe('git status cache', () => {
  it('reads the cache without blocking and refreshes status on a 30s TTL', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-04-24T00:00:00Z'));
    const source = fakeSource(async () => summary({ dirty: true, ahead: 2, behind: 1, additions: 4, deletions: 1 }));

    const cache = createGitStatusCache(source);
    expect(source.status).not.toHaveBeenCalled();
    expect(cache.getStatus()).toBeNull();
    expect(source.status).not.toHaveBeenCalled();

    await drain();

    expect(cache.getStatus()).toEqual({
      branch: 'main',
      dirty: true,
      ahead: 2,
      behind: 1,
      diffAdded: 4,
      diffDeleted: 1,
      pullRequest: null,
    });
    expect(source.status).toHaveBeenCalledTimes(1);

    cache.getStatus();
    await drain();
    expect(source.status).toHaveBeenCalledTimes(1);

    vi.setSystemTime(new Date('2026-04-24T00:00:30Z'));
    cache.getStatus();
    await drain();
    expect(source.status).toHaveBeenCalledTimes(2);
    cache.dispose();
  });

  it('attaches the current pull request and keeps the status when the lookup fails', async () => {
    const onChange = vi.fn();
    const found = fakeSource(
      async () => summary({ branch: 'feature/footer' }),
      async () => ({ number: 12, url: 'https://github.com/acme/repo/pull/12', state: 'open' }),
    );
    const cache = createGitStatusCache(found, { onChange });
    cache.getStatus();
    await drain();
    expect(cache.getStatus()?.pullRequest).toEqual({ number: 12, url: 'https://github.com/acme/repo/pull/12' });
    expect(onChange).toHaveBeenCalled();
    cache.dispose();

    const failing = fakeSource(async () => summary(), () => Promise.reject(new Error('gh failed')));
    const kept = createGitStatusCache(failing);
    kept.getStatus();
    await drain();
    expect(kept.getStatus()).toMatchObject({ branch: 'main', pullRequest: null });
    kept.dispose();
  });

  it('polls only the local HEAD found through the resolved git path', async () => {
    const cache = createGitStatusCache(fakeSource(async () => summary()));
    cache.getStatus();
    await drain();

    expect(mocks.resolveCommandPath).toHaveBeenCalledWith('git', '/tmp/repo');
    expect(mocks.execFile).toHaveBeenCalledWith(
      '/usr/bin/git',
      ['-C', '/tmp/repo', 'rev-parse', '--absolute-git-dir'],
      expect.anything(),
      expect.any(Function),
    );
    expect(mocks.watchers).toHaveLength(1);
    expect(mocks.watchers[0]?.options).toEqual(
      expect.objectContaining({ usePolling: true, interval: 2_000, ignoreInitial: true }),
    );
    expect(mocks.watchers[0]?.add).toHaveBeenCalledWith(join('C:/repo/.git', 'HEAD'));
    cache.dispose();
    expect(mocks.watchers[0]?.close).toHaveBeenCalledTimes(1);
  });

  it('never touches the local machine for a remote source', async () => {
    const cache = createGitStatusCache({ ...fakeSource(async () => summary()), localWorkDir: undefined });
    cache.getStatus();
    await drain();
    expect(cache.getStatus()?.branch).toBe('main');
    expect(mocks.execFile).not.toHaveBeenCalled();
    expect(mocks.watchers).toHaveLength(0);
    cache.dispose();
  });

  it('returns null outside a git repo and on a detached HEAD', async () => {
    const notRepo = fakeSource(async () => null);
    const outside = createGitStatusCache(notRepo);
    outside.getStatus();
    await drain();
    expect(outside.getStatus()).toBeNull();
    outside.dispose();

    const detachedSource = fakeSource(async () => summary({ branch: '' }));
    const detached = createGitStatusCache(detachedSource);
    detached.getStatus();
    await drain();
    expect(detached.getStatus()).toBeNull();
    expect(detachedSource.pullRequest).not.toHaveBeenCalled();
    detached.dispose();
  });

  it('formats badges', () => {
    expect(
      formatGitBadge({
        branch: 'main',
        dirty: true,
        ahead: 2,
        behind: 1,
        diffAdded: 12,
        diffDeleted: 3,
        pullRequest: null,
      }),
    ).toBe('main [+12 -3 ↑2↓1]');
    expect(
      formatGitBadge({
        branch: 'main',
        dirty: true,
        ahead: 0,
        behind: 0,
        diffAdded: 0,
        diffDeleted: 0,
        pullRequest: null,
      }),
    ).toBe('main [±]');
  });

  it('refreshes when HEAD changes and when refresh() is called inside the TTL', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-04-24T00:00:00Z'));
    const source = fakeSource(async () => summary());
    const cache = createGitStatusCache(source);
    cache.getStatus();
    await drain();
    expect(source.status).toHaveBeenCalledTimes(1);

    mocks.watchers[0]?.emit('change');
    await drain();
    expect(source.status).toHaveBeenCalledTimes(2);

    cache.refresh();
    await drain();
    expect(source.status).toHaveBeenCalledTimes(3);
    expect(mocks.execFile).toHaveBeenCalledTimes(1);
    cache.dispose();
  });

  it('keeps the last good status when a later read fails', async () => {
    let fail = false;
    const source = fakeSource(async () => {
      if (fail) throw new Error('environment disconnected');
      return summary({ dirty: true, additions: 2, deletions: 1 });
    });
    const cache = createGitStatusCache(source);
    cache.getStatus();
    await drain();

    fail = true;
    cache.refresh();
    await drain();

    expect(source.status).toHaveBeenCalledTimes(2);
    expect(cache.getStatus()).toEqual({
      branch: 'main',
      dirty: true,
      ahead: 0,
      behind: 0,
      diffAdded: 2,
      diffDeleted: 1,
      pullRequest: null,
    });
    cache.dispose();
  });

  it('coalesces a forced refresh that arrives while one is in flight', async () => {
    const releases: Array<(value: GitStatusSummary) => void> = [];
    const source = fakeSource(() => new Promise((resolve) => releases.push(resolve)));
    const cache = createGitStatusCache(source);
    cache.getStatus();
    await drain();
    expect(source.status).toHaveBeenCalledTimes(1);

    cache.refresh();
    cache.refresh();
    releases[0]?.(summary());
    await drain();
    expect(source.status).toHaveBeenCalledTimes(2);

    releases[1]?.(summary({ branch: 'topic' }));
    await drain();
    expect(cache.getStatus()?.branch).toBe('topic');
    expect(source.status).toHaveBeenCalledTimes(2);
    cache.dispose();
  });

  it('formats pull request badges as terminal hyperlinks when requested', () => {
    const linked = formatGitBadge(
      {
        branch: 'feature/footer',
        dirty: false,
        ahead: 0,
        behind: 0,
        diffAdded: 0,
        diffDeleted: 0,
        pullRequest: {
          number: 12,
          url: 'https://github.com/acme/repo/pull/12',
        },
      },
      { linkPullRequest: true },
    );

    expect(linked).toContain('[PR#12]');
    expect(linked).toContain('\u001B]8;;https://github.com/acme/repo/pull/12\u0007');
    expect(linked).toContain('\u001B]8;;\u0007');
  });
});

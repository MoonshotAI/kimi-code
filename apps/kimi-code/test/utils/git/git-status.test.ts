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

import { createGitStatusCache, formatGitBadge } from '#/utils/git/git-status';

beforeEach(() => {
  mocks.resolveCommandPath.mockImplementation((command: string) => `/usr/bin/${command}`);
  mocks.watchers.length = 0;
});

afterEach(() => {
  vi.useRealTimers();
  vi.clearAllMocks();
});

async function drain(): Promise<void> {
  for (let i = 0; i < 30; i++) await Promise.resolve();
}

function gitCalls(subcommand: string): unknown[][] {
  return mocks.execFile.mock.calls.filter((call) => {
    const args = call[1] as string[];
    return call[0] === '/usr/bin/git' && args.includes(subcommand);
  });
}

function installGit(scripts: {
  gitDir?: string | null;
  status?: string | null;
  diff?: string | null;
  ghError?: Error | null;
  ghStdout?: string;
  holdStatus?: boolean;
}): { releaseStatus: (stdout: string | null) => void } {
  let releaseStatus: (stdout: string | null) => void = () => {};
  mocks.execFile.mockImplementation(
    (
      cmd: string,
      args: string[],
      _options: unknown,
      callback: (error: Error | null, stdout: string, stderr: string) => void,
    ) => {
      if (cmd === '/usr/bin/gh') {
        if (scripts.ghError !== undefined && scripts.ghError !== null) {
          callback(scripts.ghError, '', '');
          return;
        }
        callback(null, scripts.ghStdout ?? '', '');
        return;
      }
      if (args.includes('rev-parse')) {
        if (scripts.gitDir === null) {
          callback(Object.assign(new Error('not a repo'), { code: 128 }), '', '');
          return;
        }
        callback(null, `${scripts.gitDir ?? 'C:/repo/.git'}\n`, '');
        return;
      }
      if (args.includes('status')) {
        if (scripts.holdStatus === true) {
          releaseStatus = (stdout) => {
            if (stdout === null) {
              callback(Object.assign(new Error('status failed'), { code: 1 }), '', '');
              return;
            }
            callback(null, stdout, '');
          };
          return;
        }
        if (scripts.status === null) {
          callback(Object.assign(new Error('status failed'), { code: 1 }), '', '');
          return;
        }
        callback(null, scripts.status ?? '## main\n', '');
        return;
      }
      if (args.includes('diff')) {
        callback(null, scripts.diff ?? '', '');
        return;
      }
      callback(new Error('unexpected git command'), '', '');
    },
  );
  return { releaseStatus: (stdout) => releaseStatus(stdout) };
}

describe('git status cache', () => {
  it('reads the cache without blocking and refreshes status on a 30s TTL', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-04-24T00:00:00Z'));
    installGit({
      status: '## main...origin/main [ahead 2, behind 1]\n M src/app.ts\n',
      diff: '4\t1\tsrc/app.ts\n',
      ghError: new Error('no pull request'),
    });

    const cache = createGitStatusCache('/tmp/repo');
    expect(mocks.execFile).not.toHaveBeenCalled();
    expect(cache.getStatus()).toBeNull();
    expect(mocks.execFile).not.toHaveBeenCalled();

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
    expect(gitCalls('rev-parse')).toHaveLength(1);
    expect(gitCalls('status')).toHaveLength(1);
    expect(gitCalls('diff')).toHaveLength(1);
    expect(gitCalls('branch')).toHaveLength(0);
    expect(mocks.execFile).toHaveBeenCalledTimes(4);

    cache.getStatus();
    await drain();
    expect(gitCalls('status')).toHaveLength(1);

    vi.setSystemTime(new Date('2026-04-24T00:00:30Z'));
    cache.getStatus();
    await drain();
    expect(gitCalls('status')).toHaveLength(2);
    expect(gitCalls('rev-parse')).toHaveLength(1);
    cache.dispose();
  });

  it('reads uncommitted diff line counts and current pull request metadata', async () => {
    const onChange = vi.fn();
    installGit({
      status: '## feature/footer...origin/feature/footer\n M src/app.ts\n',
      diff: '10\t3\tsrc/app.ts\n-\t-\timage.png\n0\t5\tdeleted.ts\n',
      ghStdout: '{"number":12,"url":"https://github.com/acme/repo/pull/12"}\n',
    });

    const cache = createGitStatusCache('/tmp/repo', { onChange });
    cache.getStatus();
    await drain();

    expect(cache.getStatus()).toEqual({
      branch: 'feature/footer',
      dirty: true,
      ahead: 0,
      behind: 0,
      diffAdded: 10,
      diffDeleted: 8,
      pullRequest: {
        number: 12,
        url: 'https://github.com/acme/repo/pull/12',
      },
    });
    expect(onChange).toHaveBeenCalled();
    cache.dispose();
  });

  it('keeps the last status when gh lookup throws synchronously', async () => {
    const onChange = vi.fn();
    mocks.execFile.mockImplementation((cmd: string, args: string[], _options: unknown, callback: Function) => {
      if (cmd === '/usr/bin/gh') {
        throw Object.assign(new Error('spawn ENOTDIR'), { code: 'ENOTDIR' });
      }
      if (args.includes('rev-parse')) {
        callback(null, 'C:/repo/.git\n', '');
        return;
      }
      if (args.includes('status')) {
        callback(null, '## main...origin/main\n M src/app.ts\n', '');
        return;
      }
      if (args.includes('diff')) {
        callback(null, '2\t1\tsrc/app.ts\n', '');
      }
    });

    const cache = createGitStatusCache('/tmp/repo', { onChange });
    cache.getStatus();
    await drain();

    expect(cache.getStatus()).toEqual({
      branch: 'main',
      dirty: true,
      ahead: 0,
      behind: 0,
      diffAdded: 2,
      diffDeleted: 1,
      pullRequest: null,
    });
    expect(onChange).toHaveBeenCalledTimes(1);
    cache.dispose();
  });

  it('returns null without spawning when git cannot be resolved to a safe path', () => {
    mocks.resolveCommandPath.mockReturnValue(undefined);
    const cache = createGitStatusCache('/tmp/repo');
    expect(cache.getStatus()).toBeNull();
    expect(mocks.execFile).not.toHaveBeenCalled();
    expect(mocks.watchers).toHaveLength(0);
    cache.dispose();
  });

  it('spawns git and gh through their resolved absolute paths and polls only HEAD', async () => {
    installGit({
      gitDir: 'C:/repo/.git',
      status: '## main...origin/main\n',
      ghError: new Error('no pull request'),
    });

    const cache = createGitStatusCache('/tmp/repo');
    expect(mocks.execFile).not.toHaveBeenCalled();
    cache.getStatus();
    expect(mocks.execFile).not.toHaveBeenCalled();
    await drain();

    expect(mocks.resolveCommandPath).toHaveBeenCalledWith('git', '/tmp/repo');
    expect(mocks.execFile).toHaveBeenCalledWith(
      '/usr/bin/git',
      ['-C', '/tmp/repo', 'rev-parse', '--absolute-git-dir'],
      expect.anything(),
      expect.any(Function),
    );
    expect(mocks.execFile).toHaveBeenCalledWith(
      '/usr/bin/gh',
      expect.any(Array),
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

  it('returns null when the working directory is not a git repo and does not probe again', async () => {
    installGit({ gitDir: null });
    const cache = createGitStatusCache('/tmp/not-a-repo');
    expect(cache.getStatus()).toBeNull();
    await drain();

    expect(cache.getStatus()).toBeNull();
    expect(gitCalls('rev-parse')).toHaveLength(1);
    expect(mocks.watchers).toHaveLength(0);
    cache.getStatus();
    cache.refresh();
    await drain();
    expect(gitCalls('rev-parse')).toHaveLength(1);
    cache.dispose();
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

  it('parses an unborn branch and hides detached HEAD', async () => {
    installGit({ status: '## No commits yet on main\n' });
    const unborn = createGitStatusCache('/tmp/repo');
    unborn.getStatus();
    await drain();
    expect(unborn.getStatus()?.branch).toBe('main');
    unborn.dispose();

    mocks.watchers.length = 0;
    installGit({ status: '## HEAD (no branch)\n' });
    const detached = createGitStatusCache('/tmp/repo');
    detached.getStatus();
    await drain();
    expect(detached.getStatus()).toBeNull();
    expect(gitCalls('diff')).toHaveLength(0);
    detached.dispose();
  });

  it('refreshes when HEAD changes and when refresh() is called inside the TTL', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-04-24T00:00:00Z'));
    installGit({ status: '## main\n', ghError: new Error('no pull request') });
    const cache = createGitStatusCache('/tmp/repo');
    cache.getStatus();
    await drain();
    expect(gitCalls('status')).toHaveLength(1);

    mocks.watchers[0]?.emit('change');
    await drain();
    expect(gitCalls('status')).toHaveLength(2);

    cache.refresh();
    await drain();
    expect(gitCalls('status')).toHaveLength(3);
    expect(gitCalls('rev-parse')).toHaveLength(1);
    cache.dispose();
  });

  it('keeps the last good status when a later status command fails', async () => {
    installGit({
      status: '## main\n M src/app.ts\n',
      diff: '2\t1\tsrc/app.ts\n',
      ghError: new Error('no pull request'),
    });
    const cache = createGitStatusCache('/tmp/repo');
    cache.getStatus();
    await drain();

    installGit({ status: null, ghError: new Error('no pull request') });
    cache.refresh();
    await drain();

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
    const held = installGit({ holdStatus: true, ghError: new Error('no pull request') });
    const cache = createGitStatusCache('/tmp/repo');
    cache.getStatus();
    await drain();
    expect(gitCalls('status')).toHaveLength(1);

    cache.refresh();
    cache.refresh();
    held.releaseStatus('## main\n');
    await drain();
    expect(gitCalls('status')).toHaveLength(2);

    held.releaseStatus('## topic\n');
    await drain();
    expect(cache.getStatus()?.branch).toBe('topic');
    expect(gitCalls('status')).toHaveLength(2);
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

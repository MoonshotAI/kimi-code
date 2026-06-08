/* eslint-disable import/first -- vi.mock setup must run before the imports it stubs out. */
import { afterEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  spawnSync: vi.fn(),
  execFile: vi.fn(),
}));

vi.mock('node:child_process', () => ({
  execFile: mocks.execFile,
  spawnSync: mocks.spawnSync,
}));

import { createGitStatusCache, formatGitBadge } from '#/utils/git/git-status';

afterEach(() => {
  vi.useRealTimers();
  vi.clearAllMocks();
});

describe('git status cache', () => {
  it('caches branch and status reads until their TTL expires', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-04-24T00:00:00Z'));
    mocks.execFile.mockImplementation(
      (
        _cmd: string,
        _args: string[],
        _options: unknown,
        callback: (error: Error | null, stdout: string, stderr: string) => void,
      ) => {
        callback(new Error('no pull request'), '', '');
      },
    );
    mocks.spawnSync.mockImplementation((_cmd: string, args: string[]) => {
      if (args.includes('rev-parse')) {
        return { status: 0, stdout: 'true\n' };
      }
      if (args.includes('branch')) {
        return { status: 0, stdout: 'main\n' };
      }
      if (args.includes('status')) {
        return {
          status: 0,
          stdout: '## main...origin/main [ahead 2, behind 1]\n M src/app.ts\n',
        };
      }
      if (args.includes('diff')) {
        return { status: 0, stdout: '4\t1\tsrc/app.ts\n' };
      }
      return { status: 1, stdout: '' };
    });

    const cache = createGitStatusCache('/tmp/repo');

    expect(cache.getStatus()).toEqual({
      branch: 'main',
      dirty: true,
      ahead: 2,
      behind: 1,
      diffAdded: 4,
      diffDeleted: 1,
      pullRequest: null,
    });
    expect(cache.getStatus()).toEqual({
      branch: 'main',
      dirty: true,
      ahead: 2,
      behind: 1,
      diffAdded: 4,
      diffDeleted: 1,
      pullRequest: null,
    });
    expect(mocks.spawnSync).toHaveBeenCalledTimes(4);
    expect(mocks.execFile).toHaveBeenCalledTimes(1);

    await Promise.resolve();

    vi.setSystemTime(new Date('2026-04-24T00:00:06Z'));
    cache.getStatus();
    expect(mocks.spawnSync).toHaveBeenCalledTimes(5);
    expect(mocks.execFile).toHaveBeenCalledTimes(1);

    vi.setSystemTime(new Date('2026-04-24T00:00:16Z'));
    cache.getStatus();
    expect(mocks.spawnSync).toHaveBeenCalledTimes(8);
    expect(mocks.execFile).toHaveBeenCalledTimes(1);
  });

  it('reads uncommitted diff line counts and current pull request metadata', async () => {
    const onChange = vi.fn();
    mocks.execFile.mockImplementation(
      (
        _cmd: string,
        _args: string[],
        _options: unknown,
        callback: (error: Error | null, stdout: string, stderr: string) => void,
      ) => {
        callback(null, '{"number":12,"url":"https://github.com/acme/repo/pull/12"}\n', '');
      },
    );
    mocks.spawnSync.mockImplementation((_cmd: string, args: string[]) => {
      if (args.includes('rev-parse')) {
        return { status: 0, stdout: 'true\n' };
      }
      if (args.includes('branch')) {
        return { status: 0, stdout: 'feature/footer\n' };
      }
      if (args.includes('status')) {
        return {
          status: 0,
          stdout: '## feature/footer...origin/feature/footer\n M src/app.ts\n',
        };
      }
      if (args.includes('diff')) {
        return {
          status: 0,
          stdout: '10\t3\tsrc/app.ts\n-\t-\timage.png\n0\t5\tdeleted.ts\n',
        };
      }
      return { status: 1, stdout: '' };
    });

    const cache = createGitStatusCache('/tmp/repo', { onChange });
    expect(cache.getStatus()).toEqual({
      branch: 'feature/footer',
      dirty: true,
      ahead: 0,
      behind: 0,
      diffAdded: 10,
      diffDeleted: 8,
      pullRequest: null,
    });

    await Promise.resolve();

    expect(onChange).toHaveBeenCalledTimes(1);
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
  });

  it('keeps footer git status working when gh pull-request lookup throws synchronously', async () => {
    const onChange = vi.fn();
    mocks.execFile.mockImplementation(() => {
      const error = Object.assign(new Error('spawn ENOTDIR'), { code: 'ENOTDIR' });
      throw error;
    });
    mocks.spawnSync.mockImplementation((_cmd: string, args: string[]) => {
      if (args.includes('rev-parse')) {
        return { status: 0, stdout: 'true\n' };
      }
      if (args.includes('branch')) {
        return { status: 0, stdout: 'main\n' };
      }
      if (args.includes('status')) {
        return {
          status: 0,
          stdout: '## main...origin/main\n M src/app.ts\n',
        };
      }
      if (args.includes('diff')) {
        return { status: 0, stdout: '2\t1\tsrc/app.ts\n' };
      }
      return { status: 1, stdout: '' };
    });

    const cache = createGitStatusCache('/tmp/repo', { onChange });

    expect(cache.getStatus()).toEqual({
      branch: 'main',
      dirty: true,
      ahead: 0,
      behind: 0,
      diffAdded: 2,
      diffDeleted: 1,
      pullRequest: null,
    });

    await Promise.resolve();

    expect(onChange).not.toHaveBeenCalled();
    expect(cache.getStatus()).toEqual({
      branch: 'main',
      dirty: true,
      ahead: 0,
      behind: 0,
      diffAdded: 2,
      diffDeleted: 1,
      pullRequest: null,
    });
  });

  it('returns null when the working directory is not a git repo and formats badges', () => {
    mocks.spawnSync.mockReturnValue({ status: 1, stdout: '' });
    expect(createGitStatusCache('/tmp/not-a-repo').getStatus()).toBeNull();
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

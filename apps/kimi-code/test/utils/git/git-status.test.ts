/* eslint-disable import/first -- vi.mock setup must run before the imports it stubs out. */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  spawnSync: vi.fn(),
  execFile: vi.fn(),
  resolveCommandPath: vi.fn(),
}));

vi.mock('node:child_process', () => ({
  execFile: mocks.execFile,
  spawnSync: mocks.spawnSync,
}));

vi.mock('#/utils/process/resolve-command', () => ({
  resolveCommandPath: mocks.resolveCommandPath,
}));

import { createGitStatusCache, formatGitBadge } from '#/utils/git/git-status';

beforeEach(() => {
  mocks.resolveCommandPath.mockImplementation((command: string) => `/usr/bin/${command}`);
});

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

    const cache = createGitStatusCache('/tmp/repo', { trusted: true });

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
    expect(mocks.spawnSync).toHaveBeenCalledTimes(12);
    expect(mocks.execFile).toHaveBeenCalledTimes(1);

    await Promise.resolve();

    vi.setSystemTime(new Date('2026-04-24T00:00:06Z'));
    cache.getStatus();
    expect(mocks.spawnSync).toHaveBeenCalledTimes(15);
    expect(mocks.execFile).toHaveBeenCalledTimes(1);

    vi.setSystemTime(new Date('2026-04-24T00:00:16Z'));
    cache.getStatus();
    expect(mocks.spawnSync).toHaveBeenCalledTimes(24);
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

    const cache = createGitStatusCache('/tmp/repo', { onChange, trusted: true });
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

    const cache = createGitStatusCache('/tmp/repo', { onChange, trusted: true });

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

  it('returns null without spawning when git cannot be resolved to a safe path', () => {
    mocks.resolveCommandPath.mockReturnValue(undefined);
    expect(createGitStatusCache('/tmp/repo', { trusted: true }).getStatus()).toBeNull();
    expect(mocks.spawnSync).not.toHaveBeenCalled();
    expect(mocks.execFile).not.toHaveBeenCalled();
  });

  it('spawns no git process until the workspace is trusted', () => {
    mocks.spawnSync.mockReturnValue({ status: 0, stdout: 'true\n' });
    const cache = createGitStatusCache('/tmp/repo');

    expect(cache.getStatus()).toBeNull();
    expect(mocks.spawnSync).not.toHaveBeenCalled();
    expect(mocks.execFile).not.toHaveBeenCalled();

    cache.setTrusted(true);
    expect(cache.getStatus()).not.toBeNull();
    expect(mocks.spawnSync).toHaveBeenCalled();
  });

  it('disables repo-local command config on every git invocation', async () => {
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
      if (args.includes('rev-parse')) return { status: 0, stdout: 'true\n' };
      if (args.includes('branch')) return { status: 0, stdout: 'main\n' };
      if (args.includes('status')) return { status: 0, stdout: '## main...origin/main\n M a.ts\n' };
      if (args.includes('diff')) return { status: 0, stdout: '1\t1\ta.ts\n' };
      return { status: 1, stdout: '' };
    });

    const cache = createGitStatusCache('/tmp/repo', { trusted: true });
    expect(cache.getStatus()).not.toBeNull();
    await Promise.resolve();

    const nullDevice = process.platform === 'win32' ? 'NUL' : '/dev/null';
    expect(mocks.spawnSync).toHaveBeenCalledTimes(12);
    for (const call of mocks.spawnSync.mock.calls) {
      const args = call[1] as string[];
      expect(args.slice(0, 4)).toEqual([
        '-c',
        'core.fsmonitor=false',
        '-c',
        `core.hooksPath=${nullDevice}`,
      ]);
    }
    const diffCall = mocks.spawnSync.mock.calls.find((call) =>
      (call[1] as string[]).includes('diff'),
    );
    expect(diffCall).toBeDefined();
    const diffArgs = diffCall![1] as string[];
    expect(diffArgs).toContain('--no-ext-diff');
    expect(diffArgs).toContain('--no-textconv');
  });

  it('neutralizes repo-configured filter drivers on every git invocation', async () => {
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
      if (args.includes('config')) {
        return {
          status: 0,
          stdout: args.includes('--worktree')
            ? 'filter.wt.process evil-helper\n'
            : 'filter.evil.clean touch /tmp/marker\nfilter.evil.process evil-helper\n',
        };
      }
      if (args.includes('rev-parse')) return { status: 0, stdout: 'true\n' };
      if (args.includes('branch')) return { status: 0, stdout: 'main\n' };
      if (args.includes('status')) return { status: 0, stdout: '## main...origin/main\n M a.ts\n' };
      if (args.includes('diff')) return { status: 0, stdout: '1\t1\ta.ts\n' };
      return { status: 1, stdout: '' };
    });

    const cache = createGitStatusCache('/tmp/repo', { trusted: true });
    expect(cache.getStatus()).not.toBeNull();
    await Promise.resolve();

    const invocations = mocks.spawnSync.mock.calls.map((call) => call[1] as string[]);
    const hardened = invocations.filter((args) => !args.includes('config'));
    expect(hardened.length).toBeGreaterThan(0);
    for (const args of hardened) {
      expect(args).toContain('filter.evil.clean=');
      expect(args).toContain('filter.evil.process=');
      expect(args).toContain('filter.wt.clean=');
      expect(args).toContain('filter.wt.process=');
    }
  });

  it('caches filter driver probes until the repo config changes', async () => {
    const root = mkdtempSync(join(tmpdir(), 'git-status-filters-'));
    mkdirSync(join(root, '.git'), { recursive: true });
    writeFileSync(join(root, '.git', 'config'), '[filter "evil"]\n\tclean = touch /tmp/m\n');
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
      if (args.includes('config')) {
        return { status: 0, stdout: 'filter.evil.clean touch /tmp/m\n' };
      }
      if (args.includes('rev-parse')) return { status: 0, stdout: 'true\n' };
      if (args.includes('branch')) return { status: 0, stdout: 'main\n' };
      if (args.includes('status')) return { status: 0, stdout: '## main...origin/main\n' };
      return { status: 1, stdout: '' };
    });

    try {
      vi.useFakeTimers();
      vi.setSystemTime(new Date('2026-04-24T00:00:00Z'));
      const probeCount = () =>
        mocks.spawnSync.mock.calls.filter((call) => (call[1] as string[]).includes('config'))
          .length;

      const cache = createGitStatusCache(root, { trusted: true });
      cache.getStatus();
      expect(probeCount()).toBe(2);

      vi.setSystemTime(new Date('2026-04-24T00:00:16Z'));
      cache.getStatus();
      expect(probeCount()).toBe(2);

      writeFileSync(join(root, '.git', 'config'), '[filter "evil"]\n\tclean = touch /tmp/marker\n');
      vi.setSystemTime(new Date('2026-04-24T00:00:32Z'));
      cache.getStatus();
      expect(probeCount()).toBe(4);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('spawns git and gh through their resolved absolute paths', async () => {
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
      if (args.includes('rev-parse')) return { status: 0, stdout: 'true\n' };
      if (args.includes('branch')) return { status: 0, stdout: 'main\n' };
      if (args.includes('status')) return { status: 0, stdout: '## main...origin/main\n' };
      return { status: 1, stdout: '' };
    });

    const cache = createGitStatusCache('/tmp/repo', { trusted: true });
    expect(cache.getStatus()).not.toBeNull();
    await Promise.resolve();

    expect(mocks.resolveCommandPath).toHaveBeenCalledWith('git', '/tmp/repo');
    for (const call of mocks.spawnSync.mock.calls) {
      expect(call[0]).toBe('/usr/bin/git');
    }
    expect(mocks.execFile).toHaveBeenCalledWith(
      '/usr/bin/gh',
      expect.any(Array),
      expect.anything(),
      expect.any(Function),
    );
  });

  it('returns null when the working directory is not a git repo and formats badges', () => {
    mocks.spawnSync.mockReturnValue({ status: 1, stdout: '' });
    expect(createGitStatusCache('/tmp/not-a-repo', { trusted: true }).getStatus()).toBeNull();
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

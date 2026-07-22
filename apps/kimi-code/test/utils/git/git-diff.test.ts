import { beforeEach, describe, expect, it, vi } from 'vitest';
import { execFile, spawnSync } from 'node:child_process';
import {
  GitDiffError,
  isInsideGitRepo,
  listChangedFiles,
  runGitDiffForFile,
  runGitNumstat,
  runUntrackedNumstat,
} from '#/utils/git/git-diff';

vi.mock('node:child_process', () => ({
  execFile: vi.fn(),
  spawnSync: vi.fn(),
}));

const mockedExecFile = vi.mocked(execFile);
const mockedSpawnSync = vi.mocked(spawnSync);

beforeEach(() => {
  vi.clearAllMocks();
});

describe('isInsideGitRepo', () => {
  it('returns true when git reports inside a work tree', () => {
    mockedSpawnSync.mockReturnValue({ status: 0, stdout: 'true\n', stderr: '' } as never);
    expect(isInsideGitRepo('/repo')).toBe(true);
    expect(mockedSpawnSync).toHaveBeenCalledWith(
      'git',
      ['-C', '/repo', 'rev-parse', '--is-inside-work-tree'],
      expect.any(Object),
    );
  });

  it('returns false when git exits non-zero', () => {
    mockedSpawnSync.mockReturnValue({ status: 128, stdout: '', stderr: 'fatal' } as never);
    expect(isInsideGitRepo('/not-repo')).toBe(false);
  });
});

describe('listChangedFiles', () => {
  it('parses empty status output as no changes', async () => {
    mockedExecFile.mockImplementation((_cmd, args, _opts, callback) => {
      if (Array.isArray(args) && args.includes('rev-parse')) {
        callback?.(null, '\n', '');
        return undefined as never;
      }
      callback?.(null, '', '');
      return undefined as never;
    });

    const files = await listChangedFiles('/repo');

    expect(files).toHaveLength(0);
  });

  it('parses modified, added, deleted and untracked files', async () => {
    mockedExecFile.mockImplementation((_cmd, args, _opts, callback) => {
      if (Array.isArray(args) && args.includes('rev-parse')) {
        callback?.(null, '\n', '');
        return undefined as never;
      }
      callback?.(null, ' M modified.ts\0A  added.ts\0 D deleted.ts\0?? untracked.ts\0', '');
      return undefined as never;
    });

    const files = await listChangedFiles('/repo');

    expect(files).toEqual([
      { path: 'modified.ts', status: 'modified' },
      { path: 'added.ts', status: 'added' },
      { path: 'deleted.ts', status: 'deleted' },
      { path: 'untracked.ts', status: 'untracked' },
    ]);
  });

  it('rejects on git status failure', async () => {
    mockedExecFile.mockImplementation((_cmd, args, _opts, callback) => {
      if (Array.isArray(args) && args.includes('rev-parse')) {
        callback?.(null, '\n', '');
        return undefined as never;
      }
      callback?.(new Error('exit 128'), '', 'bad');
      return undefined as never;
    });

    await expect(listChangedFiles('/repo')).rejects.toThrow('git status failed');
  });

  it('strips the repo-root prefix when running from a subdirectory', async () => {
    mockedExecFile.mockImplementation((_cmd, args, _opts, callback) => {
      if (Array.isArray(args) && args.includes('rev-parse')) {
        callback?.(null, 'sub/\n', '');
        return undefined as never;
      }
      callback?.(null, ' M sub/modified.ts\0?? sub/new.ts\0 M other.ts\0', '');
      return undefined as never;
    });

    const files = await listChangedFiles('/repo/sub');

    expect(files).toEqual([
      { path: 'modified.ts', status: 'modified' },
      { path: 'new.ts', status: 'untracked' },
    ]);
  });
});

describe('runGitDiffForFile', () => {
  it('runs git diff HEAD for a modified file', async () => {
    mockedExecFile.mockImplementation((_cmd, _args, _opts, callback) => {
      callback?.(null, 'diff output', '');
      return undefined as never;
    });

    const result = await runGitDiffForFile('/repo', {
      path: 'foo.ts',
      status: 'modified',
    });

    expect(result).toBe('diff output');
    expect(mockedExecFile).toHaveBeenCalledWith(
      'git',
      ['-C', '/repo', 'diff', 'HEAD', '-U3', '--', 'foo.ts'],
      expect.any(Object),
      expect.any(Function),
    );
  });

  it('runs git diff --no-index for an untracked file', async () => {
    mockedExecFile.mockImplementation((_cmd, _args, _opts, callback) => {
      callback?.(Object.assign(new Error('diff'), { code: 1 }), 'untracked diff', '');
      return undefined as never;
    });

    const result = await runGitDiffForFile('/repo', {
      path: 'new.ts',
      status: 'untracked',
    });

    expect(result).toBe('untracked diff');
    expect(mockedExecFile).toHaveBeenCalledWith(
      'git',
      ['-C', '/repo', 'diff', '--no-index', '-U3', '--', '/dev/null', 'new.ts'],
      expect.any(Object),
      expect.any(Function),
    );
  });

  it('rejects shell metacharacters in file paths', async () => {
    await expect(
      runGitDiffForFile('/repo', {
        path: 'foo;rm -rf /',
        status: 'modified',
      }),
    ).rejects.toBeInstanceOf(GitDiffError);
    expect(mockedExecFile).not.toHaveBeenCalled();
  });

  it('rejects when git diff --no-index exits with a real error', async () => {
    mockedExecFile.mockImplementation((_cmd, _args, _opts, callback) => {
      callback?.(Object.assign(new Error('permission denied'), { code: 128 }), '', 'bad');
      return undefined as never;
    });

    await expect(
      runGitDiffForFile('/repo', {
        path: 'x.ts',
        status: 'untracked',
      }),
    ).rejects.toBeInstanceOf(GitDiffError);
  });

  it('returns an empty diff in an empty git repo without HEAD', async () => {
    mockedExecFile.mockImplementation((_cmd, _args, _opts, callback) => {
      callback?.(
        Object.assign(new Error("fatal: 歧义参数 'HEAD': 未知的版本或路径不在工作树中。"), { code: 128 }),
        '',
        "fatal: ambiguous argument 'HEAD': unknown revision or path not in the working tree.",
      );
      return undefined as never;
    });

    const result = await runGitDiffForFile('/repo', {
      path: 'a.ts',
      status: 'modified',
    });

    expect(result).toBe('');
  });
});

describe('runGitNumstat', () => {
  it('strips the repo-root prefix so keys are relative to workDir', async () => {
    mockedExecFile.mockImplementation((_cmd, args, _opts, callback) => {
      if (Array.isArray(args) && args.includes('rev-parse')) {
        callback?.(null, 'sub/\n', '');
        return undefined as never;
      }
      callback?.(null, '3\t2\tsub/src/foo.ts\n', '');
      return undefined as never;
    });

    const stats = await runGitNumstat('/repo/sub');

    expect(stats.get('src/foo.ts')).toEqual({ additions: 3, deletions: 2 });
    expect(stats.has('sub/src/foo.ts')).toBe(false);
  });

  it('uses paths as-is when workDir is the repo root', async () => {
    mockedExecFile.mockImplementation((_cmd, args, _opts, callback) => {
      if (Array.isArray(args) && args.includes('rev-parse')) {
        callback?.(null, '\n', '');
        return undefined as never;
      }
      callback?.(null, '5\t0\tfoo.ts\n', '');
      return undefined as never;
    });

    const stats = await runGitNumstat('/repo');

    expect(stats.get('foo.ts')).toEqual({ additions: 5, deletions: 0 });
  });

  it('passes --no-renames so renamed files are reported as separate additions/deletions', async () => {
    mockedExecFile.mockImplementation((_cmd, args, _opts, callback) => {
      if (Array.isArray(args) && args.includes('rev-parse')) {
        callback?.(null, '\n', '');
        return undefined as never;
      }
      callback?.(null, '0\t5\told.ts\n3\t0\tnew.ts\n', '');
      return undefined as never;
    });

    await runGitNumstat('/repo');

    expect(mockedExecFile).toHaveBeenCalledWith(
      'git',
      ['-C', '/repo', 'diff', 'HEAD', '--no-renames', '--numstat'],
      expect.any(Object),
      expect.any(Function),
    );
  });

  it('returns empty stats in an empty git repo without HEAD', async () => {
    mockedExecFile.mockImplementation((_cmd, args, _opts, callback) => {
      if (Array.isArray(args) && args.includes('rev-parse')) {
        callback?.(null, '\n', '');
        return undefined as never;
      }
      callback?.(
        Object.assign(new Error("fatal: 歧义参数 'HEAD': 未知的版本或路径不在工作树中。"), { code: 128 }),
        '',
        "fatal: ambiguous argument 'HEAD': unknown revision or path not in the working tree.",
      );
      return undefined as never;
    });

    const stats = await runGitNumstat('/repo');

    expect(stats.size).toBe(0);
  });
});

describe('runUntrackedNumstat', () => {
  it('returns additions/deletions for an untracked file', async () => {
    mockedExecFile.mockImplementation((_cmd, _args, _opts, callback) => {
      callback?.(Object.assign(new Error('diff'), { code: 1 }), '3\t0\t/dev/null => new.ts\n', '');
      return undefined as never;
    });

    const stat = await runUntrackedNumstat('/repo', 'new.ts');

    expect(stat).toEqual({ additions: 3, deletions: 0 });
  });

  it('rejects when git exits with a real error', async () => {
    mockedExecFile.mockImplementation((_cmd, _args, _opts, callback) => {
      callback?.(Object.assign(new Error('permission denied'), { code: 128 }), '', 'bad');
      return undefined as never;
    });

    await expect(runUntrackedNumstat('/repo', 'new.ts')).rejects.toBeInstanceOf(GitDiffError);
  });
});

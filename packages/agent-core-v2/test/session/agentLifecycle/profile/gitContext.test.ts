import { Readable, type Writable } from 'node:stream';
import { mkdtemp, mkdir, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import {
  collectGitContext,
  parseProjectName,
  sanitizeRemoteUrl,
} from '#/session/agentLifecycle/profile/gitContext';
import type { ILogger } from '#/_base/log/log';
import type { IHostProcess, IHostProcessService } from '#/os/interface/hostProcess';

function processWith(stdout: string, exitCode: number, stderr = ''): IHostProcess {
  const stdoutStream = Readable.from([Buffer.from(stdout)]);
  const stderrStream = Readable.from([Buffer.from(stderr)]);
  return {
    _serviceBrand: undefined,
    stdin: { end: vi.fn(), write: vi.fn() } as unknown as Writable,
    stdout: stdoutStream,
    stderr: stderrStream,
    pid: 1,
    exitCode,
    wait: vi.fn().mockResolvedValue(exitCode),
    kill: vi.fn(async () => {}),
    dispose: vi.fn(async () => {
      stdoutStream.destroy();
      stderrStream.destroy();
    }),
  };
}

type GitScript = Record<string, { stdout?: string; exitCode?: number; stderr?: string }>;

function gitRunner(script: GitScript): { process: IHostProcessService; spawn: ReturnType<typeof vi.fn> } {
  const spawn = vi.fn(async (_command: string, args: readonly string[]) => {
    const key = args.slice(args.indexOf('-C') + 2).join(' ');
    const out = script[key];
    if (out === undefined) return processWith('', 1);
    return processWith(out.stdout ?? '', out.exitCode ?? 0, out.stderr ?? '');
  });
  return { process: { _serviceBrand: undefined, spawn } as IHostProcessService, spawn };
}

function spyLogger(): {
  logger: ILogger;
  debug: ReturnType<typeof vi.fn>;
  warn: ReturnType<typeof vi.fn>;
} {
  const debug = vi.fn();
  const warn = vi.fn();
  const logger: ILogger = {
    error: vi.fn(),
    warn,
    info: vi.fn(),
    debug,
    child: vi.fn(),
  };
  return { logger, debug, warn };
}

describe('collectGitContext', () => {
  it('builds a git-context block with all sections', async () => {
    const { process: hostProcess } = gitRunner({
      'rev-parse --is-inside-work-tree': { stdout: 'true\n' },
      'remote get-url origin': { stdout: 'git@github.com:owner/repo.git\n' },
      'symbolic-ref --short HEAD': { stdout: 'main\n' },
      'status --porcelain': { stdout: ' M src/a.ts\n?? src/b.ts' },
      'log -3 --format=%h %s': { stdout: 'abc123 Initial commit\ndef456 second commit' },
    });

    const block = await collectGitContext(hostProcess, '/repo');

    expect(block.startsWith('<git-context>\n')).toBe(true);
    expect(block.endsWith('\n</git-context>')).toBe(true);
    expect(block).toContain('Working directory: /repo');
    expect(block).toContain('Remote: git@github.com:owner/repo.git');
    expect(block).toContain('Project: owner/repo');
    expect(block).toContain('Branch: main');
    expect(block).toContain('Dirty files (2):');
    expect(block).toContain('  ?? src/b.ts');
    expect(block).toContain('Recent commits:');
    expect(block).toContain('  abc123 Initial commit');
  });

  it('returns an unavailable block when the directory is not a git repository', async () => {
    const { process: hostProcess } = gitRunner({
      'rev-parse --is-inside-work-tree': {
        exitCode: 128,
        stderr: 'fatal: not a git repository (or any of the parent directories): .git',
      },
    });
    const { logger, debug, warn } = spyLogger();

    await expect(collectGitContext(hostProcess, '/not-a-repo', logger)).resolves.toBe(
      '<git-context status="unavailable" reason="not-a-repo"/>',
    );
    expect(debug).not.toHaveBeenCalled();
    expect(warn).not.toHaveBeenCalled();
  });

  it('returns an empty string when rev-parse fails for a reason other than not-a-repo', async () => {
    const { process: hostProcess } = gitRunner({
      'rev-parse --is-inside-work-tree': { exitCode: 1, stderr: 'fatal: some other git error' },
    });
    const { logger, debug } = spyLogger();

    await expect(collectGitContext(hostProcess, '/repo', logger)).resolves.toBe('');
    expect(debug).toHaveBeenCalledWith(
      'git context command failed',
      expect.objectContaining({
        command: 'git rev-parse --is-inside-work-tree',
        exitCode: 1,
        stderr: 'fatal: some other git error',
      }),
    );
  });

  it('returns an empty string when git fails to spawn', async () => {
    const hostProcess = {
      _serviceBrand: undefined,
      spawn: vi.fn(async (): Promise<IHostProcess> => {
        throw new Error('spawn failed');
      }),
    } as IHostProcessService;
    const { logger, debug } = spyLogger();

    await expect(collectGitContext(hostProcess, '/repo', logger)).resolves.toBe('');
    expect(debug).toHaveBeenCalledWith(
      'git context command failed',
      expect.objectContaining({ command: 'git rev-parse --is-inside-work-tree' }),
    );
  });

  it('invokes git with repo-local command config disabled', async () => {
    const { process: hostProcess, spawn } = gitRunner({
      'rev-parse --is-inside-work-tree': { stdout: 'true' },
    });

    await collectGitContext(hostProcess, '/repo');

    const nullDevice = process.platform === 'win32' ? 'NUL' : '/dev/null';
    expect(spawn).toHaveBeenCalled();
    for (const call of spawn.mock.calls) {
      expect(call[0]).toBe('git');
      const args = call[1] as readonly string[];
      expect(args.slice(0, 18)).toEqual([
        '-c',
        'core.fsmonitor=false',
        '-c',
        `core.hooksPath=${nullDevice}`,
        '-c',
        'commit.gpgSign=false',
        '-c',
        'log.showSignature=false',
        '-c',
        'merge.verifySignatures=false',
        '-c',
        'core.editor=',
        '-c',
        'gpg.program=',
        '-c',
        'submodule.recurse=false',
        '-C',
        '/repo',
      ]);
    }
  });

  it('neutralizes repo-configured filter drivers on every git invocation', async () => {
    const { process: hostProcess, spawn } = gitRunner({
      'config --local --includes --get-regexp --name-only ^(filter|merge)\\.': {
        stdout: 'filter.evil.clean\nfilter.evil.process\n',
      },
      'rev-parse --is-inside-work-tree': { stdout: 'true' },
    });

    await collectGitContext(hostProcess, '/repo');

    const invocations = spawn.mock.calls.map((call) => call[1] as readonly string[]);
    const hardened = invocations.filter((args) => !args.includes('config'));
    expect(hardened.length).toBeGreaterThan(0);
    for (const args of hardened) {
      expect(args).toContain('filter.evil.clean=');
      expect(args).toContain('filter.evil.process=');
    }
  });

  it('neutralizes filter drivers from both local and worktree config scopes', async () => {
    const { process: hostProcess, spawn } = gitRunner({
      'config --local --includes --get-regexp --name-only ^(filter|merge)\\.': {
        stdout: 'filter.evil.clean\nfilter.evil.smudge\nmerge.evil.driver\n',
      },
      'config --worktree --includes --get-regexp --name-only ^(filter|merge)\\.': {
        stdout: 'filter.wt.process\n',
      },
      'rev-parse --is-inside-work-tree': { stdout: 'true' },
    });

    await collectGitContext(hostProcess, '/repo');

    const invocations = spawn.mock.calls.map((call) => call[1] as readonly string[]);
    const probes = invocations.filter((args) => args.includes('config'));
    expect(probes.length).toBeGreaterThan(0);
    for (const args of probes) {
      expect(args).toContain('--includes');
    }
    const hardened = invocations.filter((args) => !args.includes('config'));
    expect(hardened.length).toBeGreaterThan(0);
    for (const args of hardened) {
      expect(args).toContain('filter.evil.clean=');
      expect(args).toContain('filter.evil.process=');
      expect(args).toContain('filter.evil.smudge=');
      expect(args).toContain('filter.wt.clean=');
      expect(args).toContain('filter.wt.process=');
      expect(args).toContain('filter.wt.smudge=');
      expect(args).toContain('merge.evil.driver=');
    }
  });

  it('fails closed when .git is a symlink and core.worktree is relative', async () => {
    const root = await mkdtemp(join(tmpdir(), 'git-context-symlink-'));
    const admin = await mkdtemp(join(tmpdir(), 'git-context-admin-'));
    try {
      await mkdir(join(admin, '.git'), { recursive: true });
      await symlink(join(admin, '.git'), join(root, '.git'));
      const { process: hostProcess, spawn } = gitRunner({
        'config --local --includes --get core.worktree': { stdout: '..\n' },
        'config --worktree --includes --get core.worktree': { stdout: '..\n' },
        'rev-parse --is-inside-work-tree': { stdout: 'true\n' },
      });

      await expect(collectGitContext(hostProcess, root)).resolves.toBe('');

      const invocations = spawn.mock.calls.map((call) => call[1] as readonly string[]);
      expect(invocations.length).toBeGreaterThan(0);
      expect(invocations.every((args) => args.includes('config'))).toBe(true);
    } finally {
      await rm(root, { recursive: true, force: true });
      await rm(admin, { recursive: true, force: true });
    }
  });

  it('fails closed when the filter config probe fails', async () => {
    const spawn = vi.fn(async (_command: string, args: readonly string[]) => {
      if (args.includes('config')) throw new Error('spawn failed');
      return processWith('true\n', 0);
    });
    const hostProcess = { _serviceBrand: undefined, spawn } as IHostProcessService;

    await expect(collectGitContext(hostProcess, '/repo')).resolves.toBe('');

    const invocations = spawn.mock.calls.map((call) => call[1] as readonly string[]);
    expect(invocations.length).toBeGreaterThan(0);
    expect(invocations.every((args) => args.includes('config'))).toBe(true);
  });

  it('fails closed when a filter driver name contains an equals sign', async () => {
    const { process: hostProcess, spawn } = gitRunner({
      'config --local --includes --get-regexp --name-only ^(filter|merge)\\.': {
        stdout: 'filter.evil=x.clean\n',
      },
      'rev-parse --is-inside-work-tree': { stdout: 'true' },
    });

    await expect(collectGitContext(hostProcess, '/repo')).resolves.toBe('');

    const invocations = spawn.mock.calls.map((call) => call[1] as readonly string[]);
    expect(invocations.every((args) => args.includes('config'))).toBe(true);
  });

  it('fails closed when core.worktree points outside the repository', async () => {
    const root = await mkdtemp(join(tmpdir(), 'git-context-worktree-'));
    try {
      await mkdir(join(root, '.git'), { recursive: true });
      const { process: hostProcess, spawn } = gitRunner({
        'config --local --includes --get core.worktree': { stdout: '/outside\n' },
        'config --worktree --includes --get core.worktree': { exitCode: 1 },
        'rev-parse --is-inside-work-tree': { stdout: 'true' },
      });

      await expect(collectGitContext(hostProcess, root)).resolves.toBe('');

      const invocations = spawn.mock.calls.map((call) => call[1] as readonly string[]);
      expect(invocations.length).toBeGreaterThan(0);
      expect(invocations.every((args) => args.includes('config'))).toBe(true);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('caps dirty files at 20 and reports the remainder', async () => {
    const dirty = Array.from({ length: 25 }, (_, i) => ` M src/f${String(i)}.ts`).join('\n');
    const { process: hostProcess } = gitRunner({
      'rev-parse --is-inside-work-tree': { stdout: 'true' },
      'remote get-url origin': { stdout: '' },
      'symbolic-ref --short HEAD': { stdout: '' },
      'status --porcelain': { stdout: dirty },
      'log -3 --format=%h %s': { stdout: '' },
    });

    const block = await collectGitContext(hostProcess, '/repo');

    expect(block).toContain('Dirty files (25):');
    expect(block).toContain('  ... and 5 more');
  });

  it('returns an empty string when only the working directory is known', async () => {
    const { process: hostProcess } = gitRunner({
      'rev-parse --is-inside-work-tree': { stdout: 'true' },
    });

    await expect(collectGitContext(hostProcess, '/repo')).resolves.toBe('');
  });

  it('omits both Remote and Project for a disallowed remote host', async () => {
    const { process: hostProcess } = gitRunner({
      'rev-parse --is-inside-work-tree': { stdout: 'true' },
      'remote get-url origin': { stdout: 'git@internal.example.test:secret/repo.git' },
      'symbolic-ref --short HEAD': { stdout: 'main' },
      'status --porcelain': { stdout: '' },
      'log -3 --format=%h %s': { stdout: '' },
    });

    const block = await collectGitContext(hostProcess, '/repo');

    expect(block).not.toContain('Remote:');
    expect(block).not.toContain('Project:');
    expect(block).not.toContain('secret/repo');
    expect(block).toContain('Branch: main');
  });

  it('keeps branch and status when the origin remote is absent', async () => {
    const { process: hostProcess } = gitRunner({
      'rev-parse --is-inside-work-tree': { stdout: 'true' },
      'remote get-url origin': { exitCode: 2, stderr: "error: No such remote 'origin'" },
      'symbolic-ref --short HEAD': { stdout: 'main' },
      'status --porcelain': { stdout: ' M src/a.ts' },
      'log -3 --format=%h %s': { stdout: 'abc123 first commit' },
    });
    const { logger, debug } = spyLogger();

    const block = await collectGitContext(hostProcess, '/repo', logger);

    expect(block).toContain('Branch: main');
    expect(block).toContain('Dirty files (1):');
    expect(block).toContain('Recent commits:');
    expect(block).not.toContain('Remote:');
    expect(block).not.toContain('Project:');
    expect(debug).toHaveBeenCalledWith(
      'git context command failed',
      expect.objectContaining({ command: 'git remote get-url origin' }),
    );
  });

  it('keeps branch and status when the repository has no commits yet', async () => {
    const { process: hostProcess } = gitRunner({
      'rev-parse --is-inside-work-tree': { stdout: 'true' },
      'remote get-url origin': { stdout: 'https://github.com/acme/widgets.git' },
      'symbolic-ref --short HEAD': { stdout: 'main' },
      'status --porcelain': { stdout: '' },
      'log -3 --format=%h %s': {
        exitCode: 128,
        stderr: "fatal: your current branch 'main' does not have any commits yet",
      },
    });

    const block = await collectGitContext(hostProcess, '/repo');

    expect(block).toContain('Branch: main');
    expect(block).toContain('Remote: https://github.com/acme/widgets.git');
    expect(block).toContain('Project: acme/widgets');
    expect(block).not.toContain('Recent commits:');
  });

  it('omits the Branch section in detached HEAD state', async () => {
    const { process: hostProcess } = gitRunner({
      'rev-parse --is-inside-work-tree': { stdout: 'true' },
      'symbolic-ref --short HEAD': {
        exitCode: 128,
        stderr: 'fatal: ref HEAD is not a symbolic ref',
      },
      'remote get-url origin': { stdout: 'https://github.com/acme/widgets.git' },
      'status --porcelain': { stdout: '' },
      'log -3 --format=%h %s': { stdout: 'abc123 first commit' },
    });

    const block = await collectGitContext(hostProcess, '/repo');

    expect(block).not.toContain('Branch:');
    expect(block).toContain('Remote: https://github.com/acme/widgets.git');
    expect(block).toContain('Recent commits:');
  });

  it('treats a hanging git command as a failure (timeout)', async () => {
    vi.useFakeTimers();
    try {
      const hostProcess = {
        _serviceBrand: undefined,
        spawn: vi.fn(async (): Promise<IHostProcess> => {
          let release: (code: number) => void = () => {};
          const exited = new Promise<number>((resolve) => {
            release = resolve;
          });
          return {
            _serviceBrand: undefined,
            stdin: { end: vi.fn(), write: vi.fn() } as unknown as Writable,
            stdout: Readable.from(['']),
            stderr: Readable.from(['']),
            pid: 1,
            exitCode: null,
            wait: vi.fn(() => exited),
            kill: vi.fn(async () => {
              release(137);
            }),
            dispose: vi.fn(),
          };
        }),
      } as IHostProcessService;
      const { logger, debug } = spyLogger();

      const promise = collectGitContext(hostProcess, '/repo', logger);
      for (let i = 0; i < 10; i += 1) {
        await vi.advanceTimersByTimeAsync(6_000);
      }
      await expect(promise).resolves.toBe('');
      expect(debug).toHaveBeenCalledWith(
        'git context command failed',
        expect.objectContaining({ command: 'git rev-parse --is-inside-work-tree' }),
      );
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('remote url helpers', () => {
  it('sanitizes allowed https remotes and drops credentials', () => {
    expect(sanitizeRemoteUrl('https://user:token@github.com/owner/repo.git')).toBe(
      'https://github.com/owner/repo.git',
    );
  });

  it('rejects private hosts', () => {
    expect(sanitizeRemoteUrl('https://git.example.test/owner/repo.git')).toBeNull();
  });

  it('parses project names from ssh and https urls', () => {
    expect(parseProjectName('git@github.com:owner/repo.git')).toBe('owner/repo');
    expect(parseProjectName('https://github.com/owner/repo.git')).toBe('owner/repo');
  });
});

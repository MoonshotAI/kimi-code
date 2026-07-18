import { Readable, type Writable } from 'node:stream';

import { describe, expect, it, vi } from 'vitest';

import {
  collectGitContext,
  parseProjectName,
  sanitizeRemoteUrl,
} from '#/session/sessionFs/gitContext';
import type { ILogger } from '#/_base/log/log';
import type { IProcess, ISessionProcessRunner } from '#/session/process/processRunner';

function processWith(stdout: string, exitCode: number, stderr = ''): IProcess {
  const stdoutStream = Readable.from([Buffer.from(stdout)]);
  const stderrStream = Readable.from([Buffer.from(stderr)]);
  return {
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

function gitRunner(script: GitScript): { runner: ISessionProcessRunner; exec: ReturnType<typeof vi.fn> } {
  const exec = vi.fn(async (args: readonly string[]) => {
    const key = args.slice(3).join(' ');
    const out = script[key];
    if (out === undefined) return processWith('', 1);
    return processWith(out.stdout ?? '', out.exitCode ?? 0, out.stderr ?? '');
  });
  return { runner: { exec } as unknown as ISessionProcessRunner, exec };
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
    const { runner } = gitRunner({
      'rev-parse --is-inside-work-tree': { stdout: 'true\n' },
      'remote get-url origin': { stdout: 'git@github.com:owner/repo.git\n' },
      'symbolic-ref --short HEAD': { stdout: 'main\n' },
      'status --porcelain': { stdout: ' M src/a.ts\n?? src/b.ts' },
      'log -3 --format=%h %s': { stdout: 'abc123 Initial commit\ndef456 second commit' },
    });

    const block = await collectGitContext(runner, '/repo');

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
    const { runner } = gitRunner({
      'rev-parse --is-inside-work-tree': {
        exitCode: 128,
        stderr: 'fatal: not a git repository (or any of the parent directories): .git',
      },
    });
    const { logger, debug, warn } = spyLogger();

    await expect(collectGitContext(runner, '/not-a-repo', logger)).resolves.toBe(
      '<git-context status="unavailable" reason="not-a-repo"/>',
    );
    expect(debug).not.toHaveBeenCalled();
    expect(warn).not.toHaveBeenCalled();
  });

  it('returns an empty string when rev-parse fails for a reason other than not-a-repo', async () => {
    const { runner } = gitRunner({
      'rev-parse --is-inside-work-tree': { exitCode: 1, stderr: 'fatal: some other git error' },
    });
    const { logger, debug } = spyLogger();

    await expect(collectGitContext(runner, '/repo', logger)).resolves.toBe('');
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
    const runner = {
      exec: vi.fn(async (): Promise<IProcess> => {
        throw new Error('spawn failed');
      }),
    } as unknown as ISessionProcessRunner;
    const { logger, warn } = spyLogger();

    await expect(collectGitContext(runner, '/repo', logger)).resolves.toBe('');
    expect(warn).toHaveBeenCalledWith(
      'git context command failed to spawn',
      expect.objectContaining({ command: 'git rev-parse --is-inside-work-tree' }),
    );
  });

  it('caps dirty files at 20 and reports the remainder', async () => {
    const dirty = Array.from({ length: 25 }, (_, i) => ` M src/f${String(i)}.ts`).join('\n');
    const { runner } = gitRunner({
      'rev-parse --is-inside-work-tree': { stdout: 'true' },
      'remote get-url origin': { stdout: '' },
      'symbolic-ref --short HEAD': { stdout: '' },
      'status --porcelain': { stdout: dirty },
      'log -3 --format=%h %s': { stdout: '' },
    });

    const block = await collectGitContext(runner, '/repo');

    expect(block).toContain('Dirty files (25):');
    expect(block).toContain('  ... and 5 more');
  });

  it('returns an empty string when only the working directory is known', async () => {
    const { runner } = gitRunner({
      'rev-parse --is-inside-work-tree': { stdout: 'true' },
    });

    await expect(collectGitContext(runner, '/repo')).resolves.toBe('');
  });

  it('omits both Remote and Project for a disallowed remote host', async () => {
    const { runner } = gitRunner({
      'rev-parse --is-inside-work-tree': { stdout: 'true' },
      'remote get-url origin': { stdout: 'git@internal.corp:secret/repo.git' },
      'symbolic-ref --short HEAD': { stdout: 'main' },
      'status --porcelain': { stdout: '' },
      'log -3 --format=%h %s': { stdout: '' },
    });

    const block = await collectGitContext(runner, '/repo');

    expect(block).not.toContain('Remote:');
    expect(block).not.toContain('Project:');
    expect(block).not.toContain('secret/repo');
    expect(block).toContain('Branch: main');
  });

  it('keeps branch and status when the origin remote is absent', async () => {
    const { runner } = gitRunner({
      'rev-parse --is-inside-work-tree': { stdout: 'true' },
      'remote get-url origin': { exitCode: 2, stderr: "error: No such remote 'origin'" },
      'symbolic-ref --short HEAD': { stdout: 'main' },
      'status --porcelain': { stdout: ' M src/a.ts' },
      'log -3 --format=%h %s': { stdout: 'abc123 first commit' },
    });
    const { logger, debug } = spyLogger();

    const block = await collectGitContext(runner, '/repo', logger);

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
    const { runner } = gitRunner({
      'rev-parse --is-inside-work-tree': { stdout: 'true' },
      'remote get-url origin': { stdout: 'https://github.com/acme/widgets.git' },
      'symbolic-ref --short HEAD': { stdout: 'main' },
      'status --porcelain': { stdout: '' },
      'log -3 --format=%h %s': {
        exitCode: 128,
        stderr: "fatal: your current branch 'main' does not have any commits yet",
      },
    });

    const block = await collectGitContext(runner, '/repo');

    expect(block).toContain('Branch: main');
    expect(block).toContain('Remote: https://github.com/acme/widgets.git');
    expect(block).toContain('Project: acme/widgets');
    expect(block).not.toContain('Recent commits:');
  });

  it('omits the Branch section in detached HEAD state', async () => {
    const { runner } = gitRunner({
      'rev-parse --is-inside-work-tree': { stdout: 'true' },
      'symbolic-ref --short HEAD': {
        exitCode: 128,
        stderr: 'fatal: ref HEAD is not a symbolic ref',
      },
      'remote get-url origin': { stdout: 'https://github.com/acme/widgets.git' },
      'status --porcelain': { stdout: '' },
      'log -3 --format=%h %s': { stdout: 'abc123 first commit' },
    });

    const block = await collectGitContext(runner, '/repo');

    expect(block).not.toContain('Branch:');
    expect(block).toContain('Remote: https://github.com/acme/widgets.git');
    expect(block).toContain('Recent commits:');
  });

  it('treats a hanging git command as a failure (timeout)', async () => {
    vi.useFakeTimers();
    try {
      const runner = {
        exec: vi.fn(async (): Promise<IProcess> => {
          let release: (code: number) => void = () => {};
          const exited = new Promise<number>((resolve) => {
            release = resolve;
          });
          return {
            stdin: { end: vi.fn(), write: vi.fn() } as unknown as Writable,
            stdout: Readable.from(['']),
            stderr: Readable.from(['']),
            pid: 1,
            exitCode: null,
            wait: vi.fn(() => exited),
            kill: vi.fn(async () => {
              release(137);
            }),
            dispose: vi.fn(async () => {}),
          };
        }),
      } as unknown as ISessionProcessRunner;
      const { logger, debug } = spyLogger();

      const promise = collectGitContext(runner, '/repo', logger);
      await vi.advanceTimersByTimeAsync(6_000);
      await expect(promise).resolves.toBe('');
      expect(debug).toHaveBeenCalledWith(
        'git context command timed out',
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
    expect(sanitizeRemoteUrl('https://git.example.internal/owner/repo.git')).toBeNull();
  });

  it('parses project names from ssh and https urls', () => {
    expect(parseProjectName('git@github.com:owner/repo.git')).toBe('owner/repo');
    expect(parseProjectName('https://github.com/owner/repo.git')).toBe('owner/repo');
  });
});

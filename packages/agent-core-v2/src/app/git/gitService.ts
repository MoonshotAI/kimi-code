/**
 * `git` domain (L1) — `IGitService` implementation.
 *
 * Runs `git status` / `git diff` (and `gh pr view`) against a repository on
 * the local disk. Process spawning goes through the App-scope
 * `IHostProcessService` from `os/interface`, and the single path-existence
 * probe in `diff` goes through `IHostFileSystem`; no Node platform API is
 * imported directly. Bound at App scope — it owns no Session dependency, so
 * the caller supplies an absolute `cwd` and already-confined repo-relative
 * paths.
 */

import type { FsDiffResponse, FsGitStatusResponse, FsPullRequest } from '@moonshot-ai/protocol';

import { InstantiationType } from '#/_base/di/extensions';
import { LifecycleScope, registerScopedService } from '#/_base/di/scope';
import { ErrorCodes, Error2 } from '#/errors';
import { IHostFileSystem } from '#/os/interface/hostFileSystem';
import { IHostProcessService } from '#/os/interface/hostProcess';

import { IGitService } from './git';
import { parseNumstat, parsePorcelain, parsePullRequest } from './gitParsers';

const DIFF_MAX_BYTES = 1_048_576;

const PR_SPAWN_TIMEOUT_MS = 5_000;
const PULL_REQUEST_TTL_MS = 60_000;

export class GitService implements IGitService {
  declare readonly _serviceBrand: undefined;

  private readonly pullRequestCache = new Map<
    string,
    { value: FsPullRequest | null; fetchedAt: number }
  >();

  constructor(
    @IHostProcessService private readonly hostProcess: IHostProcessService,
    @IHostFileSystem private readonly fs: IHostFileSystem,
  ) {}

  async status(cwd: string, pathFilter?: ReadonlySet<string>): Promise<FsGitStatusResponse> {
    const inside = await this.runCommand('git', ['rev-parse', '--is-inside-work-tree'], cwd);
    if (inside.exitCode !== 0 || inside.stdout.trim() !== 'true') {
      throw this.gitUnavailable(cwd, inside.stderr.trim() || `git rev-parse exit ${inside.exitCode}`);
    }

    const porc = await this.runCommand('git', ['status', '--porcelain=v1', '--branch'], cwd);
    if (porc.exitCode !== 0) {
      throw this.gitUnavailable(cwd, porc.stderr.trim() || `git status exit ${porc.exitCode}`);
    }

    const result = parsePorcelain(porc.stdout, pathFilter);

    const dirty = porc.stdout
      .split('\n')
      .some((line) => line.length > 0 && !line.startsWith('## '));
    if (dirty) {
      const head = await this.runCommand('git', ['rev-parse', '--verify', '--quiet', 'HEAD'], cwd);
      if (head.exitCode === 0) {
        const numstat = await this.runCommand('git', ['diff', '--no-color', '--numstat', 'HEAD', '--'], cwd);
        if (numstat.exitCode === 0) {
          const stats = parseNumstat(numstat.stdout);
          result.additions = stats.additions;
          result.deletions = stats.deletions;
        }
      }
    }

    result.pullRequest = await this.readPullRequest(cwd);
    return result;
  }

  async diff(cwd: string, relPath: string, absPath: string): Promise<FsDiffResponse> {
    const inside = await this.runCommand('git', ['rev-parse', '--is-inside-work-tree'], cwd);
    if (inside.exitCode !== 0 || inside.stdout.trim() !== 'true') {
      throw this.gitUnavailable(cwd, inside.stderr.trim() || `git rev-parse exit ${inside.exitCode}`);
    }

    const statusRes = await this.runCommand('git', ['status', '--porcelain=v1', '--', relPath], cwd);
    if (statusRes.exitCode !== 0) {
      throw this.gitUnavailable(cwd, statusRes.stderr.trim() || `git status exit ${statusRes.exitCode}`);
    }
    const untracked = statusRes.stdout.startsWith('??');

    const headRes = await this.runCommand('git', ['rev-parse', '--verify', '--quiet', 'HEAD'], cwd);
    const hasHead = headRes.exitCode === 0;

    let diffStdout: string;
    if (untracked || !hasHead) {
      const res = await this.runCommand(
        'git',
        ['diff', '--no-color', '--no-index', '--', '/dev/null', relPath],
        cwd,
      );
      if (res.exitCode !== 0 && res.exitCode !== 1) {
        throw this.gitUnavailable(cwd, res.stderr.trim() || `git diff exit ${res.exitCode}`);
      }
      diffStdout = res.stdout;
    } else {
      const res = await this.runCommand('git', ['diff', '--no-color', 'HEAD', '--', relPath], cwd);
      if (res.exitCode !== 0) {
        throw this.gitUnavailable(cwd, res.stderr.trim() || `git diff exit ${res.exitCode}`);
      }
      if (res.stdout.length === 0 && statusRes.stdout.length === 0) {
        const exists = await this.fs.stat(absPath).then(
          () => true,
          () => false,
        );
        if (!exists) {
          throw new Error2(ErrorCodes.FS_PATH_NOT_FOUND, `path not found: ${relPath}`, {
            details: { path: relPath },
          });
        }
      }
      diffStdout = res.stdout;
    }

    const truncated = diffStdout.length > DIFF_MAX_BYTES;
    return {
      path: relPath,
      diff: truncated ? diffStdout.slice(0, DIFF_MAX_BYTES) : diffStdout,
      truncated,
    };
  }

  private async readPullRequest(cwd: string): Promise<FsPullRequest | null> {
    const cached = this.pullRequestCache.get(cwd);
    const now = Date.now();
    if (cached !== undefined && now - cached.fetchedAt < PULL_REQUEST_TTL_MS) {
      return cached.value;
    }

    const res = await this.runCommand(
      'gh',
      ['pr', 'view', '--json', 'number,url,state'],
      cwd,
      {
        env: { GH_NO_UPDATE_NOTIFIER: '1', GH_PROMPT_DISABLED: '1' },
        timeoutMs: PR_SPAWN_TIMEOUT_MS,
      },
    );
    const value = res.exitCode === 0 ? parsePullRequest(res.stdout) : null;
    this.pullRequestCache.set(cwd, { value, fetchedAt: now });
    return value;
  }

  private async runCommand(
    cmd: string,
    args: readonly string[],
    cwd: string,
    options: RunOptions = {},
  ): Promise<RunResult> {
    const spawned = await this.hostProcess
      .spawn(cmd, args, { cwd, env: options.env })
      .then(
        (proc) => ({ ok: true as const, proc }),
        () => ({ ok: false as const }),
      );
    if (!spawned.ok) {
      return { exitCode: -1, stdout: '', stderr: '' };
    }
    const { proc } = spawned;

    const work = Promise.all([
      collect(proc.stdout),
      collect(proc.stderr),
      proc.wait().catch(() => -1),
    ] as const);
    work.catch(() => {});

    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      if (options.timeoutMs === undefined) {
        const [stdout, stderr, exitCode] = await work;
        return { exitCode, stdout, stderr };
      }
      const timeout = new Promise<'timeout'>((resolve) => {
        timer = setTimeout(() => resolve('timeout'), options.timeoutMs);
        timer.unref?.();
      });
      const result = await Promise.race([
        work.then(
          ([stdout, stderr, exitCode]) =>
            ({ kind: 'done' as const, stdout, stderr, exitCode }),
        ),
        timeout.then((kind) => ({ kind })),
      ]);
      if (result.kind === 'done') {
        return { exitCode: result.exitCode, stdout: result.stdout, stderr: result.stderr };
      }
      await proc.kill('SIGKILL').catch(() => {});
      const [stdout, stderr] = await work
        .then(([so, se]) => [so, se] as const)
        .catch(() => ['', ''] as const);
      return { exitCode: -1, stdout, stderr };
    } finally {
      if (timer !== undefined) clearTimeout(timer);
      proc.dispose();
    }
  }

  private gitUnavailable(cwd: string, detail: string): Error2 {
    return new Error2(ErrorCodes.FS_GIT_UNAVAILABLE, `git unavailable at ${cwd}: ${detail}`, {
      details: { cwd, detail },
    });
  }
}

interface RunResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

interface RunOptions {
  readonly timeoutMs?: number;
  readonly env?: Record<string, string>;
}

async function collect(stream: AsyncIterable<Uint8Array | string>): Promise<string> {
  const decoder = new TextDecoder();
  let out = '';
  for await (const chunk of stream) {
    out += typeof chunk === 'string' ? chunk : decoder.decode(chunk, { stream: true });
  }
  out += decoder.decode();
  return out;
}

registerScopedService(LifecycleScope.App, IGitService, GitService, InstantiationType.Delayed, 'git');

import type {
  FsDiffResponse,
  FsGitStatusResponse,
  FsPullRequest,
  FsPullRequestLookup,
  GitStatusOptions,
} from './git';
import { LifecycleScope } from '#/app/scopes';
import { ScopeActivation, registerScopedService } from '#/_base/di/scope';
import { join } from 'pathe';

import { ErrorCodes, Error2 } from '#/errors';
import { IHostFileSystem } from '#/os/interface/hostFileSystem';
import { LOCAL_ENVIRONMENT_ID } from '#/environment/environment';
import { resolveProgramPath } from '#/environment/programPath';
import { IEnvironmentService, type EnvironmentResolver } from '#/app/environment/environment';

import { IGitService } from './git';
import { countTextLines, parseNumstat, parsePorcelain, parsePullRequest } from './gitParsers';
import { findGitWorkTree, type GitWorkTree } from './workTree';

const DIFF_MAX_BYTES = 1_048_576;

const GIT_SPAWN_TIMEOUT_MS = 30_000;
const PR_SPAWN_TIMEOUT_MS = 5_000;
const PULL_REQUEST_TTL_MS = 60_000;
const UNTRACKED_STATS_MAX_BYTES = 1_048_576;
const UNTRACKED_STATS_MAX_FILES = 2_000;

export class GitService implements IGitService {
  declare readonly _serviceBrand: undefined;

  private readonly pullRequestCache = new Map<
    string,
    { branch: string; value: FsPullRequestLookup; fetchedAt: number }
  >();

  constructor(
    @IEnvironmentService private readonly resolver: EnvironmentResolver,
    @IHostFileSystem private readonly fs: IHostFileSystem,
    private readonly environmentId: string = LOCAL_ENVIRONMENT_ID,
  ) {}

  async status(cwd: string, options: GitStatusOptions = {}): Promise<FsGitStatusResponse> {
    const inside = await this.runCommand('git', ['rev-parse', '--is-inside-work-tree'], cwd);
    if (inside.exitCode !== 0 || inside.stdout.trim() !== 'true') {
      throw this.gitUnavailable(cwd, inside.stderr.trim() || `git rev-parse exit ${inside.exitCode}`);
    }

    let pathPrefix = '';
    if (options.scopeToCwd === true) {
      const prefix = await this.runCommand('git', ['rev-parse', '--show-prefix'], cwd);
      if (prefix.exitCode !== 0) {
        throw this.gitUnavailable(cwd, prefix.stderr.trim() || `git rev-parse exit ${prefix.exitCode}`);
      }
      pathPrefix = prefix.stdout.replace(/\r?\n$/, '');
    }
    const statusArgs = ['status', '--porcelain=v1', '--branch', '-z'];
    if (options.scopeToCwd === true) statusArgs.push('--', '.');
    const porc = await this.runCommand('git', statusArgs, cwd);
    if (porc.exitCode !== 0) {
      throw this.gitUnavailable(cwd, porc.stderr.trim() || `git status exit ${porc.exitCode}`);
    }

    const result = parsePorcelain(porc.stdout, options.pathFilter, pathPrefix);

    const head = await this.runCommand('git', ['rev-parse', '--short', 'HEAD'], cwd);
    const hasHead = head.exitCode === 0;
    if (hasHead) result.head = head.stdout.trim();

    const records = porc.stdout.split('\0');
    const dirty = records.some((record) => record.length > 0 && !record.startsWith('## '));
    if (dirty && options.includeStats !== false) {
      const paths = options.pathFilter === undefined ? [] : [...options.pathFilter].toSorted();
      const scope = paths.length > 0 ? paths : options.scopeToCwd === true ? ['.'] : [];
      const failures: string[] = [];
      if (hasHead) {
        const numstat = await this.runCommand(
          'git',
          ['diff', '--no-color', '--numstat', 'HEAD', '--', ...scope],
          cwd,
        );
        if (numstat.exitCode === 0) {
          const stats = parseNumstat(numstat.stdout);
          result.additions = stats.additions;
          result.deletions = stats.deletions;
        } else {
          failures.push(commandFailure('git diff --numstat', numstat));
        }
      }
      if (options.includeUntracked === true && records.some((record) => record.startsWith('?? '))) {
        const untracked = await this.untrackedAdditions(cwd, scope);
        if (untracked.failure === undefined) result.additions += untracked.additions;
        else failures.push(untracked.failure);
      }
      if (failures.length > 0) result.stats_error = failures.join('\n');
    }

    if (options.includePullRequest === false) {
      result.pullRequest = null;
    } else {
      const lookup = await this.readPullRequest(cwd, result.branch);
      result.pullRequest = lookup.pullRequest;
      result.pull_request_status = lookup.status;
      result.pull_request_error = lookup.error;
    }
    return result;
  }

  private async untrackedAdditions(
    cwd: string,
    scope: readonly string[],
  ): Promise<{ additions: number; failure?: string }> {
    const listed = await this.runCommand(
      'git',
      ['ls-files', '--others', '--exclude-standard', '-z', '--', ...(scope.length > 0 ? scope : [':/'])],
      cwd,
    );
    if (listed.exitCode !== 0) {
      return { additions: 0, failure: commandFailure('git ls-files --others', listed) };
    }
    const files = listed.stdout
      .split('\0')
      .filter((file) => file.length > 0)
      .slice(0, UNTRACKED_STATS_MAX_FILES);
    let additions = 0;
    let cursor = 0;
    const worker = async (): Promise<void> => {
      while (cursor < files.length) {
        const file = join(cwd, files[cursor++]!);
        try {
          const stat = await this.fs.stat(file);
          if (!stat.isFile || stat.size > UNTRACKED_STATS_MAX_BYTES) continue;
          const lines = countTextLines(await this.fs.readBytes(file));
          additions += lines;
        } catch {
        }
      }
    };
    await Promise.all(Array.from({ length: Math.min(8, files.length) }, () => worker()));
    return { additions };
  }

  async pullRequest(cwd: string): Promise<FsPullRequest | null> {
    return (await this.pullRequestLookup(cwd)).pullRequest;
  }

  async pullRequestLookup(cwd: string): Promise<FsPullRequestLookup> {
    const head = await this.runCommand('git', ['symbolic-ref', '--short', '-q', 'HEAD'], cwd);
    if (head.exitCode !== 0 && head.exitCode !== 1) {
      throw this.gitUnavailable(cwd, head.stderr.trim() || `git symbolic-ref exit ${head.exitCode}`);
    }
    return this.readPullRequest(cwd, head.stdout.trim());
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
        const exists = await this.fs.lstat(absPath).then(
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

  findWorkTree(cwd: string): Promise<GitWorkTree | null> {
    return findGitWorkTree(this.fs, cwd);
  }

  private async readPullRequest(cwd: string, branch: string): Promise<FsPullRequestLookup> {
    if (branch === '') return { pullRequest: null, status: 'none' };
    const cached = this.pullRequestCache.get(cwd);
    const now = Date.now();
    if (cached !== undefined && cached.branch === branch && now - cached.fetchedAt < PULL_REQUEST_TTL_MS) {
      return cached.value;
    }

    const res = await this.runCommand(
      'gh',
      ['pr', 'view', '--json', 'number,url,state,isDraft'],
      cwd,
      {
        env: { GH_NO_UPDATE_NOTIFIER: '1', GH_PROMPT_DISABLED: '1' },
        timeoutMs: PR_SPAWN_TIMEOUT_MS,
      },
    );
    const value = classifyPullRequestLookup(res);
    this.pullRequestCache.set(cwd, { branch, value, fetchedAt: now });
    return value;
  }

  private async runCommand(
    cmd: string,
    args: readonly string[],
    cwd: string,
    options: RunOptions = {},
  ): Promise<RunResult> {
    const program = this.environmentId === LOCAL_ENVIRONMENT_ID ? localProgramPath(cmd, cwd) : cmd;
    if (program === undefined) {
      return { exitCode: -1, stdout: '', stderr: '', unavailable: true };
    }
    const lease = this.resolver.acquire({ environmentId: this.environmentId }, ['process']);
    const spawned = await lease.environment.process!
      .spawn(program, args, { cwd, env: options.env })
      .then(
        (proc) => ({ ok: true as const, proc }),
        () => ({ ok: false as const }),
      );
    if (!spawned.ok) {
      lease.dispose();
      return { exitCode: -1, stdout: '', stderr: '', unavailable: true };
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
      const timeout = new Promise<'timeout'>((resolve) => {
        timer = setTimeout(() => resolve('timeout'), options.timeoutMs ?? GIT_SPAWN_TIMEOUT_MS);
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
      return { exitCode: -1, stdout, stderr, timedOut: true };
    } finally {
      if (timer !== undefined) clearTimeout(timer);
      void proc.dispose();
      lease.dispose();
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
  readonly unavailable?: boolean;
  readonly timedOut?: boolean;
}

function commandFailure(command: string, result: RunResult): string {
  const detail = result.stderr.trim() || result.stdout.trim();
  if (result.timedOut === true) return `${command} timed out${detail === '' ? '' : `: ${detail}`}`;
  return `${command} exited with code ${result.exitCode}${detail === '' ? '' : `: ${detail}`}`;
}

const GH_NOT_SIGNED_IN = /gh auth login|not logged in|authentication required|GH_TOKEN/i;
const GH_NO_PULL_REQUEST =
  /no pull requests found|none of the git remotes|no git remotes found|not a github repository/i;

function classifyPullRequestLookup(result: RunResult): FsPullRequestLookup {
  if (result.unavailable === true) return { pullRequest: null, status: 'unavailable' };
  if (result.timedOut === true) {
    return { pullRequest: null, status: 'failed', error: commandFailure('gh pr view', result) };
  }
  if (result.exitCode === 0) {
    const pullRequest = parsePullRequest(result.stdout);
    return pullRequest === null
      ? { pullRequest, status: 'failed', error: result.stdout.trim() }
      : { pullRequest, status: 'found' };
  }
  if (result.exitCode === 4 || GH_NOT_SIGNED_IN.test(result.stderr)) {
    return { pullRequest: null, status: 'unavailable' };
  }
  if (GH_NO_PULL_REQUEST.test(result.stderr)) return { pullRequest: null, status: 'none' };
  return { pullRequest: null, status: 'failed', error: commandFailure('gh pr view', result) };
}

interface RunOptions {
  readonly timeoutMs?: number;
  readonly env?: Record<string, string>;
}

function localProgramPath(cmd: string, cwd: string): string | undefined {
  try {
    return resolveProgramPath(cmd, { cwd });
  } catch {
    return undefined;
  }
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

registerScopedService(LifecycleScope.App, IGitService, GitService, ScopeActivation.OnScopeCreated, 'git');

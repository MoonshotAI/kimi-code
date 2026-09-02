import type { FsDiffResponse, FsGitStatusResponse, FsPullRequest } from './git';
import { LifecycleScope } from '#/app/scopes';
import { ScopeActivation, registerScopedService } from '#/_base/di/scope';
import { ErrorCodes, Error2 } from '#/errors';
import { IHostFileSystem } from '#/os/interface/hostFileSystem';
import { IRuntimeResolver, IWorkspaceInstanceManager } from '#/workspace/workspaceInstance/workspaceInstanceManager';

import { IGitService } from './git';
import { parseNumstat, parsePorcelain, parsePullRequest } from './gitParsers';
import { findGitWorkTree, type GitWorkTree } from './workTree';

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
    @IRuntimeResolver private readonly resolver: IRuntimeResolver,
    @IWorkspaceInstanceManager private readonly workspaces: IWorkspaceInstanceManager,
    @IHostFileSystem private readonly fs: IHostFileSystem,
  ) {}

  async status(cwd: string, pathFilter?: ReadonlySet<string>): Promise<FsGitStatusResponse> {
    const inside = await this.runCommand('git', ['rev-parse', '--is-inside-work-tree'], cwd);
    if (inside.exitCode !== 0 || inside.stdout.trim() !== 'true') {
      throw this.gitUnavailable(cwd, inside.stderr.trim() || `git rev-parse exit ${inside.exitCode}`);
    }

    const porc = await this.runCommand('git', ['status', '--porcelain=v1', '--branch', '-z'], cwd);
    if (porc.exitCode !== 0) {
      throw this.gitUnavailable(cwd, porc.stderr.trim() || `git status exit ${porc.exitCode}`);
    }

    const result = parsePorcelain(porc.stdout, pathFilter);

    const dirty = porc.stdout
      .split('\0')
      .some((record) => record.length > 0 && !record.startsWith('## '));
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
    let diffTruncated: boolean;
    if (untracked || !hasHead) {
      const res = await this.runCommand(
        'git',
        ['diff', '--no-color', '--no-index', '--', '/dev/null', relPath],
        cwd,
        { stdoutMaxBytes: DIFF_MAX_BYTES },
      );
      if (res.exitCode !== 0 && res.exitCode !== 1) {
        throw this.gitUnavailable(cwd, res.stderr.trim() || `git diff exit ${res.exitCode}`);
      }
      diffStdout = res.stdout;
      diffTruncated = res.stdoutTruncated;
    } else {
      const res = await this.runCommand('git', ['diff', '--no-color', 'HEAD', '--', relPath], cwd, {
        stdoutMaxBytes: DIFF_MAX_BYTES,
      });
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
      diffTruncated = res.stdoutTruncated;
    }

    return {
      path: relPath,
      diff: diffStdout,
      truncated: diffTruncated,
    };
  }

  findWorkTree(cwd: string): Promise<GitWorkTree | null> {
    return findGitWorkTree(this.fs, cwd);
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
    const workspaceId = this.resolveWorkspaceId(cwd);
    const lease = this.resolver.acquire({ workspaceId, runtimeId: 'local' }, ['process']);
    const spawned = await lease.runtime.process!
      .spawn(cmd, args, { cwd, env: options.env })
      .then(
        (proc) => ({ ok: true as const, proc }),
        () => ({ ok: false as const }),
      );
    if (!spawned.ok) {
      return { exitCode: -1, stdout: '', stdoutTruncated: false, stderr: '' };
    }
    const { proc } = spawned;

    const work = Promise.all([
      collect(proc.stdout, options.stdoutMaxBytes),
      collect(proc.stderr),
      proc.wait().catch(() => -1),
    ] as const);
    work.catch(() => {});

    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      if (options.timeoutMs === undefined) {
        const [stdout, stderr, exitCode] = await work;
        return {
          exitCode,
          stdout: stdout.value,
          stdoutTruncated: stdout.truncated,
          stderr: stderr.value,
        };
      }
      const timeout = new Promise<'timeout'>((resolve) => {
        timer = setTimeout(() => resolve('timeout'), options.timeoutMs);
        timer.unref?.();
      });
      const result = await Promise.race([
        work.then(
          ([stdout, stderr, exitCode]) => ({ kind: 'done' as const, stdout, stderr, exitCode }),
        ),
        timeout.then((kind) => ({ kind })),
      ]);
      if (result.kind === 'done') {
        return {
          exitCode: result.exitCode,
          stdout: result.stdout.value,
          stdoutTruncated: result.stdout.truncated,
          stderr: result.stderr.value,
        };
      }
      await proc.kill('SIGKILL').catch(() => {});
      const [stdout, stderr] = await work
        .then(([so, se]) => [so, se] as const)
        .catch(() => [createTextCapture(), createTextCapture()] as const);
      return {
        exitCode: -1,
        stdout: stdout.value,
        stdoutTruncated: stdout.truncated,
        stderr: stderr.value,
      };
    } finally {
      if (timer !== undefined) clearTimeout(timer);
      void proc.dispose();
      lease.dispose();
    }
  }

  private resolveWorkspaceId(cwd: string): string {
    const workspace = this.workspaces.findByRoot(cwd);
    if (workspace === undefined) {
      throw new Error(`workspace for root ${cwd} is not materialized`);
    }
    return workspace.id;
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
  readonly stdoutTruncated: boolean;
  readonly stderr: string;
}

interface RunOptions {
  readonly timeoutMs?: number;
  readonly env?: Record<string, string>;
  readonly stdoutMaxBytes?: number;
}

interface TextCapture {
  value: string;
  bytes: number;
  truncated: boolean;
}

const UTF8_ENCODER = new TextEncoder();

function createTextCapture(): TextCapture {
  return { value: '', bytes: 0, truncated: false };
}

function appendText(capture: TextCapture, chunk: string, maxBytes?: number): void {
  if (maxBytes === undefined) {
    capture.value += chunk;
    return;
  }
  if (capture.truncated) return;

  const remaining = maxBytes - capture.bytes;
  if (remaining <= 0) {
    capture.truncated ||= chunk.length > 0;
    return;
  }

  const destination = new Uint8Array(Math.min(remaining, chunk.length * 3));
  const { read, written } = UTF8_ENCODER.encodeInto(chunk, destination);
  capture.value += chunk.slice(0, read);
  capture.bytes += written;
  capture.truncated ||= read < chunk.length;
}

async function collect(
  stream: AsyncIterable<Uint8Array | string>,
  maxBytes?: number,
): Promise<TextCapture> {
  const decoder = new TextDecoder();
  const capture = createTextCapture();
  for await (const chunk of stream) {
    appendText(
      capture,
      typeof chunk === 'string' ? chunk : decoder.decode(chunk, { stream: true }),
      maxBytes,
    );
  }
  appendText(capture, decoder.decode(), maxBytes);
  return capture;
}

registerScopedService(LifecycleScope.App, IGitService, GitService, ScopeActivation.OnScopeCreated, 'git');

import { isAbsolute, join, relative, resolve } from 'pathe';

import type { OsFsPort, OsProcess, OsProcessPort } from '#/features/os/host/index';

const GIT_TIMEOUT_MS = 60_000;
const GIT_MAX_OUTPUT_BYTES = 16 * 1024 * 1024;
const SIGTERM_GRACE_MS = 5_000;

export class GitError extends Error {
  constructor(
    readonly args: readonly string[],
    readonly stderr: string,
  ) {
    super(`git ${args.join(' ')} failed: ${stderr.trim() || 'unknown error'}`);
    this.name = 'GitError';
  }
}

export interface GitOptions {
  readonly env?: Readonly<Record<string, string>>;
}

export type GitRunner = (
  cwd: string,
  args: readonly string[],
  options?: GitOptions,
) => Promise<string>;

interface CappedOutput {
  readonly text: string;
  readonly truncated: boolean;
}

function isPrematureCloseError(error: unknown): boolean {
  return (
    error instanceof Error &&
    (error as NodeJS.ErrnoException).code === 'ERR_STREAM_PREMATURE_CLOSE'
  );
}

async function readCapped(
  stream: AsyncIterable<Uint8Array>,
  suppressPrematureClose: () => boolean,
): Promise<CappedOutput> {
  const chunks: Buffer[] = [];
  let total = 0;
  let truncated = false;
  try {
    for await (const chunk of stream) {
      const buf = Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength);
      if (truncated) continue;
      if (total + buf.length > GIT_MAX_OUTPUT_BYTES) {
        const remaining = GIT_MAX_OUTPUT_BYTES - total;
        if (remaining > 0) chunks.push(buf.subarray(0, remaining));
        total = GIT_MAX_OUTPUT_BYTES;
        truncated = true;
        continue;
      }
      chunks.push(buf);
      total += buf.length;
    }
  } catch (error) {
    if (!isPrematureCloseError(error) || suppressPrematureClose() !== true) {
      throw error;
    }
  }
  return { text: Buffer.concat(chunks).toString('utf8'), truncated };
}

function disposeProcess(proc: OsProcess): void {
  try {
    proc.dispose();
  } catch {
  }
}

export function createGitRunner(processPort: OsProcessPort): GitRunner {
  return async (cwd, args, options = {}) => {
    let proc: OsProcess;
    try {
      proc = await processPort.spawn('git', [...args], {
        cwd,
        env: options.env === undefined ? undefined : { ...options.env },
      });
    } catch (error) {
      throw new GitError(args, error instanceof Error ? error.message : String(error));
    }
    try {
      proc.stdin.end();
    } catch {
    }
    let timedOut = false;
    let killed = false;
    const killProc = async (): Promise<void> => {
      if (killed) return;
      killed = true;
      try {
        await proc.kill('SIGTERM');
      } catch {
      }
      const exited = proc
        .wait()
        .then(() => true)
        .catch(() => true);
      const grace = await Promise.race([
        exited,
        new Promise<false>((resolvePromise) => {
          setTimeout(() => {
            resolvePromise(false);
          }, SIGTERM_GRACE_MS);
        }),
      ]);
      if (!grace && proc.exitCode === null) {
        try {
          await proc.kill('SIGKILL');
        } catch {
        }
      }
    };
    const timer = setTimeout(() => {
      timedOut = true;
      void killProc();
    }, GIT_TIMEOUT_MS);
    const terminating = (): boolean => timedOut || killed;
    try {
      const [stdout, stderr, exitCode] = await Promise.all([
        readCapped(proc.stdout, terminating),
        readCapped(proc.stderr, terminating),
        proc.wait(),
      ]);
      if (timedOut) {
        throw new GitError(args, stderr.text || `Command failed: git ${args.join(' ')}`);
      }
      if (stdout.truncated || stderr.truncated) {
        await killProc();
        const which = stdout.truncated ? 'stdout' : 'stderr';
        throw new GitError(args, stderr.text || `${which} maxBuffer length exceeded`);
      }
      if (exitCode !== 0) {
        throw new GitError(args, stderr.text || `Command failed: git ${args.join(' ')}`);
      }
      return stdout.text.trimEnd();
    } finally {
      clearTimeout(timer);
      disposeProcess(proc);
    }
  };
}

export interface GitPorts {
  readonly process: OsProcessPort;
  readonly fs: OsFsPort;
}

export class Git {
  private readonly fs: OsFsPort;
  readonly runGit: GitRunner;

  constructor(ports: GitPorts) {
    this.runGit = createGitRunner(ports.process);
    this.fs = ports.fs;
  }

  async tryGit(cwd: string, args: readonly string[]): Promise<string | null> {
    try {
      return await this.runGit(cwd, args);
    } catch {
      return null;
    }
  }

  async isInsideRepo(cwd: string): Promise<boolean> {
    return (await this.tryGit(cwd, ['rev-parse', '--is-inside-work-tree'])) === 'true';
  }

  async hasAnyCommit(cwd: string): Promise<boolean> {
    return (await this.tryGit(cwd, ['rev-list', '-n', '1', '--all'])) !== null;
  }

  async currentBranch(cwd: string): Promise<string> {
    const branch = await this.runGit(cwd, ['rev-parse', '--abbrev-ref', 'HEAD']);
    if (branch === 'HEAD') throw new Error('cannot determine base branch from a detached HEAD');
    return branch;
  }

  async branchTip(cwd: string, ref: string): Promise<string> {
    return this.runGit(cwd, ['rev-parse', ref]);
  }

  async branchExists(cwd: string, branch: string): Promise<boolean> {
    return (
      (await this.tryGit(cwd, ['show-ref', '--verify', '--quiet', `refs/heads/${branch}`])) !==
      null
    );
  }

  async initRepository(cwd: string): Promise<void> {
    await this.runGit(cwd, ['init']);
  }

  private async gitCommit(cwd: string, args: readonly string[]): Promise<void> {
    try {
      await this.runGit(cwd, args);
    } catch (error) {
      if (!(error instanceof GitError) || !/identity unknown/.test(error.stderr)) {
        throw error;
      }
      await this.runGit(cwd, [
        '-c',
        'user.name=Kimi Tower',
        '-c',
        'user.email=kimi-tower@localhost',
        ...args,
      ]);
    }
  }

  async checkoutNewLocalBranch(cwd: string, branch: string): Promise<void> {
    await this.runGit(cwd, ['checkout', '-b', branch]);
  }

  async commitAllowEmpty(cwd: string, message: string): Promise<void> {
    await this.gitCommit(cwd, ['commit', '--allow-empty', '-m', message]);
  }

  async commitPaths(cwd: string, paths: readonly string[], message: string): Promise<void> {
    for (let i = 0; i < paths.length; i += ADD_PATHS_CHUNK) {
      await this.runGit(cwd, ['add', '-A', '--', ...paths.slice(i, i + ADD_PATHS_CHUNK)]);
    }
    await this.gitCommit(cwd, ['commit', '-m', message]);
  }

  async isAncestor(cwd: string, ancestor: string, ref: string): Promise<boolean> {
    return (await this.tryGit(cwd, ['merge-base', '--is-ancestor', ancestor, ref])) !== null;
  }

  async worktreeAdd(cwd: string, path: string, branch: string): Promise<void> {
    await this.runGit(cwd, ['worktree', 'add', path, branch]);
  }

  async worktreeAddNewBranch(
    cwd: string,
    path: string,
    branch: string,
    base: string,
  ): Promise<void> {
    await this.runGit(cwd, ['worktree', 'add', path, '-b', branch, base]);
  }

  async worktreeRemove(cwd: string, path: string): Promise<void> {
    await this.runGit(cwd, ['worktree', 'remove', '--force', path]);
  }

  async isRegisteredWorktree(repoRoot: string, path: string): Promise<boolean> {
    const gitDir = await this.tryGit(path, ['rev-parse', '--git-dir']);
    if (gitDir === null) return false;
    const commonDir = await this.tryGit(repoRoot, ['rev-parse', '--git-common-dir']);
    if (commonDir === null) return false;
    const adminRoot = join(
      await this.fs.realpath(resolve(await this.fs.realpath(repoRoot), commonDir.trim())),
      'worktrees',
    );
    const resolved = resolve(await this.fs.realpath(path), gitDir.trim());
    const inside = relative(adminRoot, resolved);
    return inside.length > 0 && !inside.startsWith('..') && !isAbsolute(inside);
  }

  async isWorktreeDirty(path: string): Promise<boolean> {
    const status = await this.tryGit(path, ['status', '--porcelain']);
    return status !== null && status.trim().length > 0;
  }

  async mergeNoFf(cwd: string, branch: string): Promise<string> {
    await this.runGit(cwd, ['merge', '--no-ff', branch]);
    return this.branchTip(cwd, 'HEAD');
  }

  async diffNameOnly(cwd: string, base: string, ref: string): Promise<readonly string[]> {
    const out = await this.runGit(cwd, ['diff', '--name-only', `${base}...${ref}`]);
    return out.length === 0 ? [] : out.split('\n').filter((line) => line.trim().length > 0);
  }
}

const ADD_PATHS_CHUNK = 100;

import type { OsHost, OsProcess, OsProcessPort } from '#/features/os/host/index';

import { missingPathError, WorkspaceFsError } from './errors';
import type { FsDiffResponse, FsGitStatus, FsGitStatusResponse, FsPullRequest } from './wire';

const GIT_TIMEOUT_MS = 60_000;
const SIGTERM_GRACE_MS = 5_000;
const DIFF_MAX_BYTES = 1_048_576;
const PR_SPAWN_TIMEOUT_MS = 5_000;
const PULL_REQUEST_TTL_MS = 60_000;

export interface WorkspaceGitPort {
  status(cwd: string, pathFilter?: ReadonlySet<string>): Promise<FsGitStatusResponse>;
  diff(cwd: string, relPath: string, absPath: string): Promise<FsDiffResponse>;
}

interface GitRunResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

interface GitRunOptions {
  readonly env?: Readonly<Record<string, string>>;
  readonly timeoutMs?: number;
}

export function createWorkspaceGit(host: OsHost): WorkspaceGitPort {
  const processPort = host.process;
  const pullRequestCache = new Map<string, { value: FsPullRequest | null; fetchedAt: number }>();

  const readPullRequest = async (cwd: string): Promise<FsPullRequest | null> => {
    const cached = pullRequestCache.get(cwd);
    const now = Date.now();
    if (cached !== undefined && now - cached.fetchedAt < PULL_REQUEST_TTL_MS) {
      return cached.value;
    }
    const res = await runCommand(processPort, 'gh', ['pr', 'view', '--json', 'number,url,state'], cwd, {
      env: { GH_NO_UPDATE_NOTIFIER: '1', GH_PROMPT_DISABLED: '1' },
      timeoutMs: PR_SPAWN_TIMEOUT_MS,
    });
    const value = res.exitCode === 0 ? parsePullRequest(res.stdout) : null;
    pullRequestCache.set(cwd, { value, fetchedAt: now });
    return value;
  };

  const status = async (
    cwd: string,
    pathFilter?: ReadonlySet<string>,
  ): Promise<FsGitStatusResponse> => {
    const inside = await runCommand(processPort, 'git', ['rev-parse', '--is-inside-work-tree'], cwd);
    if (inside.exitCode !== 0 || inside.stdout.trim() !== 'true') {
      throw gitUnavailable(cwd, inside.stderr.trim() || `git rev-parse exit ${inside.exitCode}`);
    }

    const porc = await runCommand(processPort, 'git', ['status', '--porcelain=v1', '--branch', '-z'], cwd);
    if (porc.exitCode !== 0) {
      throw gitUnavailable(cwd, porc.stderr.trim() || `git status exit ${porc.exitCode}`);
    }

    const result = parsePorcelain(porc.stdout, pathFilter);

    const dirty = porc.stdout
      .split('\0')
      .some((record) => record.length > 0 && !record.startsWith('## '));
    if (dirty) {
      const head = await runCommand(processPort, 'git', ['rev-parse', '--verify', '--quiet', 'HEAD'], cwd);
      if (head.exitCode === 0) {
        const numstat = await runCommand(processPort, 'git', ['diff', '--no-color', '--numstat', 'HEAD', '--'], cwd);
        if (numstat.exitCode === 0) {
          const stats = parseNumstat(numstat.stdout);
          result.additions = stats.additions;
          result.deletions = stats.deletions;
        }
      }
    }

    result.pullRequest = await readPullRequest(cwd);
    return result;
  };

  const diff = async (cwd: string, relPath: string, absPath: string): Promise<FsDiffResponse> => {
    const inside = await runCommand(processPort, 'git', ['rev-parse', '--is-inside-work-tree'], cwd);
    if (inside.exitCode !== 0 || inside.stdout.trim() !== 'true') {
      throw gitUnavailable(cwd, inside.stderr.trim() || `git rev-parse exit ${inside.exitCode}`);
    }

    const statusRes = await runCommand(processPort, 'git', ['status', '--porcelain=v1', '--', relPath], cwd);
    if (statusRes.exitCode !== 0) {
      throw gitUnavailable(cwd, statusRes.stderr.trim() || `git status exit ${statusRes.exitCode}`);
    }
    const untracked = statusRes.stdout.startsWith('??');

    const headRes = await runCommand(processPort, 'git', ['rev-parse', '--verify', '--quiet', 'HEAD'], cwd);
    const hasHead = headRes.exitCode === 0;

    let diffStdout: string;
    if (untracked || !hasHead) {
      const res = await runCommand(
        processPort,
        'git',
        ['diff', '--no-color', '--no-index', '--', '/dev/null', relPath],
        cwd,
      );
      if (res.exitCode !== 0 && res.exitCode !== 1) {
        throw gitUnavailable(cwd, res.stderr.trim() || `git diff exit ${res.exitCode}`);
      }
      diffStdout = res.stdout;
    } else {
      const res = await runCommand(processPort, 'git', ['diff', '--no-color', 'HEAD', '--', relPath], cwd);
      if (res.exitCode !== 0) {
        throw gitUnavailable(cwd, res.stderr.trim() || `git diff exit ${res.exitCode}`);
      }
      if (res.stdout.length === 0 && statusRes.stdout.length === 0) {
        const exists = await host.fs.lstat(absPath).then(
          () => true,
          () => false,
        );
        if (!exists) {
          throw missingPathError(relPath);
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
  };

  return { status, diff };
}

function gitUnavailable(cwd: string, detail: string): WorkspaceFsError {
  return new WorkspaceFsError('fs.git_unavailable', `git unavailable at ${cwd}: ${detail}`, {
    cwd,
    detail,
  });
}

function disposeProcess(proc: OsProcess): void {
  try {
    proc.dispose();
  } catch {
  }
}

async function readStream(stream: AsyncIterable<Uint8Array>): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) {
    chunks.push(Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength));
  }
  return Buffer.concat(chunks).toString('utf8');
}

async function runCommand(
  processPort: OsProcessPort,
  cmd: string,
  args: readonly string[],
  cwd: string,
  options: GitRunOptions = {},
): Promise<GitRunResult> {
  let proc: OsProcess;
  try {
    proc = await processPort.spawn(cmd, args, {
      cwd,
      env: options.env === undefined ? undefined : { ...options.env },
    });
  } catch {
    return { exitCode: -1, stdout: '', stderr: '' };
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
    const grace = await Promise.race([
      proc
        .wait()
        .then(() => true)
        .catch(() => true),
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
  }, options.timeoutMs ?? GIT_TIMEOUT_MS);
  timer.unref?.();
  try {
    const [stdout, stderr, exitCode] = await Promise.all([
      readStream(proc.stdout),
      readStream(proc.stderr),
      proc.wait().catch(() => -1),
    ]);
    if (timedOut) {
      return { exitCode: -1, stdout, stderr };
    }
    return { exitCode, stdout, stderr };
  } finally {
    clearTimeout(timer);
    disposeProcess(proc);
  }
}

export function parsePorcelain(
  stdout: string,
  filter: ReadonlySet<string> | undefined,
): FsGitStatusResponse {
  const records = stdout.split('\0');
  let branch = '';
  let ahead = 0;
  let behind = 0;
  const entries: Record<string, FsGitStatus> = {};

  for (let i = 0; i < records.length; i++) {
    const record = records[i]!;
    if (record.length === 0) continue;
    if (record.startsWith('## ')) {
      const parsed = parseBranchHeader(record.slice(3));
      branch = parsed.branch;
      ahead = parsed.ahead;
      behind = parsed.behind;
      continue;
    }

    if (record.length < 4) continue;
    const xy = record.slice(0, 2);
    const wirePath = record.slice(3);

    if (xy.startsWith('R') || xy.startsWith('C')) {
      i++;
    }
    if (filter !== undefined && !filter.has(wirePath)) continue;
    const status = collapseXY(xy);
    entries[wirePath] = status;
  }

  return { branch, ahead, behind, entries, additions: 0, deletions: 0, pullRequest: null };
}

export function parseNumstat(stdout: string): {
  additions: number;
  deletions: number;
} {
  let additions = 0;
  let deletions = 0;
  for (const line of stdout.split('\n')) {
    if (line.length === 0) continue;
    const [addedText, deletedText] = line.split('\t');
    additions += parseNumstatCount(addedText);
    deletions += parseNumstatCount(deletedText);
  }
  return { additions, deletions };
}

function parseNumstatCount(value: string | undefined): number {
  if (value === undefined || value === '-') return 0;
  const n = Number.parseInt(value, 10);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

function parseBranchHeader(rest: string): {
  branch: string;
  ahead: number;
  behind: number;
} {
  if (rest.startsWith('HEAD (no branch)')) {
    return { branch: '', ahead: 0, behind: 0 };
  }
  if (rest.startsWith('No commits yet on ')) {
    return { branch: rest.slice('No commits yet on '.length), ahead: 0, behind: 0 };
  }
  let branch = rest;
  let ahead = 0;
  let behind = 0;

  const bracket = rest.indexOf(' [');
  if (bracket >= 0) {
    branch = rest.slice(0, bracket);
    const sliced = rest.slice(bracket + 2, rest.length - 1);
    const aheadMatch = sliced.match(/ahead (\d+)/);
    const behindMatch = sliced.match(/behind (\d+)/);
    if (aheadMatch !== null) ahead = Number.parseInt(aheadMatch[1] ?? '0', 10) || 0;
    if (behindMatch !== null) behind = Number.parseInt(behindMatch[1] ?? '0', 10) || 0;
  }

  const dots = branch.indexOf('...');
  if (dots >= 0) branch = branch.slice(0, dots);
  return { branch, ahead, behind };
}

function collapseXY(xy: string): FsGitStatus {
  if (xy === '??') return 'untracked';
  if (xy === '!!') return 'ignored';
  const x = xy.charAt(0);
  const y = xy.charAt(1);
  const set = new Set([x, y]);

  if (
    xy === 'DD' ||
    xy === 'AU' ||
    xy === 'UD' ||
    xy === 'UA' ||
    xy === 'DU' ||
    xy === 'AA' ||
    xy === 'UU'
  ) {
    return 'conflicted';
  }
  if (set.has('D')) return 'deleted';
  if (set.has('M') || set.has('T')) return 'modified';
  if (set.has('R')) return 'renamed';
  if (set.has('C')) return 'renamed';
  if (set.has('A')) return 'added';
  return 'clean';
}

export function parsePullRequest(stdout: string): FsPullRequest | null {
  let raw: unknown;
  try {
    raw = JSON.parse(stdout);
  } catch {
    return null;
  }
  if (typeof raw !== 'object' || raw === null) return null;
  const record = raw as Record<string, unknown>;
  const number = record['number'];
  const url = record['url'];
  const state = record['state'];
  if (typeof number !== 'number' || !Number.isInteger(number) || number <= 0) return null;
  if (typeof url !== 'string' || !isSafeHttpUrl(url)) return null;
  if (typeof state !== 'string') return null;
  const normalized = state.toLowerCase();
  if (normalized !== 'open' && normalized !== 'merged' && normalized !== 'closed') return null;
  return { number, state: normalized, url };
}

function isSafeHttpUrl(value: string): boolean {
  if (hasControlChars(value)) return false;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' || url.protocol === 'http:';
  } catch {
    return false;
  }
}

function hasControlChars(value: string): boolean {
  for (const char of value) {
    const code = char.codePointAt(0) ?? 0;
    if (code <= 0x1f || code === 0x7f) return true;
  }
  return false;
}

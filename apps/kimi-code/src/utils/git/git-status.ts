/**
 * Cached git branch + working-tree status for the footer/statusline.
 *
 * Branch name refreshes every 5s, porcelain status every 15s. Branch
 * and status reads stay synchronous with short timeouts. Pull request
 * lookup uses an async cache so a slow `gh pr view` never blocks
 * footer rendering.
 */

import { execFile, spawnSync } from 'node:child_process';

const BRANCH_TTL_MS = 5_000;
const STATUS_TTL_MS = 15_000;
const PULL_REQUEST_TTL_MS = 60_000;
const SPAWN_TIMEOUT_MS = 500;
const PR_SPAWN_TIMEOUT_MS = 5_000;

export interface GitStatus {
  readonly branch: string;
  readonly dirty: boolean;
  readonly ahead: number;
  readonly behind: number;
  readonly diffAdded: number;
  readonly diffDeleted: number;
  readonly pullRequest: PullRequestInfo | null;
}

export interface PullRequestInfo {
  readonly number: number;
  readonly url: string;
}

export interface GitStatusCache {
  /** Returns current status, or `null` when workDir is not a git repo. */
  getStatus(): GitStatus | null;
}

export interface GitStatusCacheOptions {
  readonly onChange?: () => void;
}

interface BranchState {
  value: string | null;
  fetchedAt: number;
}

interface StatusState {
  dirty: boolean;
  ahead: number;
  behind: number;
  diffAdded: number;
  diffDeleted: number;
  fetchedAt: number;
}

interface PullRequestState {
  value: PullRequestInfo | null;
  branch: string | null;
  fetchedAt: number;
  pendingBranch: string | null;
  requestId: number;
}

const AHEAD_BEHIND_RE = /\[(?:ahead (\d+))?(?:, )?(?:behind (\d+))?\]/;

export function createGitStatusCache(
  workDir: string,
  options: GitStatusCacheOptions = {},
): GitStatusCache {
  const isRepo = detectGitRepo(workDir);
  let branch: BranchState = { value: null, fetchedAt: 0 };
  let status: StatusState = {
    dirty: false,
    ahead: 0,
    behind: 0,
    diffAdded: 0,
    diffDeleted: 0,
    fetchedAt: 0,
  };
  let pullRequest: PullRequestState = {
    value: null,
    branch: null,
    fetchedAt: 0,
    pendingBranch: null,
    requestId: 0,
  };

  return {
    getStatus: () => {
      if (!isRepo) return null;

      const now = Date.now();
      if (now - branch.fetchedAt >= BRANCH_TTL_MS) {
        branch = { value: readBranch(workDir), fetchedAt: now };
      }
      if (branch.value === null) return null;

      if (now - status.fetchedAt >= STATUS_TTL_MS) {
        status = { ...readStatus(workDir), fetchedAt: now };
      }
      refreshPullRequestIfNeeded(branch.value, now);

      return {
        branch: branch.value,
        dirty: status.dirty,
        ahead: status.ahead,
        behind: status.behind,
        diffAdded: status.diffAdded,
        diffDeleted: status.diffDeleted,
        pullRequest: pullRequest.branch === branch.value ? pullRequest.value : null,
      };
    },
  };

  function refreshPullRequestIfNeeded(branchName: string, now: number): void {
    if (pullRequest.pendingBranch === branchName) return;
    const fetchedAt = pullRequest.branch === branchName ? pullRequest.fetchedAt : 0;
    if (now - fetchedAt < PULL_REQUEST_TTL_MS) return;

    const requestId = pullRequest.requestId + 1;
    pullRequest = {
      value: pullRequest.branch === branchName ? pullRequest.value : null,
      branch: branchName,
      fetchedAt,
      pendingBranch: branchName,
      requestId,
    };

    void readPullRequest(workDir).then((value) => {
      if (pullRequest.requestId !== requestId) return;

      const previous = pullRequest.branch === branchName ? pullRequest.value : null;
      const changed = !samePullRequest(previous, value);
      pullRequest = {
        value,
        branch: branchName,
        fetchedAt: Date.now(),
        pendingBranch: null,
        requestId,
      };
      if (changed) options.onChange?.();
    });
  }
}

function detectGitRepo(workDir: string): boolean {
  try {
    const result = spawnSync('git', ['-C', workDir, 'rev-parse', '--is-inside-work-tree'], {
      encoding: 'utf8',
      timeout: SPAWN_TIMEOUT_MS,
    });
    return result.status === 0 && result.stdout.trim() === 'true';
  } catch {
    return false;
  }
}

function readBranch(workDir: string): string | null {
  try {
    const result = spawnSync('git', ['-C', workDir, 'branch', '--show-current'], {
      encoding: 'utf8',
      timeout: SPAWN_TIMEOUT_MS,
    });
    if (result.status !== 0) return null;
    const name = result.stdout.trim();
    return name.length > 0 ? name : null;
  } catch {
    return null;
  }
}

function readStatus(workDir: string): {
  dirty: boolean;
  ahead: number;
  behind: number;
  diffAdded: number;
  diffDeleted: number;
} {
  try {
    const result = spawnSync('git', ['-C', workDir, 'status', '--porcelain', '-b'], {
      encoding: 'utf8',
      timeout: SPAWN_TIMEOUT_MS,
      maxBuffer: 4 * 1024 * 1024,
    });
    if (result.status !== 0) {
      return { dirty: false, ahead: 0, behind: 0, diffAdded: 0, diffDeleted: 0 };
    }

    let dirty = false;
    let ahead = 0;
    let behind = 0;
    for (const line of result.stdout.split('\n')) {
      if (line.startsWith('## ')) {
        const m = AHEAD_BEHIND_RE.exec(line);
        if (m) {
          ahead = Number.parseInt(m[1] ?? '0', 10) || 0;
          behind = Number.parseInt(m[2] ?? '0', 10) || 0;
        }
      } else if (line.trim().length > 0) {
        dirty = true;
      }
    }
    const diff = dirty ? readDiffStats(workDir) : { added: 0, deleted: 0 };
    return {
      dirty,
      ahead,
      behind,
      diffAdded: diff.added,
      diffDeleted: diff.deleted,
    };
  } catch {
    return { dirty: false, ahead: 0, behind: 0, diffAdded: 0, diffDeleted: 0 };
  }
}

function readDiffStats(workDir: string): { added: number; deleted: number } {
  try {
    const result = spawnSync('git', ['-C', workDir, 'diff', '--numstat', 'HEAD', '--'], {
      encoding: 'utf8',
      timeout: SPAWN_TIMEOUT_MS,
      maxBuffer: 4 * 1024 * 1024,
    });
    if (result.status !== 0) return { added: 0, deleted: 0 };

    let added = 0;
    let deleted = 0;
    for (const line of result.stdout.split('\n')) {
      if (!line) continue;
      const [addedText, deletedText] = line.split('\t');
      added += parseDiffNumstatCount(addedText);
      deleted += parseDiffNumstatCount(deletedText);
    }
    return { added, deleted };
  } catch {
    return { added: 0, deleted: 0 };
  }
}

function parseDiffNumstatCount(value: string | undefined): number {
  if (value === undefined || value === '-') return 0;
  const n = Number.parseInt(value, 10);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

function readPullRequest(workDir: string): Promise<PullRequestInfo | null> {
  return new Promise((resolve) => {
    try {
      execFile(
        'gh',
        ['pr', 'view', '--json', 'number,url'],
        {
          cwd: workDir,
          encoding: 'utf8',
          env: {
            ...process.env,
            GH_NO_UPDATE_NOTIFIER: '1',
            GH_PROMPT_DISABLED: '1',
          },
          timeout: PR_SPAWN_TIMEOUT_MS,
          maxBuffer: 256 * 1024,
        },
        (error, stdout) => {
          if (error !== null) {
            resolve(null);
            return;
          }
          resolve(parsePullRequest(stdout));
        },
      );
    } catch {
      resolve(null);
    }
  });
}

function samePullRequest(a: PullRequestInfo | null, b: PullRequestInfo | null): boolean {
  if (a === null || b === null) return a === b;
  return a.number === b.number && a.url === b.url;
}

function parsePullRequest(stdout: string): PullRequestInfo | null {
  try {
    const raw = JSON.parse(stdout) as unknown;
    if (typeof raw !== 'object' || raw === null) return null;
    const record = raw as Record<string, unknown>;
    const number = record['number'];
    const url = record['url'];
    if (typeof number !== 'number' || !Number.isInteger(number) || number <= 0) return null;
    if (typeof url !== 'string' || !isSafeHttpUrl(url)) return null;
    return { number, url };
  } catch {
    return null;
  }
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

export interface FormatGitBadgeOptions {
  readonly linkPullRequest?: boolean;
}

export function formatGitBadgeBase(status: GitStatus): string {
  const parts: string[] = [];
  const diff = formatDiffStats(status);
  if (diff) parts.push(diff);
  let sync = '';
  if (status.ahead > 0) sync += `↑${status.ahead}`;
  if (status.behind > 0) sync += `↓${status.behind}`;
  if (sync) parts.push(sync);
  return parts.length === 0 ? status.branch : `${status.branch} [${parts.join(' ')}]`;
}

export function formatPullRequestBadge(
  pullRequest: PullRequestInfo,
  options: FormatGitBadgeOptions = {},
): string {
  const prText = `[PR#${String(pullRequest.number)}]`;
  return options.linkPullRequest ? toTerminalHyperlink(prText, pullRequest.url) : prText;
}

export function formatGitBadge(status: GitStatus, options: FormatGitBadgeOptions = {}): string {
  const base = formatGitBadgeBase(status);
  if (status.pullRequest === null) return base;

  return `${base} ${formatPullRequestBadge(status.pullRequest, options)}`;
}

function formatDiffStats(status: GitStatus): string | null {
  const parts: string[] = [];
  if (status.diffAdded > 0) parts.push(`+${String(status.diffAdded)}`);
  if (status.diffDeleted > 0) parts.push(`-${String(status.diffDeleted)}`);
  if (parts.length > 0) return parts.join(' ');
  return status.dirty ? '±' : null;
}

function toTerminalHyperlink(text: string, url: string): string {
  if (!isSafeHttpUrl(url)) return text;
  return `\u001B]8;;${url}\u0007${text}\u001B]8;;\u0007`;
}

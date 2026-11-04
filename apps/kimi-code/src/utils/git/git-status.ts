/**
 * Cached git branch and working-tree status for the footer, read through the
 * engine so a remote-bound session reports the repository on its own host.
 *
 * getStatus() only reads the cache. The first read, refresh(), a HEAD change,
 * and a read past the 30s status TTL schedule a refresh. The read starts on a
 * later turn, not on the caller's stack, and not when the cache is
 * constructed. A local work tree has its HEAD polled every 2 seconds; a remote
 * one refreshes on refresh() and the TTL only. Pull request lookup stays async
 * and never blocks a read.
 */

import { execFile } from 'node:child_process';
import { join } from 'node:path';

import { FSWatcher } from 'chokidar';
import type { GitPullRequest, GitStatusSummary } from '@moonshot-ai/kimi-code-sdk';

import { resolveCommandPath } from '#/utils/process/resolve-command';

const STATUS_TTL_MS = 30_000;
const HEAD_POLL_INTERVAL_MS = 2_000;
const PULL_REQUEST_TTL_MS = 60_000;
const SPAWN_TIMEOUT_MS = 2_000;

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

export interface GitStatusSource {
  status(): Promise<GitStatusSummary | null>;
  pullRequest(): Promise<GitPullRequest | null>;
  /** Local work tree whose HEAD is polled for branch switches; unset for a remote one. */
  readonly localWorkDir?: string;
}

export interface GitStatusCache {
  /** Returns the last status, or `null` when it is not available yet or this is not a git repo. */
  getStatus(): GitStatus | null;
  /** Refresh now, ignoring the status TTL. No-op when a refresh is already running; one follow-up runs after it. */
  refresh(): void;
  dispose(): void;
}

export interface GitStatusCacheOptions {
  readonly onChange?: () => void;
}

interface StatusState {
  summary: GitStatusSummary | null;
  fetchedAt: number;
}

interface PullRequestState {
  value: PullRequestInfo | null;
  branch: string | null;
  fetchedAt: number;
  pendingBranch: string | null;
  requestId: number;
}

export function createGitStatusCache(
  source: GitStatusSource,
  options: GitStatusCacheOptions = {},
): GitStatusCache {
  let disposed = false;
  let inFlight = false;
  let pendingForce = false;
  let refreshQueued = false;
  let queuedForce = false;
  let headWatchRequested = false;
  let headWatcher: FSWatcher | null = null;
  let status: StatusState = { summary: null, fetchedAt: 0 };
  let pullRequest: PullRequestState = {
    value: null,
    branch: null,
    fetchedAt: 0,
    pendingBranch: null,
    requestId: 0,
  };

  const cache: GitStatusCache = {
    getStatus: () => {
      if (disposed) return null;
      const now = Date.now();
      if (now - status.fetchedAt >= STATUS_TTL_MS) {
        requestRefresh(false);
      }
      const branch = currentBranch();
      if (branch !== null) {
        refreshPullRequestIfNeeded(branch, now);
      }
      return currentStatus();
    },
    refresh: () => {
      requestRefresh(true);
    },
    dispose: () => {
      disposed = true;
      inFlight = false;
      pendingForce = false;
      refreshQueued = false;
      queuedForce = false;
      const watcher = headWatcher;
      headWatcher = null;
      if (watcher !== null) {
        void watcher.close().catch(() => undefined);
      }
    },
  };

  return cache;

  function requestRefresh(force: boolean): void {
    if (force) queuedForce = true;
    if (refreshQueued) return;
    refreshQueued = true;
    queueMicrotask(() => {
      refreshQueued = false;
      const runForce = queuedForce;
      queuedForce = false;
      void runRefresh(runForce);
    });
  }

  async function runRefresh(force: boolean): Promise<void> {
    if (disposed) return;
    if (inFlight) {
      if (force) pendingForce = true;
      return;
    }
    if (!force && Date.now() - status.fetchedAt < STATUS_TTL_MS) return;

    inFlight = true;
    try {
      if (!headWatchRequested && source.localWorkDir !== undefined) {
        headWatchRequested = true;
        void watchLocalHead(source.localWorkDir);
      }
      let summary: GitStatusSummary | null;
      try {
        summary = await source.status();
      } catch {
        status = { ...status, fetchedAt: Date.now() };
        return;
      }
      if (disposed) return;
      const changed = !sameSummary(status.summary, summary);
      status = { summary, fetchedAt: Date.now() };
      if (changed) options.onChange?.();
      const branch = currentBranch();
      if (branch !== null) refreshPullRequestIfNeeded(branch, Date.now());
    } finally {
      if (!disposed) {
        inFlight = false;
        if (pendingForce) {
          pendingForce = false;
          void runRefresh(true);
        }
      }
    }
  }

  async function watchLocalHead(workDir: string): Promise<void> {
    const gitDir = await probeGitDir(workDir);
    if (disposed || gitDir === null) return;
    try {
      const watcher = new FSWatcher({
        ignoreInitial: true,
        persistent: false,
        usePolling: true,
        interval: HEAD_POLL_INTERVAL_MS,
        ignorePermissionErrors: true,
      });
      const onHead = (): void => {
        requestRefresh(true);
      };
      watcher.on('add', onHead);
      watcher.on('change', onHead);
      watcher.on('unlink', onHead);
      watcher.on('error', () => undefined);
      watcher.add(join(gitDir, 'HEAD'));
      headWatcher = watcher;
    } catch {
      // Turn end and the status TTL still refresh if watching is unavailable.
    }
  }

  function currentBranch(): string | null {
    const branch = status.summary?.branch;
    return branch === undefined || branch === '' ? null : branch;
  }

  function currentStatus(): GitStatus | null {
    const summary = status.summary;
    const branch = currentBranch();
    if (summary === null || branch === null) return null;
    return {
      branch,
      dirty: summary.dirty,
      ahead: summary.ahead,
      behind: summary.behind,
      diffAdded: summary.additions,
      diffDeleted: summary.deletions,
      pullRequest: pullRequest.branch === branch ? pullRequest.value : null,
    };
  }

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

    void readPullRequest().then((value) => {
      if (disposed || pullRequest.requestId !== requestId) return;

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

  async function readPullRequest(): Promise<PullRequestInfo | null> {
    try {
      const found = await source.pullRequest();
      return found === null ? null : { number: found.number, url: found.url };
    } catch {
      return null;
    }
  }
}

function probeGitDir(workDir: string): Promise<string | null> {
  const git = resolveCommandPath('git', workDir);
  if (git === undefined) return Promise.resolve(null);
  return new Promise((resolve) => {
    try {
      execFile(
        git,
        ['-C', workDir, 'rev-parse', '--absolute-git-dir'],
        { encoding: 'utf8', timeout: SPAWN_TIMEOUT_MS },
        (error, stdout) => {
          const gitDir = typeof stdout === 'string' ? stdout.trim() : '';
          resolve(error === null && gitDir.length > 0 ? gitDir : null);
        },
      );
    } catch {
      resolve(null);
    }
  });
}

function sameSummary(a: GitStatusSummary | null, b: GitStatusSummary | null): boolean {
  if (a === null || b === null) return a === b;
  return (
    a.branch === b.branch &&
    a.dirty === b.dirty &&
    a.ahead === b.ahead &&
    a.behind === b.behind &&
    a.additions === b.additions &&
    a.deletions === b.deletions
  );
}

function samePullRequest(a: PullRequestInfo | null, b: PullRequestInfo | null): boolean {
  if (a === null || b === null) return a === b;
  return a.number === b.number && a.url === b.url;
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

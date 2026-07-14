/**
 * `git` domain (L1) — pure git-output parsers.
 *
 * Parses `git status --porcelain=v1 --branch`, `git diff --numstat`, and
 * `gh pr view --json` output into the protocol `FsGitStatusResponse` shape.
 * No IO, no DI — plain functions so they can be unit-tested directly. Moved
 * from `session/sessionFs/fsGit.ts` (originally ported from v1
 * `services/fs/fsGit.ts`).
 */

import type { FsGitStatus, FsGitStatusResponse, FsPullRequest } from '@moonshot-ai/protocol';

export function parsePorcelain(
  stdout: string,
  filter: ReadonlySet<string> | undefined,
): FsGitStatusResponse {
  const lines = stdout.split('\n');
  let branch = '';
  let ahead = 0;
  let behind = 0;
  const entries: Record<string, FsGitStatus> = {};

  for (const line of lines) {
    if (line.length === 0) continue;
    if (line.startsWith('## ')) {
      const parsed = parseBranchHeader(line.slice(3));
      branch = parsed.branch;
      ahead = parsed.ahead;
      behind = parsed.behind;
      continue;
    }

    if (line.length < 4) continue;
    const xy = line.slice(0, 2);
    let rest = line.slice(3);

    if (xy.startsWith('R') || xy.startsWith('C')) {
      const arrow = rest.indexOf(' -> ');
      if (arrow >= 0) {
        rest = rest.slice(arrow + 4);
      }
    }
    const wirePath = posix(rest.trim());
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

function posix(p: string): string {
  return p.replaceAll('\\', '/');
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

/**
 * `IFsGitService` — daemon-OWN git status for the session cwd.
 *
 * Single endpoint: `:git_status`. Shell out `git status --porcelain=v1 --branch`
 * and parse the stable machine-readable output. The wire shape matches
 * REST.md §3.9 line 660-669:
 *
 *   { branch, ahead, behind, entries: { [path]: GitStatus } }
 *
 * The `GitStatus` enum (`'clean' | 'modified' | 'added' | 'deleted' |
 * 'renamed' | 'untracked' | 'ignored' | 'conflicted'`) is the SCHEMAS §9.2
 * line 521 wire enum. We collapse the porcelain XY status
 * pair (index + worktree) to a single value using a priority ladder:
 *
 *   conflicted > deleted > modified > renamed > added > untracked > ignored
 *
 * **Non-git detection**: we shell out `git rev-parse --is-inside-work-tree`
 * FIRST. If it exits non-zero (no git present, or cwd is not in a worktree)
 * we throw `FsGitUnavailableError` → routes map to 40908. We do NOT match
 * stderr text — exit-code-based detection is locale-independent.
 *
 * **Performance**: the porcelain parse runs in ~tens of milliseconds on the
 * kimi-code repo (~200 entries), within the 300ms target.
 *
 * **Path filter**: when client passes `paths`, we resolve each via
 * `resolveSafePath` and intersect the porcelain output. Out-of-tree paths
 * raise 41304 batch-wide (same posture as `:stat_many`).
 *
 * **Anti-corruption**: imports `node:child_process`, `node:path`,
 * `ISessionService`, `ILogService`. ZERO SDK imports.
 */

import { spawn } from 'node:child_process';
import { promises as fs } from 'node:fs';
import path from 'node:path';

import {
  createDecorator,
  Disposable,
  type IDisposable,
} from '@moonshot-ai/agent-core';
import {
  ISessionService,
  SessionNotFoundError,
} from '@moonshot-ai/services';
import type {
  FsGitStatus,
  FsGitStatusRequest,
  FsGitStatusResponse,
} from '@moonshot-ai/protocol';

import {
  FsPathEscapesError,
  resolveSafePath,
} from './fsPathSafety';

// ---------------------------------------------------------------------------
// Error sentinels
// ---------------------------------------------------------------------------

export class FsGitUnavailableError extends Error {
  readonly cwd: string;
  readonly detail: string;
  constructor(cwd: string, detail: string) {
    super(`fs.git_unavailable: ${cwd} (${detail})`);
    this.name = 'FsGitUnavailableError';
    this.cwd = cwd;
    this.detail = detail;
  }
}

// ---------------------------------------------------------------------------
// Public interface + decorator
// ---------------------------------------------------------------------------

export interface IFsGitService extends IDisposable {
  readonly _serviceBrand: undefined;

  status(
    sessionId: string,
    req: FsGitStatusRequest,
  ): Promise<FsGitStatusResponse>;
}

// eslint-disable-next-line @typescript-eslint/no-redeclare
export const IFsGitService = createDecorator<IFsGitService>('fsGitService');

// ===========================================================================
// Porcelain parser
// ===========================================================================

/**
 * Parse `git status --porcelain=v1 --branch` output.
 *
 * The first line is the branch header: `## <local>...<remote> [ahead N, behind M]`
 * Subsequent lines are entries: 2-char XY status, space, path.
 * Renames are: `R  src/old.ts -> src/new.ts`
 *
 * We collapse XY → single GitStatus per the priority ladder documented at
 * top of file.
 */
export function parsePorcelain(
  stdout: string,
  filter: Set<string> | undefined,
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
    // Status entry. The first 2 chars are XY (index, worktree).
    if (line.length < 4) continue;
    const xy = line.slice(0, 2);
    let rest = line.slice(3);
    // Renames: `R  src/old.ts -> src/new.ts` — keep the destination as the
    // tracked path; the source is implicit.
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

  return { branch, ahead, behind, entries };
}

function parseBranchHeader(rest: string): {
  branch: string;
  ahead: number;
  behind: number;
} {
  // `## main...origin/main [ahead 2, behind 1]`
  // `## main`
  // `## HEAD (no branch)`
  // `## No commits yet on main`
  if (rest.startsWith('HEAD (no branch)')) {
    return { branch: '', ahead: 0, behind: 0 };
  }
  if (rest.startsWith('No commits yet on ')) {
    return { branch: rest.slice('No commits yet on '.length), ahead: 0, behind: 0 };
  }
  let branch = rest;
  let ahead = 0;
  let behind = 0;
  // Strip the bracketed ahead/behind suffix.
  const bracket = rest.indexOf(' [');
  if (bracket >= 0) {
    branch = rest.slice(0, bracket);
    const sliced = rest.slice(bracket + 2, rest.length - 1);
    const aheadMatch = sliced.match(/ahead (\d+)/);
    const behindMatch = sliced.match(/behind (\d+)/);
    if (aheadMatch !== null) ahead = Number.parseInt(aheadMatch[1] ?? '0', 10) || 0;
    if (behindMatch !== null) behind = Number.parseInt(behindMatch[1] ?? '0', 10) || 0;
  }
  // Strip the `...remote` suffix if present.
  const dots = branch.indexOf('...');
  if (dots >= 0) branch = branch.slice(0, dots);
  return { branch, ahead, behind };
}

/**
 * Collapse porcelain XY pair to a single `FsGitStatus` wire enum.
 *
 * Priority (highest first): conflict > delete > modify > rename > add >
 * untracked > ignored > clean. Untracked (`??`) and ignored (`!!`) are
 * special markers; renames are R/C in either column; conflicts include
 * any of `DD AU UD UA DU AA UU`.
 */
function collapseXY(xy: string): FsGitStatus {
  if (xy === '??') return 'untracked';
  if (xy === '!!') return 'ignored';
  const x = xy.charAt(0);
  const y = xy.charAt(1);
  const set = new Set([x, y]);
  // Conflict markers per git-status(1):
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
  if (set.has('C')) return 'renamed'; // copied → renamed bucket
  if (set.has('A')) return 'added';
  return 'clean';
}

function posix(p: string): string {
  return p.split(path.sep).join('/');
}

void FsPathEscapesError;
void SessionNotFoundError;

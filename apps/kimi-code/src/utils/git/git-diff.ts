/**
 * Git diff helpers for the `/diff` slash command.
 *
 * - `isInsideGitRepo` detects whether a directory is inside a git work tree.
 * - `listChangedFiles` returns the current working-tree changes from
 *   `git status --porcelain`.
 * - `runGitDiffForFile` produces a unified diff for a single changed file,
 *   including untracked files (via `git diff --no-index`).
 */

import { execFile, spawnSync } from 'node:child_process';

const GIT_TIMEOUT_MS = 10_000;

const SHELL_METACHAR_RE = /[;|&<>$`\\"\n\r]/;

export class GitDiffError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'GitDiffError';
  }
}

export type GitFileStatus =
  | 'modified'
  | 'added'
  | 'deleted'
  | 'renamed'
  | 'copied'
  | 'untracked'
  | 'ignored'
  | 'unknown';

export interface GitChangedFile {
  readonly path: string;
  readonly status: GitFileStatus;
}

export function isInsideGitRepo(workDir: string): boolean {
  try {
    const result = spawnSync('git', ['-C', workDir, 'rev-parse', '--is-inside-work-tree'], {
      encoding: 'utf8',
      timeout: 1_000,
    });
    return result.status === 0 && result.stdout.trim() === 'true';
  } catch {
    return false;
  }
}

function assertSafeArg(part: string): void {
  if (SHELL_METACHAR_RE.test(part)) {
    throw new GitDiffError(`Invalid git argument: ${part}`);
  }
}

export async function listChangedFiles(workDir: string): Promise<readonly GitChangedFile[]> {
  const prefix = await getGitPrefix(workDir);
  return new Promise((resolve, reject) => {
    execFile(
      'git',
      ['-C', workDir, 'status', '--porcelain', '-z', '--no-renames', '-uall'],
      {
        encoding: 'utf8',
        timeout: GIT_TIMEOUT_MS,
        maxBuffer: 8 * 1024 * 1024,
      },
      (error, stdout) => {
        if (error !== null) {
          reject(new GitDiffError(`git status failed: ${error.message}`));
          return;
        }
        resolve(parsePorcelainZ(stdout, prefix));
      },
    );
  });
}

function getGitPrefix(workDir: string): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      'git',
      ['-C', workDir, 'rev-parse', '--show-prefix'],
      {
        encoding: 'utf8',
        timeout: GIT_TIMEOUT_MS,
      },
      (error, stdout) => {
        if (error !== null) {
          reject(new GitDiffError(`git rev-parse failed: ${error.message}`));
          return;
        }
        resolve(stdout.trimEnd());
      },
    );
  });
}

function parsePorcelainZ(stdout: string, prefix: string): readonly GitChangedFile[] {
  if (stdout.length === 0) return [];

  const entries: GitChangedFile[] = [];
  const parts = stdout.split('\0');
  let i = 0;
  while (i < parts.length) {
    const entry = parts[i];
    i++;
    if (entry === undefined || entry.length < 3) continue;

    const indexStatus = entry[0]!;
    const worktreeStatus = entry[1]!;
    let path = entry.slice(3);
    if (path.length === 0) continue;

    if (prefix.length > 0) {
      if (!path.startsWith(prefix)) continue;
      path = path.slice(prefix.length);
      if (path.length === 0) continue;
    }

    const status = classifyStatus(indexStatus, worktreeStatus);
    entries.push({ path, status });
  }
  return entries;
}

function classifyStatus(indexStatus: string, worktreeStatus: string): GitFileStatus {
  const status = indexStatus !== ' ' ? indexStatus : worktreeStatus;
  switch (status) {
    case 'M':
      return 'modified';
    case 'A':
      return 'added';
    case 'D':
      return 'deleted';
    case 'R':
      return 'renamed';
    case 'C':
      return 'copied';
    case '?':
      return 'untracked';
    case '!':
      return 'ignored';
    default:
      return 'unknown';
  }
}

export async function runGitDiffForFile(
  workDir: string,
  file: GitChangedFile,
  contextLines: number = 3,
): Promise<string> {
  assertSafeArg(file.path);

  const unifiedArg = `-U${String(contextLines)}`;

  if (file.status === 'untracked') {
    return runUntrackedDiff(workDir, file.path, unifiedArg);
  }

  return runGit(workDir, ['diff', 'HEAD', unifiedArg, '--', file.path]);
}

function isWorkdirMissingError(error: Error): boolean {
  return error.message.includes('cannot change to') || error.message.includes('No such file or directory');
}

function isEmptyRepoError(error: Error): boolean {
  // 'HEAD' is a git ref name and appears in the error regardless of locale
  // (e.g. English "ambiguous argument 'HEAD'" or Chinese "歧义参数 'HEAD'").
  return error.message.includes("'HEAD'");
}

function runUntrackedDiff(workDir: string, path: string, unifiedArg: string): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      'git',
      ['-C', workDir, 'diff', '--no-index', unifiedArg, '--', '/dev/null', path],
      {
        encoding: 'utf8',
        timeout: GIT_TIMEOUT_MS,
        maxBuffer: 8 * 1024 * 1024,
      },
      (error, stdout, stderr) => {
        // `git diff --no-index` exits with code 1 when files differ, which is expected.
        if (error !== null && (error as { code?: unknown }).code !== 1) {
          // If the workDir was removed between starting the diff and the callback
          // (e.g. during test teardown), treat it as an empty diff rather than an
          // unhandled rejection.
          if (isWorkdirMissingError(error) || isEmptyRepoError(error)) {
            resolve('');
            return;
          }
          reject(new GitDiffError(`git diff failed: ${stderr.trim() || error.message}`));
          return;
        }
        resolve(stdout);
      },
    );
  });
}

function runGit(workDir: string, args: readonly string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      'git',
      ['-C', workDir, ...args],
      {
        encoding: 'utf8',
        timeout: GIT_TIMEOUT_MS,
        maxBuffer: 8 * 1024 * 1024,
      },
      (error, stdout, stderr) => {
        if (error !== null) {
          if (isWorkdirMissingError(error) || isEmptyRepoError(error)) {
            resolve('');
            return;
          }
          reject(new GitDiffError(`git diff failed: ${stderr.trim() || error.message}`));
          return;
        }
        resolve(stdout);
      },
    );
  });
}

export async function runGitNumstat(
  workDir: string,
): Promise<ReadonlyMap<string, { additions: number; deletions: number }>> {
  const prefix = await getGitPrefix(workDir);
  return new Promise((resolve, reject) => {
    execFile(
      'git',
      ['-C', workDir, 'diff', 'HEAD', '--no-renames', '--numstat'],
      {
        encoding: 'utf8',
        timeout: GIT_TIMEOUT_MS,
        maxBuffer: 8 * 1024 * 1024,
      },
      (error, stdout) => {
        if (error !== null) {
          if (isWorkdirMissingError(error) || isEmptyRepoError(error)) {
            resolve(new Map());
            return;
          }
          reject(new GitDiffError(`git diff --numstat failed: ${error.message}`));
          return;
        }
        resolve(parseNumstat(stdout, prefix));
      },
    );
  });
}

export async function runUntrackedNumstat(
  workDir: string,
  path: string,
): Promise<{ additions: number; deletions: number }> {
  assertSafeArg(path);
  return new Promise((resolve, reject) => {
    execFile(
      'git',
      ['-C', workDir, 'diff', '--no-index', '--numstat', '--', '/dev/null', path],
      {
        encoding: 'utf8',
        timeout: GIT_TIMEOUT_MS,
        maxBuffer: 8 * 1024 * 1024,
      },
      (error, stdout, stderr) => {
        if (error !== null && (error as { code?: unknown }).code !== 1) {
          if (isWorkdirMissingError(error)) {
            resolve({ additions: 0, deletions: 0 });
            return;
          }
          reject(
            new GitDiffError(
              `git diff --no-index --numstat failed: ${stderr.trim() || error.message}`,
            ),
          );
          return;
        }
        const stats = parseNumstat(stdout);
        const stat = stats.get(path) ?? stats.get(`/dev/null => ${path}`);
        resolve(stat ?? { additions: 0, deletions: 0 });
      },
    );
  });
}

function parseNumstat(
  stdout: string,
  workTreePrefix: string = '',
): Map<string, { additions: number; deletions: number }> {
  const normalizedPrefix =
    workTreePrefix.length > 0 && !workTreePrefix.endsWith('/') ? `${workTreePrefix}/` : workTreePrefix;
  const stats = new Map<string, { additions: number; deletions: number }>();
  for (const line of stdout.split('\n')) {
    if (line.length === 0) continue;
    const parts = line.split('\t');
    if (parts.length < 3) continue;
    const additions = parts[0] === '-' ? 0 : Number(parts[0]);
    const deletions = parts[1] === '-' ? 0 : Number(parts[1]);
    const rawPath = parts[2]!;
    const path =
      normalizedPrefix.length > 0 && rawPath.startsWith(normalizedPrefix)
        ? rawPath.slice(normalizedPrefix.length)
        : rawPath;
    if (!Number.isNaN(additions) && !Number.isNaN(deletions)) {
      stats.set(path, { additions, deletions });
    }
  }
  return stats;
}

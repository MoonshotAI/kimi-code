import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { lstat, readdir } from 'node:fs/promises';
import { join, relative, resolve } from 'node:path';
import { promisify } from 'node:util';

import {
  DEFAULT_MAX_ARCHIVE_SIZE,
  DEFAULT_MAX_FILES,
  DEFAULT_MAX_FILE_SIZE,
  isIgnoredDirName,
  isSensitivePath,
} from './filter';
import type {
  FeedbackCodebaseFile,
  FeedbackCodebaseLimitExceeded,
  FeedbackCodebaseScanResult,
} from './types';

const execFileAsync = promisify(execFile);

export interface ScanCodebaseLimits {
  readonly maxFiles: number;
  readonly maxFileSize: number;
  readonly maxArchiveSize: number;
}

export interface ScanCodebaseOptions {
  readonly limits?: {
    readonly maxFiles?: number;
    readonly maxFileSize?: number;
    readonly maxArchiveSize?: number;
  };
  readonly signal?: AbortSignal;
}

interface CollectedFiles {
  readonly files: FeedbackCodebaseFile[];
  readonly exceedsLimit?: FeedbackCodebaseLimitExceeded;
}

export async function scanCodebase(
  rootInput: string,
  options: ScanCodebaseOptions = {},
): Promise<FeedbackCodebaseScanResult> {
  const root = resolve(rootInput);
  const limits = resolveLimits(options.limits);
  throwIfAborted(options.signal);
  const usedGitIgnore = await isInsideGitWorkTree(root);
  const collected = usedGitIgnore
    ? await scanWithGit(root, limits, options.signal)
    : await scanWithoutFilter(root, limits, options.signal);
  const sortedFiles = collected.files.toSorted((a, b) => a.path.localeCompare(b.path));

  return {
    root,
    files: sortedFiles,
    fingerprint: fingerprintFiles(sortedFiles),
    usedGitIgnore,
    exceedsLimit: collected.exceedsLimit,
  };
}

function resolveLimits(limits: ScanCodebaseOptions['limits']): ScanCodebaseLimits {
  return {
    maxFiles: limits?.maxFiles ?? DEFAULT_MAX_FILES,
    maxFileSize: limits?.maxFileSize ?? DEFAULT_MAX_FILE_SIZE,
    maxArchiveSize: limits?.maxArchiveSize ?? DEFAULT_MAX_ARCHIVE_SIZE,
  };
}

async function isInsideGitWorkTree(root: string): Promise<boolean> {
  try {
    const { stdout } = await execFileAsync('git', ['-C', root, 'rev-parse', '--is-inside-work-tree']);
    return stdout.trim() === 'true';
  } catch {
    return false;
  }
}

async function scanWithGit(
  root: string,
  limits: ScanCodebaseLimits,
  signal?: AbortSignal,
): Promise<CollectedFiles> {
  const { stdout } = await execFileAsync(
    'git',
    ['-C', root, 'ls-files', '-co', '--exclude-standard', '-z'],
    { encoding: 'buffer', maxBuffer: 1024 * 1024 * 64, signal },
  );

  throwIfAborted(signal);
  const relativePaths = splitNull(stdout);
  const files: FeedbackCodebaseFile[] = [];
  let exceedsLimit: FeedbackCodebaseLimitExceeded | undefined;
  let totalSize = 0;

  for (const relativePath of relativePaths) {
    throwIfAborted(signal);
    if (files.length >= limits.maxFiles) {
      exceedsLimit = { reason: 'file-count', limit: limits.maxFiles };
      break;
    }
    if (isSensitivePath(relativePath)) continue;
    const file = await statFile(root, relativePath);
    if (file) {
      if (file.size > limits.maxFileSize) continue;
      if (totalSize + file.size > limits.maxArchiveSize) {
        exceedsLimit = { reason: 'total-size', limit: limits.maxArchiveSize };
        break;
      }
      files.push(file);
      totalSize += file.size;
    }
  }

  return { files, exceedsLimit };
}

async function scanWithoutFilter(
  root: string,
  limits: ScanCodebaseLimits,
  signal?: AbortSignal,
): Promise<CollectedFiles> {
  const files: FeedbackCodebaseFile[] = [];
  let exceedsLimit: FeedbackCodebaseLimitExceeded | undefined;
  let stopped = false;
  let totalSize = 0;

  async function walk(dir: string): Promise<void> {
    if (stopped) return;
    throwIfAborted(signal);
    const entries = await readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      if (stopped) return;
      throwIfAborted(signal);
      if (files.length >= limits.maxFiles) {
        exceedsLimit = { reason: 'file-count', limit: limits.maxFiles };
        stopped = true;
        return;
      }
      if (entry.isSymbolicLink()) continue;
      const absolutePath = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (isIgnoredDirName(entry.name)) continue;
        await walk(absolutePath);
        if (stopped) return;
        continue;
      }
      if (!entry.isFile()) continue;
      const relativePath = toPosixPath(relative(root, absolutePath));
      if (isSensitivePath(relativePath)) continue;
      const file = await statFile(root, relativePath);
      if (file) {
        if (file.size > limits.maxFileSize) continue;
        if (totalSize + file.size > limits.maxArchiveSize) {
          exceedsLimit = { reason: 'total-size', limit: limits.maxArchiveSize };
          stopped = true;
          return;
        }
        files.push(file);
        totalSize += file.size;
      }
    }
  }

  await walk(root);
  return { files, exceedsLimit };
}

async function statFile(root: string, relativePath: string): Promise<FeedbackCodebaseFile | null> {
  const absolutePath = resolve(root, relativePath);
  // A tracked file can be deleted from the working tree but still listed by
  // `git ls-files`; lstat then throws ENOENT. Treat unreadable/vanished paths
  // like any other non-regular entry so one bad path does not abort the scan.
  const stat = await lstat(absolutePath).catch(() => null);
  if (stat === null || stat.isSymbolicLink() || !stat.isFile()) return null;

  return {
    path: toPosixPath(relativePath),
    absolutePath,
    size: stat.size,
    mtimeMs: stat.mtimeMs,
  };
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) {
    const error = new Error('Codebase scan aborted.');
    error.name = 'AbortError';
    throw error;
  }
}

function fingerprintFiles(files: readonly FeedbackCodebaseFile[]): string {
  const hash = createHash('sha256');
  for (const file of files) {
    hash.update(file.path);
    hash.update('\0');
    hash.update(String(file.size));
    hash.update('\0');
    hash.update(String(Math.trunc(file.mtimeMs)));
    hash.update('\n');
  }
  return hash.digest('hex');
}

function splitNull(buffer: Buffer): string[] {
  return buffer
    .toString('utf8')
    .split('\0')
    .filter((item) => item.length > 0);
}

function toPosixPath(value: string): string {
  return value.split('\\').join('/');
}

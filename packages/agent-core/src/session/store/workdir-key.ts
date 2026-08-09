import { createHash } from 'node:crypto';
import { win32 } from 'node:path';
import { basename, resolve } from 'pathe';

import { slugifyWorkDirName } from '#/utils/workdir-slug';

const WORKDIR_KEY_PREFIX = 'wd_';
const HASH_LENGTH = 12;

export function normalizeWorkDir(workDir: string): string {
  if (isWindowsAbsolutePath(workDir)) {
    return win32.resolve(workDir).replaceAll('\\', '/');
  }
  return resolve(workDir);
}

export function encodeWorkDirKey(workDir: string): string {
  const normalized = normalizeWorkDir(workDir);
  const slug = slugifyWorkDirName(basename(normalized));
  const hash = createHash('sha256').update(normalized).digest('hex').slice(0, HASH_LENGTH);
  return `${WORKDIR_KEY_PREFIX}${slug}_${hash}`;
}

function isWindowsAbsolutePath(value: string): boolean {
  return /^[A-Za-z]:[\\/]/.test(value) || /^[\\/]{2}[^\\/]+[\\/][^\\/]+/.test(value);
}

// Windows-shaped: drive-letter (C:\, C:/) or UNC (\\host\share, //host/share).
// Shape-based detection (not process.platform): consistent folding in tests
// on any host OS. Looser than isWindowsAbsolutePath above (any leading `\\`
// or `//` counts): for case-folding, an over-broad UNC match only folds case
// on paths that already require shape detection, never on POSIX paths.
const WIN_SHAPED = /^(?:[A-Za-z]:[\\/]|\\\\|\/\/)/;

/**
 * Identity key for "same workspace directory?" comparisons: slash-normalize,
 * strip trailing separators, case-fold Windows-shaped paths (NTFS lookups are
 * case-insensitive by default). Pure string ops — deliberately NOT
 * normalizeWorkDir/pathe.resolve, which join the process cwd into
 * Windows-shaped strings on POSIX hosts. Comparison only; stored/displayed
 * paths are never rewritten. Per-directory case sensitivity (fsutil) / WSL
 * paths are a documented non-goal; POSIX paths never fold.
 */
export function workspaceRootKey(root: string): string {
  const slashed = root.replaceAll('\\', '/');
  // Test the shape BEFORE stripping trailing separators: a drive root
  // (`C:\`) loses its only separator to the strip (`C:`) and would no
  // longer read as Windows-shaped, escaping the case-fold.
  const shaped = WIN_SHAPED.test(slashed);
  const normalized = slashed.replace(/\/+$/, '');
  return shaped ? normalized.toLowerCase() : normalized;
}

/**
 * Working-directory identity helpers.
 *
 * `slugifyWorkDirName` turns a directory name into a safe, bounded token;
 * `encodeWorkDirKey` derives the stable, opaque `workspaceId` for a working
 * directory (`wd_<slug>_<hash>`). The `workspaceId` is the backend-neutral
 * identity used to group sessions and to key the workspace registry; backends
 * never expose the raw working-directory path. `workspaceRootKey` is the
 * comparison-only companion: it answers "is this the same directory?" without
 * changing the id that was already minted for it.
 */

import { createHash } from 'node:crypto';

const MAX_WORKDIR_SLUG_LENGTH = 40;
const WORKDIR_KEY_PREFIX = 'wd_';
const HASH_LENGTH = 12;

export function slugifyWorkDirName(name: string): string {
  const slug = name
    .toLowerCase()
    .replaceAll(/[^a-z0-9._-]+/g, '-')
    .replaceAll(/^-+|-+$/g, '')
    .slice(0, MAX_WORKDIR_SLUG_LENGTH)
    .replaceAll(/^-+|-+$/g, '');
  return slug === '' || slug === '.' || slug === '..' ? 'workspace' : slug;
}

export function encodeWorkDirKey(workDir: string): string {
  const normalized = workDir.replace(/\\/g, '/').replace(/\/+$/, '');
  const base = normalized.split('/').pop() ?? normalized;
  const slug = slugifyWorkDirName(base);
  const hash = createHash('sha256').update(normalized).digest('hex').slice(0, HASH_LENGTH);
  return `${WORKDIR_KEY_PREFIX}${slug}_${hash}`;
}

// Windows-shaped: drive-letter (C:\, C:/) or UNC (\\host\share, //host/share).
// Shape-based detection (not process.platform): browser/remote daemons and
// tests must fold the same way regardless of host OS.
const WIN_SHAPED = /^(?:[A-Za-z]:[\\/]|\\\\|\/\/)/;

/**
 * Platform-aware identity key for "is this the same workspace directory?"
 * comparisons. Slash-normalizes, strips trailing separators, and case-folds
 * Windows-shaped paths (NTFS lookups are case-insensitive by default), so the
 * drive-letter casing the process happened to inherit and typed-vs-realpath
 * spelling variants collapse onto one key; POSIX paths never fold.
 *
 * Comparison-only: the minted `workspaceId` (`encodeWorkDirKey`) stays
 * case-sensitive so already-persisted session buckets keep resolving. Pure
 * string ops on purpose — a path library (`pathe.resolve`/`normalize`) would
 * treat a Windows-shaped string as relative on a POSIX host and join the
 * process cwd. Per-directory case sensitivity (`fsutil`) and WSL mount
 * translations are a documented non-goal.
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

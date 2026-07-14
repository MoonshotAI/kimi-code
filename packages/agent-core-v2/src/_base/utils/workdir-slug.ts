/**
 * Working-directory identity helpers.
 *
 * `slugifyWorkDirName` turns a directory name into a safe, bounded token;
 * `encodeWorkDirKey` derives the stable, opaque `workspaceId` for a working
 * directory (`wd_<slug>_<hash>`). The `workspaceId` is the backend-neutral
 * identity used to group sessions and to key the workspace registry; backends
 * never expose the raw working-directory path.
 */

import { createHash } from 'node:crypto';

import { resolve } from 'pathe';

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

export function normalizeWorkDir(workDir: string): string {
  return resolve(workDir);
}

export function encodeWorkDirKey(workDir: string): string {
  const normalized = normalizeWorkDir(workDir);
  const base = normalized.split('/').pop() ?? normalized;
  const slug = slugifyWorkDirName(base);
  const hash = createHash('sha256').update(normalized).digest('hex').slice(0, HASH_LENGTH);
  return `${WORKDIR_KEY_PREFIX}${slug}_${hash}`;
}

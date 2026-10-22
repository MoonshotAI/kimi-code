import { resolve, win32 } from 'pathe';

import { sha256Hex } from '#/sha256';

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
  const normalized = workDir.replaceAll('\\', '/').replace(/\/+$/, '');
  const base = normalized.split('/').pop() ?? normalized;
  const slug = slugifyWorkDirName(base);
  const hash = sha256Hex(normalized).slice(0, HASH_LENGTH);
  return `${WORKDIR_KEY_PREFIX}${slug}_${hash}`;
}

const WIN_SHAPED = /^(?:[A-Za-z]:[\\/]|\\\\|\/\/)/;

export function workspaceRootKey(root: string): string {
  const slashed = root.replaceAll('\\', '/');
  const shaped = WIN_SHAPED.test(slashed);
  const normalized = slashed.replace(/\/+$/, '');
  return shaped ? normalized.toLowerCase() : normalized;
}

export function isWindowsAbsolutePath(value: string): boolean {
  return /^[A-Za-z]:[\\/]/.test(value) || /^[\\/]{2}[^\\/]+[\\/][^\\/]+/.test(value);
}

export function canonicalWorkspaceRoot(cwd: string): string {
  const resolved = isWindowsAbsolutePath(cwd)
    ? win32.resolve(cwd).replaceAll('\\', '/')
    : resolve(cwd);
  return workspaceRootKey(resolved) || resolved;
}

export function workspaceTrustKey(root: string): string {
  return encodeWorkDirKey(canonicalWorkspaceRoot(root));
}

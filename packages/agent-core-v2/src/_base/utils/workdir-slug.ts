import { createHash } from 'node:crypto';

import { isAbsolute, normalize } from 'pathe';

const MAX_WORKDIR_SLUG_LENGTH = 40;
const WORKDIR_KEY_PREFIX = 'wd_';
const HASH_LENGTH = 12;

declare const implicitProjectIdBrand: unique symbol;

export type ImplicitProjectId = string & { readonly [implicitProjectIdBrand]: true };

declare const absoluteDirBrand: unique symbol;

export type AbsoluteDir = string & { readonly [absoluteDirBrand]: true };

export function slugifyWorkDirName(name: string): string {
  const slug = name
    .toLowerCase()
    .replaceAll(/[^a-z0-9._-]+/g, '-')
    .replaceAll(/^-+|-+$/g, '')
    .slice(0, MAX_WORKDIR_SLUG_LENGTH)
    .replaceAll(/^-+|-+$/g, '');
  return slug === '' || slug === '.' || slug === '..' ? 'workspace' : slug;
}

export function encodeWorkDirKey(workDir: string): ImplicitProjectId {
  const normalized = workDir.replaceAll('\\', '/').replace(/\/+$/, '');
  const base = normalized.split('/').pop() ?? normalized;
  const slug = slugifyWorkDirName(base);
  const hash = createHash('sha256').update(normalized).digest('hex').slice(0, HASH_LENGTH);
  return `${WORKDIR_KEY_PREFIX}${slug}_${hash}` as ImplicitProjectId;
}

const WIN_SHAPED = /^(?:[A-Za-z]:[\\/]|\\\\|\/\/)/;

export function workspaceRootKey(root: string): string {
  const slashed = root.replaceAll('\\', '/');
  const shaped = WIN_SHAPED.test(slashed);
  const normalized = slashed.replace(/\/+$/, '');
  return shaped ? normalized.toLowerCase() : normalized;
}

export function isWorkDirKey(id: string): id is ImplicitProjectId {
  return id.startsWith(WORKDIR_KEY_PREFIX);
}

export function toAbsoluteDir(path: string): AbsoluteDir | undefined {
  if (path.length === 0 || !isAbsolute(path)) return undefined;
  const normalized = normalize(path);
  const trimmed = normalized.replace(/(?<=[^/:])\/+$/, '');
  return trimmed as AbsoluteDir;
}

export function sameDir(a: string, b: string): boolean {
  return dirKey(a) === dirKey(b);
}

export function isAncestorOrSelf(ancestor: string, path: string): boolean {
  const ancestorKey = dirKey(ancestor);
  const pathKey = dirKey(path);
  return pathKey === ancestorKey || pathKey.startsWith(`${ancestorKey}/`);
}

function dirKey(path: string): string {
  return workspaceRootKey(normalize(path));
}

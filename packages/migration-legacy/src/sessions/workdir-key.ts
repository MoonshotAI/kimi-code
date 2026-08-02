/**
 * Local copies of the workdir-key helpers from the retired TS engine package
 * `@moonshot-ai/agent-core` (v1) — `packages/agent-core/src/session/store/
 * workdir-key.ts`, plus its helpers `slugifyWorkDirName`
 * (`utils/workdir-slug.ts`) and `isWindowsAbsolutePath` (`utils/guards.ts`).
 *
 * The session picker locates sessions purely by `readdir(encodeWorkDirKey(workDir))`,
 * so the migrator's bucket names MUST stay byte-identical to what the running
 * app writes. The v1 engine is frozen, so a verbatim copy stays in sync by
 * definition.
 */

import { createHash } from 'node:crypto';
import { win32 } from 'node:path';
import { basename, resolve } from 'pathe';

const WORKDIR_KEY_PREFIX = 'wd_';
const HASH_LENGTH = 12;

const MAX_WORKDIR_SLUG_LENGTH = 40;

/** Copied from agent-core `utils/workdir-slug.ts`. */
function slugifyWorkDirName(name: string): string {
  const slug = name
    .toLowerCase()
    .replaceAll(/[^a-z0-9._-]+/g, '-')
    .replaceAll(/^-+|-+$/g, '')
    .slice(0, MAX_WORKDIR_SLUG_LENGTH)
    .replaceAll(/^-+|-+$/g, '');
  return slug === '' || slug === '.' || slug === '..' ? 'workspace' : slug;
}

/** Copied from agent-core `utils/guards.ts`. */
function isWindowsAbsolutePath(value: string): boolean {
  return /^[A-Za-z]:[\\/]/.test(value) || /^[\\/]{2}[^\\/]+[\\/][^\\/]+/.test(value);
}

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

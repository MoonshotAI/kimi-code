import { isAbsolute, relative, resolve } from 'node:path';

import { ErrorCodes, Error2 } from '#/errors';

import type { PathAccessOperation } from './workspaceContext';

export function resolveWorkspacePath(workDir: string, rel: string): string {
  return isAbsolute(rel) ? resolve(rel) : resolve(workDir, rel);
}

export function isWithinWorkspace(
  workDir: string,
  additionalDirs: readonly string[],
  absPath: string,
): boolean {
  const target = resolve(absPath);
  if (target === workDir) return true;
  const rel = relative(workDir, target);
  if (rel !== '' && !rel.startsWith('..') && !isAbsolute(rel)) return true;
  return additionalDirs.some((dir) => {
    const r = relative(dir, target);
    return r === '' || (!r.startsWith('..') && !isAbsolute(r));
  });
}

export function assertWorkspaceAllowed(
  workDir: string,
  additionalDirs: readonly string[],
  absPath: string,
  op: PathAccessOperation,
): string {
  const target = resolveWorkspacePath(workDir, absPath);
  if (!isWithinWorkspace(workDir, additionalDirs, target)) {
    throw new Error2(ErrorCodes.FS_PATH_ESCAPES, `Path outside workspace (${op}): ${target}`, {
      details: { op, path: target },
    });
  }
  return target;
}

import { isAbsolute, relative, resolve } from 'node:path';

import { ErrorCodes, Error2 } from '#/errors';
import type { EnvironmentPath } from '#/environment/environment';

import type { PathAccessOperation } from './workspaceContext';

export type WorkspacePathSemantics = Pick<EnvironmentPath, 'isAbsolute' | 'relative' | 'resolve'>;

export const hostWorkspacePathSemantics: WorkspacePathSemantics = { isAbsolute, relative, resolve };

export function resolveWorkspacePath(
  path: WorkspacePathSemantics,
  workDir: string,
  rel: string,
): string {
  return path.isAbsolute(rel) ? path.resolve(rel) : path.resolve(workDir, rel);
}

export function isWithinWorkspace(
  path: WorkspacePathSemantics,
  workDir: string,
  additionalDirs: readonly string[],
  absPath: string,
): boolean {
  const target = path.resolve(absPath);
  if (target === workDir) return true;
  const rel = path.relative(workDir, target);
  if (rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel)) return true;
  return additionalDirs.some((dir) => {
    const r = path.relative(dir, target);
    return r === '' || (!r.startsWith('..') && !path.isAbsolute(r));
  });
}

export function assertWorkspaceAllowed(
  path: WorkspacePathSemantics,
  workDir: string,
  additionalDirs: readonly string[],
  absPath: string,
  op: PathAccessOperation,
): string {
  const target = resolveWorkspacePath(path, workDir, absPath);
  if (!isWithinWorkspace(path, workDir, additionalDirs, target)) {
    throw new Error2(ErrorCodes.FS_PATH_ESCAPES, `Path outside workspace (${op}): ${target}`, {
      details: { op, path: target },
    });
  }
  return target;
}

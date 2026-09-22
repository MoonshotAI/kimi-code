import * as pathe from 'pathe';

import { isError2, unwrapErrorCause } from '#/_base/errors/errors';
import { OsFsErrors } from '#/os/interface/hostFsErrors';
import type { IHostFileSystem } from '#/os/interface/hostFileSystem';
import {
  isProjectLocalConfigPath,
  isSensitiveFile,
  isWithinDirectory,
  isWithinWorkspace,
  PathSecurityError,
  type PathClass,
  type WorkspaceConfig,
} from '#/tool/path-access';

function errnoCode(error: unknown): string | undefined {
  const unwrapped = unwrapErrorCause(error);
  if (typeof unwrapped === 'object' && unwrapped !== null && 'code' in unwrapped) {
    const code = (unwrapped as { code: unknown }).code;
    return typeof code === 'string' ? code : undefined;
  }
  return undefined;
}

function isMissingPathError(error: unknown): boolean {
  if (isError2(error)) {
    return (
      error.code === OsFsErrors.codes.OS_FS_NOT_FOUND ||
      error.code === OsFsErrors.codes.OS_FS_NOT_DIRECTORY
    );
  }
  const code = errnoCode(error);
  return code === 'ENOENT' || code === 'ENOTDIR';
}

async function realpathExistingPrefix(fs: IHostFileSystem, absPath: string): Promise<string> {
  const tail: string[] = [];
  let current = absPath;
  for (let i = 0; i < 256; i++) {
    try {
      const real = await fs.realpath(current);
      return tail.length === 0 ? real : pathe.join(real, ...tail.toReversed());
    } catch (error) {
      if (!isMissingPathError(error)) throw error;
      const exists = await fs
        .lstat(current)
        .then(
          () => true,
          (lstatError) => {
            if (isMissingPathError(lstatError)) return false;
            throw lstatError;
          },
        );
      if (exists) {
        throw new PathSecurityError(
          'PATH_SYMLINK_ESCAPE',
          absPath,
          current,
          `"${current}" is a symbolic link whose target does not exist. Access is blocked.`,
        );
      }
      const parent = pathe.dirname(current);
      if (parent === current) return absPath;
      tail.push(pathe.basename(current));
      current = parent;
    }
  }
  throw new PathSecurityError(
    'PATH_SYMLINK_ESCAPE',
    absPath,
    absPath,
    `"${absPath}" is too deep to resolve to a real path. Access is blocked.`,
  );
}

async function realRoots(
  fs: IHostFileSystem,
  workspace: WorkspaceConfig,
): Promise<readonly string[]> {
  const roots: string[] = [];
  for (const dir of [workspace.workspaceDir, ...workspace.additionalDirs]) {
    try {
      roots.push(await fs.realpath(dir));
    } catch {
      roots.push(dir);
    }
  }
  return roots;
}

export interface RealPathAccessOptions {
  readonly checkSensitive?: boolean;
}

export async function assertRealPathWithinWorkspace(
  fs: IHostFileSystem,
  absPath: string,
  workspace: WorkspaceConfig,
  pathClass: PathClass,
  options?: RealPathAccessOptions,
): Promise<string> {
  if (!isWithinWorkspace(absPath, workspace, pathClass)) {
    const resolved = await realpathExistingPrefix(fs, absPath);
    if (options?.checkSensitive !== false && isSensitiveFile(resolved)) {
      throw new PathSecurityError(
        'PATH_SENSITIVE',
        absPath,
        resolved,
        `"${absPath}" resolves to "${resolved}" through a symbolic link, which matches a sensitive-file pattern (env / credential / SSH key). ` +
          'Access is blocked to protect secrets.',
      );
    }
    return absPath;
  }
  const resolved = await realpathExistingPrefix(fs, absPath);
  if (options?.checkSensitive !== false && isSensitiveFile(resolved)) {
    throw new PathSecurityError(
      'PATH_SENSITIVE',
      absPath,
      resolved,
      `"${absPath}" resolves to "${resolved}" through a symbolic link, which matches a sensitive-file pattern (env / credential / SSH key). ` +
        'Access is blocked to protect secrets.',
    );
  }
  const roots = await realRoots(fs, workspace);
  if (roots.some((root) => isWithinDirectory(resolved, root, pathClass))) return resolved;
  throw new PathSecurityError(
    'PATH_SYMLINK_ESCAPE',
    absPath,
    resolved,
    `"${absPath}" resolves to "${resolved}" through a symbolic link that points outside the working directory. ` +
      'Access is blocked; use the real path directly or add the target directory to the workspace.',
  );
}

export async function assertRealPathWriteTarget(
  fs: IHostFileSystem,
  absPath: string,
  workspace: WorkspaceConfig,
  pathClass: PathClass,
): Promise<void> {
  const resolved = await assertRealPathWithinWorkspace(fs, absPath, workspace, pathClass);
  if (!isProjectLocalConfigPath(absPath) && isProjectLocalConfigPath(resolved)) {
    throw new PathSecurityError(
      'PATH_SYMLINK_ESCAPE',
      absPath,
      resolved,
      `"${absPath}" resolves to the project-local config "${resolved}" through a symbolic link. ` +
        'Access is blocked; use the real path so the write goes through approval.',
    );
  }
}

export async function checkRealPathWithinWorkspace(
  fs: IHostFileSystem,
  absPath: string,
  workspace: WorkspaceConfig,
  pathClass: PathClass,
  options?: RealPathAccessOptions,
): Promise<PathSecurityError | undefined> {
  try {
    await assertRealPathWithinWorkspace(fs, absPath, workspace, pathClass, options);
    return undefined;
  } catch (error) {
    if (error instanceof PathSecurityError) return error;
    throw error;
  }
}

export async function checkRealPathWriteTarget(
  fs: IHostFileSystem,
  absPath: string,
  workspace: WorkspaceConfig,
  pathClass: PathClass,
): Promise<PathSecurityError | undefined> {
  try {
    await assertRealPathWriteTarget(fs, absPath, workspace, pathClass);
    return undefined;
  } catch (error) {
    if (error instanceof PathSecurityError) return error;
    throw error;
  }
}

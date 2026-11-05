import * as posixPath from 'node:path/posix';
import * as win32Path from 'node:path/win32';

import type { HostEnvironmentInfo, PathClass } from '#/os/interface/hostEnvironment';

import type { EnvironmentLease, EnvironmentPath, EnvironmentWorkspaceMapper } from './environment';
import { EnvironmentError, type EnvironmentRegistry } from './environmentRegistry';

export function normalizeRemoteCwd(cwd: string): string {
  const path = /^[A-Za-z]:[\\/]/.test(cwd) ? win32Path : posixPath;
  if (cwd.includes('\0') || !path.isAbsolute(cwd)) {
    throw new EnvironmentError('environment.invalid_cwd', 'remote cwd must be an absolute POSIX or Windows path; relative paths and ~ are not expanded');
  }
  return path.resolve(cwd);
}

export async function requireEnvironmentDirectory(
  environments: Pick<EnvironmentRegistry, 'acquireWhenReady'>,
  environmentId: string,
  cwd: string,
): Promise<void> {
  let lease: EnvironmentLease;
  try {
    lease = await environments.acquireWhenReady({ environmentId }, ['fs']);
  } catch (error) {
    if (error instanceof EnvironmentError) throw error;
    throw new EnvironmentError(
      'environment.unavailable',
      `failed to connect environment ${environmentId}: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  }
  try {
    const stat = await lease.environment.fs!.stat(cwd).catch((error: unknown) => {
      throw new EnvironmentError(
        'environment.invalid_cwd',
        `cwd ${cwd} is not readable on environment ${environmentId}: ${error instanceof Error ? error.message : String(error)}`,
      );
    });
    if (!stat.isDirectory) {
      throw new EnvironmentError('environment.invalid_cwd', `cwd ${cwd} is not a directory on environment ${environmentId}`);
    }
  } finally {
    lease.dispose();
  }
}

export const DEFAULT_ENVIRONMENT_HOST: HostEnvironmentInfo = {
  osKind: 'unknown',
  osArch: 'unknown',
  osVersion: '',
  shellName: 'sh',
  shellPath: '/bin/sh',
  pathClass: 'posix',
  homeDir: '/',
};

function createEnvironmentPath(pathClass: PathClass): EnvironmentPath {
  const path = pathClass === 'win32' ? win32Path : posixPath;
  return {
    separator: path.sep,
    delimiter: path.delimiter,
    isAbsolute: (value) => path.isAbsolute(value),
    join: (...values) => path.join(...values),
    relative: (from, to) => path.relative(from, to),
    resolve: (...values) => path.resolve(...values),
    basename: (value) => path.basename(value),
    dirname: (value) => path.dirname(value),
  };
}

function createEnvironmentWorkspace(pathClass: PathClass): EnvironmentWorkspaceMapper {
  const path = pathClass === 'win32' ? win32Path : posixPath;
  return {
    mapRoots: (roots) => ({
      workDir: path.resolve(roots.workDir),
      additionalDirs: roots.additionalDirs?.map((root) => path.resolve(root)),
    }),
  };
}

export const ENVIRONMENT_PATHS: Readonly<Record<PathClass, EnvironmentPath>> = {
  posix: createEnvironmentPath('posix'),
  win32: createEnvironmentPath('win32'),
};

export const ENVIRONMENT_WORKSPACES: Readonly<Record<PathClass, EnvironmentWorkspaceMapper>> = {
  posix: createEnvironmentWorkspace('posix'),
  win32: createEnvironmentWorkspace('win32'),
};

export const POSIX_ENVIRONMENT_PATH = ENVIRONMENT_PATHS.posix;
export const POSIX_ENVIRONMENT_WORKSPACE = ENVIRONMENT_WORKSPACES.posix;

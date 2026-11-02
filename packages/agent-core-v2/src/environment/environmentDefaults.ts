import * as posixPath from 'node:path/posix';
import * as win32Path from 'node:path/win32';

import type { HostEnvironmentInfo, PathClass } from '#/os/interface/hostEnvironment';

import type { EnvironmentPath, EnvironmentWorkspaceMapper } from './environment';
import { EnvironmentError } from './environmentRegistry';

export function normalizeRemoteCwd(cwd: string): string {
  const path = /^[A-Za-z]:[\\/]/.test(cwd) || cwd.startsWith('\\\\') ? win32Path : posixPath;
  if (cwd.includes('\0') || !path.isAbsolute(cwd)) {
    throw new EnvironmentError('environment.invalid_cwd', 'remote cwd must be an absolute POSIX or Windows path; relative paths and ~ are not expanded');
  }
  return path.resolve(cwd);
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

export function createEnvironmentPath(pathClass: PathClass): EnvironmentPath {
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

export function createEnvironmentWorkspace(pathClass: PathClass): EnvironmentWorkspaceMapper {
  const path = pathClass === 'win32' ? win32Path : posixPath;
  return {
    mapRoots: (roots) => ({
      workDir: path.resolve(roots.workDir),
      additionalDirs: roots.additionalDirs?.map((root) => path.resolve(root)),
    }),
  };
}

export const POSIX_ENVIRONMENT_PATH = createEnvironmentPath('posix');
export const POSIX_ENVIRONMENT_WORKSPACE = createEnvironmentWorkspace('posix');

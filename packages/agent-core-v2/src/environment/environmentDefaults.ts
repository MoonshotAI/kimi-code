import * as posixPath from 'node:path/posix';
import * as win32Path from 'node:path/win32';

import type { HostEnvironmentInfo, PathClass } from '#/os/interface/hostEnvironment';

import type { EnvironmentPath, EnvironmentWorkspaceMapper } from './environment';
import { EnvironmentError } from './environmentRegistry';

export function normalizeRemoteCwd(cwd: string, pathClass: PathClass = 'posix'): string {
  const path = pathClass === 'win32' ? win32Path : posixPath;
  if (!path.isAbsolute(cwd) || cwd.includes('\0')) {
    throw new EnvironmentError('environment.invalid_cwd', `remote cwd must be an absolute ${pathClass} path; relative paths and ~ are not expanded`);
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

function environmentPath(pathClass: PathClass): EnvironmentPath {
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

export const POSIX_ENVIRONMENT_PATH = environmentPath('posix');
export const WIN32_ENVIRONMENT_PATH = environmentPath('win32');

export function environmentWorkspace(pathClass: PathClass): EnvironmentWorkspaceMapper {
  const path = pathClass === 'win32' ? win32Path : posixPath;
  return {
    mapRoots: (roots) => ({
      workDir: path.resolve(roots.workDir),
      additionalDirs: roots.additionalDirs?.map((root) => path.resolve(root)),
    }),
  };
}

export const POSIX_ENVIRONMENT_WORKSPACE = environmentWorkspace('posix');
export const WIN32_ENVIRONMENT_WORKSPACE = environmentWorkspace('win32');

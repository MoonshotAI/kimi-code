import * as posixPath from 'node:path/posix';

import type { HostEnvironmentInfo } from '#/os/interface/hostEnvironment';

import type { EnvironmentPath, EnvironmentWorkspaceMapper } from './environment';
import { EnvironmentError } from './environmentRegistry';

export function normalizeRemoteCwd(cwd: string): string {
  if (!posixPath.isAbsolute(cwd) || cwd.includes('\0')) {
    throw new EnvironmentError('environment.invalid_cwd', 'remote cwd must be an absolute POSIX path; relative paths and ~ are not expanded');
  }
  return posixPath.resolve(cwd);
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

export const POSIX_ENVIRONMENT_PATH: EnvironmentPath = {
  separator: '/',
  delimiter: ':',
  isAbsolute: (path) => posixPath.isAbsolute(path),
  join: (...paths) => posixPath.join(...paths),
  relative: (from, to) => posixPath.relative(from, to),
  resolve: (...paths) => posixPath.resolve(...paths),
  basename: (path) => posixPath.basename(path),
  dirname: (path) => posixPath.dirname(path),
};

export const POSIX_ENVIRONMENT_WORKSPACE: EnvironmentWorkspaceMapper = {
  mapRoots: (roots) => ({
    workDir: posixPath.resolve(roots.workDir),
    additionalDirs: roots.additionalDirs?.map((root) => posixPath.resolve(root)),
  }),
};

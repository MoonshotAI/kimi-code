import * as posixPath from 'node:path/posix';

import { Event } from '#/_base/event';
import type { IAgentEnvironmentService } from '#/agent/environmentBinding/agentEnvironment';
import type { HostFileStat, IHostFileSystem } from '#/os/interface/hostFileSystem';
import type { Environment, EnvironmentLease, EnvironmentPath, EnvironmentStatus } from '#/environment/environment';

import { createFakeHostFs } from '../../tools/fixtures/fake-exec';

export function posixEnvironmentPath(): EnvironmentPath {
  return {
    separator: '/',
    delimiter: ':',
    isAbsolute: (path) => posixPath.isAbsolute(path),
    join: (...paths) => posixPath.join(...paths),
    relative: (from, to) => posixPath.relative(from, to),
    resolve: (...paths) => posixPath.resolve(...paths),
    basename: (path) => posixPath.basename(path),
    dirname: (path) => posixPath.dirname(path),
  };
}

export interface PlanEnvironmentOptions {
  readonly fs: IHostFileSystem;
  readonly tempDir: string;
  readonly environmentId?: string;
  readonly workDir?: string;
}

export function stubPlanEnvironment(options: PlanEnvironmentOptions): IAgentEnvironmentService {
  const environment: Environment = {
    identity: {
      workspaceId: 'workspace-1',
      environmentId: options.environmentId ?? 'remote',
      generation: 'test-generation',
    },
    capabilities: new Set(['fs']),
    host: {
      osKind: 'Linux',
      osArch: 'x64',
      osVersion: 'test',
      shellName: 'bash',
      shellPath: '/bin/bash',
      pathClass: 'posix',
      homeDir: '/home/remote',
      tempDir: options.tempDir,
    },
    path: posixEnvironmentPath(),
    workspace: { mapRoots: (roots) => roots },
    fs: options.fs,
    status: 'ready',
    onDidChangeStatus: Event.None as Event<EnvironmentStatus>,
    dispose: () => {},
  };
  const lease = (): EnvironmentLease => ({ environment, track: (resource) => resource, dispose: () => {} });
  return {
    _serviceBrand: undefined,
    onDidChange: Event.None as Event<void>,
    inspect: () => environment,
    isAvailable: () => true,
    acquire: lease,
    acquireWhenReady: () => Promise.resolve(lease()),
    reconnect: () => Promise.resolve(),
    workspaceRoots: () => ({ workDir: options.workDir ?? '/workspace', additionalDirs: [] }),
  };
}

export function missingFileError(path: string): Error {
  return Object.assign(new Error(`ENOENT: no such file or directory: ${path}`), {
    code: 'ENOENT',
  });
}

export function createMapFs(
  files: Map<string, string>,
  overrides: Partial<IHostFileSystem> = {},
): IHostFileSystem {
  return createFakeHostFs({
    readText: (path) => {
      const content = files.get(path);
      if (content === undefined) return Promise.reject(missingFileError(path));
      return Promise.resolve(content);
    },
    writeText: (path, content) => {
      files.set(path, content);
      return Promise.resolve();
    },
    appendText: (path, content) => {
      files.set(path, (files.get(path) ?? '') + content);
      return Promise.resolve();
    },
    mkdir: () => Promise.resolve(),
    stat: (path) => {
      if (files.has(path)) {
        return Promise.resolve<HostFileStat>({ isFile: true, isDirectory: false, size: 0 });
      }
      if ([...files.keys()].some((key) => key.startsWith(`${path}/`))) {
        return Promise.resolve<HostFileStat>({ isFile: false, isDirectory: true, size: 0 });
      }
      return Promise.reject(missingFileError(path));
    },
    realpath: (path) => Promise.resolve(path),
    ...overrides,
  });
}

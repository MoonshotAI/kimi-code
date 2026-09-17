import * as posixPath from 'node:path/posix';

import { Event } from '#/_base/event';
import type { IAgentRuntimeService } from '#/agent/runtimeBinding/agentRuntime';
import type { HostFileStat, IHostFileSystem } from '#/os/interface/hostFileSystem';
import type { Runtime, RuntimeLease, RuntimePath, RuntimeStatus } from '#/runtime/runtime';

import { createFakeHostFs } from '../../tools/fixtures/fake-exec';

export function posixRuntimePath(): RuntimePath {
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

export interface PlanRuntimeOptions {
  readonly fs: IHostFileSystem;
  readonly tempDir: string;
  readonly runtimeId?: string;
  readonly workDir?: string;
}

export function stubPlanRuntime(options: PlanRuntimeOptions): IAgentRuntimeService {
  const runtime: Runtime = {
    identity: {
      workspaceId: 'workspace-1',
      runtimeId: options.runtimeId ?? 'remote',
      generation: 'test-generation',
    },
    capabilities: new Set(['fs']),
    environment: {
      osKind: 'Linux',
      osArch: 'x64',
      osVersion: 'test',
      shellName: 'bash',
      shellPath: '/bin/bash',
      pathClass: 'posix',
      homeDir: '/home/remote',
      tempDir: options.tempDir,
    },
    path: posixRuntimePath(),
    workspace: { mapRoots: (roots) => roots },
    fs: options.fs,
    status: 'ready',
    onDidChangeStatus: Event.None as Event<RuntimeStatus>,
    dispose: () => {},
  };
  const lease = (): RuntimeLease => ({ runtime, track: (resource) => resource, dispose: () => {} });
  return {
    _serviceBrand: undefined,
    onDidChange: Event.None as Event<void>,
    inspect: () => runtime,
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

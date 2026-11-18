
import { IHostFileSystem } from '#/os/interface/hostFileSystem';
import { IHostEnvironment } from '#/os/interface/hostEnvironment';
import type { HostFileStat } from '#/os/interface/hostFileSystem';

import { createFakeHostFs } from '../../tools/fixtures/fake-exec';

export interface PlanEnvironmentOptions {
  readonly fs: IHostFileSystem;
  readonly tempDir: string;
}

export function stubPlanEnvironment(options: PlanEnvironmentOptions) {
  return (reg: {
    defineInstance<T>(id: import('#/_base/di/instantiation').ServiceIdentifier<T>, value: T): void;
  }): void => {
    reg.defineInstance(IHostFileSystem, options.fs);
    reg.defineInstance(IHostEnvironment, {
      _serviceBrand: undefined,
      osKind: 'Linux',
      osArch: 'x64',
      osVersion: 'test',
      shellName: 'bash',
      shellPath: '/bin/bash',
      pathClass: 'posix',
      homeDir: '/home/test',
      ready: Promise.resolve(),
    });
  };
}

function missingFileError(path: string): Error {
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
    readBytes: async (path, n) => {
      const content = files.get(path);
      if (content === undefined) throw missingFileError(path);
      const bytes = Buffer.from(content);
      return n === undefined ? bytes : bytes.subarray(0, n);
    },
    readLines: async function* (path) {
      const content = files.get(path);
      if (content === undefined) throw missingFileError(path);
      const lines = content.split('\n');
      for (let i = 0; i < lines.length; i++) {
        if (i < lines.length - 1) yield `${lines[i]}\n`;
        else if (lines[i] !== '') yield lines[i]!;
      }
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

import * as posixPath from 'node:path/posix';
import * as win32Path from 'node:path/win32';

import { Emitter } from '#/_base/event';

import type { Runtime, RuntimeCapability, RuntimePath, RuntimeStatus } from './runtime';

export class FakeRuntime implements Runtime {
  readonly capabilities: ReadonlySet<RuntimeCapability>;
  readonly environment;
  readonly path: RuntimePath;
  readonly workspace;
  readonly fs = undefined;
  readonly process = undefined;
  readonly watch = undefined;
  readonly terminal = undefined;
  private currentStatus: RuntimeStatus;
  private readonly statusEmitter = new Emitter<RuntimeStatus>();
  readonly onDidChangeStatus = this.statusEmitter.event;
  disposed = false;

  constructor(
    readonly identity: Runtime['identity'],
    options: {
      readonly status?: RuntimeStatus;
      readonly capabilities?: readonly RuntimeCapability[];
      readonly pathClass?: 'posix' | 'win32';
      readonly environment?: Partial<Runtime['environment']>;
      readonly mapWorkspaceRoots?: Runtime['workspace']['mapRoots'];
    } = {},
  ) {
    this.currentStatus = options.status ?? 'ready';
    this.capabilities = new Set(options.capabilities ?? []);
    const path = options.pathClass === 'win32' ? win32Path : posixPath;
    this.environment = {
      osKind: 'fake',
      osArch: 'fake',
      osVersion: 'fake',
      shellName: 'sh' as const,
      shellPath: '/bin/sh',
      pathClass: options.pathClass ?? 'posix',
      homeDir: options.pathClass === 'win32' ? 'C:\\Users\\fake' : '/home/fake',
      ...options.environment,
    };
    this.path = {
      separator: path.sep as '/' | '\\',
      delimiter: path.delimiter as ':' | ';',
      isAbsolute: (p) => path.isAbsolute(p),
      join: (...paths) => path.join(...paths),
      relative: (from, to) => path.relative(from, to),
      resolve: (...paths) => path.resolve(...paths),
      basename: (p) => path.basename(p),
      dirname: (p) => path.dirname(p),
    };
    this.workspace = {
      mapRoots: options.mapWorkspaceRoots ?? ((roots) => ({
        workDir: path.resolve(roots.workDir),
        additionalDirs: roots.additionalDirs?.map((root) => path.resolve(root)),
      })),
    };
  }

  get status(): RuntimeStatus {
    return this.currentStatus;
  }

  setStatus(status: RuntimeStatus): void {
    if (this.currentStatus === status) return;
    this.currentStatus = status;
    this.statusEmitter.fire(status);
  }

  dispose(): void {
    this.disposed = true;
    this.currentStatus = 'disposed';
    this.statusEmitter.fire('disposed');
    this.statusEmitter.dispose();
  }
}

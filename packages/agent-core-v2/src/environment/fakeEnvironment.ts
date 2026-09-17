import * as posixPath from 'node:path/posix';
import * as win32Path from 'node:path/win32';

import { Emitter } from '#/_base/event';

import type { Environment, EnvironmentCapability, EnvironmentPath, EnvironmentStatus } from './environment';

export class FakeEnvironment implements Environment {
  readonly capabilities: ReadonlySet<EnvironmentCapability>;
  readonly host;
  readonly path: EnvironmentPath;
  readonly workspace;
  readonly fs = undefined;
  readonly process = undefined;
  readonly watch = undefined;
  readonly terminal = undefined;
  private currentStatus: EnvironmentStatus;
  private readonly statusEmitter = new Emitter<EnvironmentStatus>();
  readonly onDidChangeStatus = this.statusEmitter.event;
  whenReady?: Promise<void>;
  connectError?: string;
  disposed = false;

  constructor(
    readonly identity: Environment['identity'],
    options: {
      readonly status?: EnvironmentStatus;
      readonly capabilities?: readonly EnvironmentCapability[];
      readonly pathClass?: 'posix' | 'win32';
      readonly host?: Partial<Environment['host']>;
      readonly mapWorkspaceRoots?: Environment['workspace']['mapRoots'];
    } = {},
  ) {
    this.currentStatus = options.status ?? 'ready';
    this.capabilities = new Set(options.capabilities ?? []);
    const path = options.pathClass === 'win32' ? win32Path : posixPath;
    this.host = {
      osKind: 'fake',
      osArch: 'fake',
      osVersion: 'fake',
      shellName: 'sh' as const,
      shellPath: '/bin/sh',
      pathClass: options.pathClass ?? 'posix',
      homeDir: options.pathClass === 'win32' ? 'C:\\Users\\fake' : '/home/fake',
      ...options.host,
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

  get status(): EnvironmentStatus {
    return this.currentStatus;
  }

  setStatus(status: EnvironmentStatus): void {
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

import { Emitter } from '#/_base/event';
import { IHostEnvironment } from '#/os/interface/hostEnvironment';
import { IHostFileSystem } from '#/os/interface/hostFileSystem';
import { IHostProcessService } from '#/os/interface/hostProcess';

import type { Environment, EnvironmentCapability, EnvironmentPath, EnvironmentStatus } from './environment';
import { createEnvironmentPath, createEnvironmentWorkspace } from './environmentDefaults';

let nextGeneration = 1;

export class LocalEnvironment implements Environment {
  readonly identity;
  readonly capabilities: ReadonlySet<EnvironmentCapability>;
  readonly host;
  readonly path: EnvironmentPath;
  readonly workspace: Environment['workspace'];
  readonly fs;
  readonly process;
  private currentStatus: EnvironmentStatus = 'ready';
  private readonly statusEmitter = new Emitter<EnvironmentStatus>();
  readonly onDidChangeStatus = this.statusEmitter.event;

  constructor(
    environment: IHostEnvironment,
    fs: IHostFileSystem | undefined,
    process: IHostProcessService | undefined,
  ) {
    this.identity = { environmentId: 'local', generation: `local-${nextGeneration++}` };
    const capabilities = new Set<EnvironmentCapability>();
    if (fs !== undefined) capabilities.add('fs');
    if (process !== undefined) capabilities.add('process');
    this.capabilities = capabilities;
    this.host = {
      osKind: environment.osKind,
      osArch: environment.osArch,
      osVersion: environment.osVersion,
      shellName: environment.shellName,
      shellPath: environment.shellPath,
      pathClass: environment.pathClass,
      homeDir: environment.homeDir,
    };
    this.path = createEnvironmentPath(environment.pathClass);
    this.workspace = createEnvironmentWorkspace(environment.pathClass);
    this.fs = fs;
    this.process = process;
  }

  get status(): EnvironmentStatus {
    return this.currentStatus;
  }

  dispose(): void {
    this.currentStatus = 'disposed';
    this.statusEmitter.fire('disposed');
    this.statusEmitter.dispose();
  }
}

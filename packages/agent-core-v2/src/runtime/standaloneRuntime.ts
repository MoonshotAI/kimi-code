import { createDecorator, type ServiceIdentifier } from '#/_base/di/instantiation';
import { ScopeActivation, registerScopedService } from '#/_base/di/scope';
import { LifecycleScope } from '#/app/scopes';
import { IHostEnvironment } from '#/os/interface/hostEnvironment';
import { IHostFileSystem } from '#/os/interface/hostFileSystem';
import { IHostFsWatchService } from '#/os/interface/hostFsWatch';
import { IHostProcessService } from '#/os/interface/hostProcess';
import { IHostTerminalService } from '#/os/interface/terminal';

import { LocalRuntime } from './localRuntime';
import type { Runtime } from './runtime';

/**
 * Builds fully detached local runtimes that belong to no workspace instance,
 * for entry points that must touch the filesystem without materializing one.
 */
export interface IStandaloneRuntimeFactory {
  readonly _serviceBrand: undefined;
  createLocalRuntime(workspaceId: string): Runtime;
}

export const IStandaloneRuntimeFactory: ServiceIdentifier<IStandaloneRuntimeFactory> =
  createDecorator<IStandaloneRuntimeFactory>('standaloneRuntimeFactory');

export class StandaloneRuntimeFactory implements IStandaloneRuntimeFactory {
  declare readonly _serviceBrand: undefined;

  constructor(
    @IHostEnvironment private readonly environment: IHostEnvironment,
    @IHostFileSystem private readonly fs: IHostFileSystem,
    @IHostProcessService private readonly process: IHostProcessService,
    @IHostFsWatchService private readonly watch: IHostFsWatchService,
    @IHostTerminalService private readonly terminal: IHostTerminalService,
  ) {}

  createLocalRuntime(workspaceId: string): Runtime {
    return new LocalRuntime(workspaceId, this.environment, this.fs, this.process, this.watch, this.terminal);
  }
}

registerScopedService(
  LifecycleScope.App,
  IStandaloneRuntimeFactory,
  StandaloneRuntimeFactory,
  ScopeActivation.OnDemand,
  'standaloneRuntimeFactory',
);

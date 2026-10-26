import { createDecorator, type ServiceIdentifier } from '#/_base/di/instantiation';
import { ScopeActivation, registerScopedService } from '#/_base/di/scope';
import { LifecycleScope } from '#/app/scopes';
import { IHostEnvironment } from '#/os/interface/hostEnvironment';
import { IHostFileSystem } from '#/os/interface/hostFileSystem';
import { IHostProcessService } from '#/os/interface/hostProcess';

import { LocalRuntime } from './localRuntime';
import type { Runtime } from './runtime';

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
  ) {}

  createLocalRuntime(workspaceId: string): Runtime {
    return new LocalRuntime(workspaceId, this.environment, this.fs, this.process);
  }
}

registerScopedService(
  LifecycleScope.App,
  IStandaloneRuntimeFactory,
  StandaloneRuntimeFactory,
  ScopeActivation.OnDemand,
  'standaloneRuntimeFactory',
);

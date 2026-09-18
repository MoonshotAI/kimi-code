import { createDecorator, type ServiceIdentifier } from '#/_base/di/instantiation';
import { ScopeActivation, registerScopedService } from '#/_base/di/scope';
import { LifecycleScope } from '#/app/scopes';
import { IHostEnvironment } from '#/os/interface/hostEnvironment';
import { IHostFileSystem } from '#/os/interface/hostFileSystem';
import { IHostProcessService } from '#/os/interface/hostProcess';
import { IHostTerminalService } from '#/os/interface/terminal';

import { LocalEnvironment } from './localEnvironment';
import type { Environment } from './environment';

export interface IStandaloneEnvironmentFactory {
  readonly _serviceBrand: undefined;
  createLocalEnvironment(workspaceId: string): Environment;
}

export const IStandaloneEnvironmentFactory: ServiceIdentifier<IStandaloneEnvironmentFactory> =
  createDecorator<IStandaloneEnvironmentFactory>('standaloneEnvironmentFactory');

export class StandaloneEnvironmentFactory implements IStandaloneEnvironmentFactory {
  declare readonly _serviceBrand: undefined;

  constructor(
    @IHostEnvironment private readonly environment: IHostEnvironment,
    @IHostFileSystem private readonly fs: IHostFileSystem,
    @IHostProcessService private readonly process: IHostProcessService,
    @IHostTerminalService private readonly terminal: IHostTerminalService,
  ) {}

  createLocalEnvironment(workspaceId: string): Environment {
    return new LocalEnvironment(workspaceId, this.environment, this.fs, this.process, this.terminal);
  }
}

registerScopedService(
  LifecycleScope.App,
  IStandaloneEnvironmentFactory,
  StandaloneEnvironmentFactory,
  ScopeActivation.OnDemand,
  'standaloneEnvironmentFactory',
);

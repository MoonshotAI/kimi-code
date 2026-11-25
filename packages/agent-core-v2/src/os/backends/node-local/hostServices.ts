import { SyncDescriptor } from '#/_base/di/descriptors';
import { ScopeActivation, registerScopedService, type ScopeSeed } from '#/_base/di/scope';
import { LifecycleScope } from '#/app/scopes';
import { IHostClock } from '#/os/interface/hostClock';
import { IHostEnvironment } from '#/os/interface/hostEnvironment';
import { IHostFileSystem } from '#/os/interface/hostFileSystem';
import { IHostProcessService } from '#/os/interface/hostProcess';

import { HostClockService } from './hostClockService';
import { HostEnvironmentService } from './hostEnvironmentService';
import { HostFileSystem } from './hostFsService';
import { HostProcessService } from './hostProcessService';

export interface WindowsBashRuntimeEnv extends Readonly<Record<string, string>> {
  readonly KIMI_SHELL_PATH: string;
}

export function windowsBashRuntimeSeed(env: WindowsBashRuntimeEnv): ScopeSeed {
  const { KIMI_SHELL_PATH: shellPath, ...shellEnv } = env;
  const native = new HostProcessService();
  const processes: IHostProcessService = {
    _serviceBrand: undefined,
    spawn: (command, args, options) => native.spawn(command, args, command === shellPath
      ? { ...options, env: { ...shellEnv, ...options?.env } }
      : options),
  };
  return [
    [IHostEnvironment, new SyncDescriptor(HostEnvironmentService, [shellPath])],
    [IHostProcessService, processes],
  ];
}

registerScopedService(LifecycleScope.App, IHostClock, HostClockService, ScopeActivation.OnScopeCreated, 'hostClock');
registerScopedService(LifecycleScope.App, IHostEnvironment, HostEnvironmentService, ScopeActivation.OnScopeCreated, 'hostEnvironment');
registerScopedService(LifecycleScope.App, IHostFileSystem, HostFileSystem, ScopeActivation.OnScopeCreated, 'hostFs');
registerScopedService(LifecycleScope.App, IHostProcessService, HostProcessService, ScopeActivation.OnScopeCreated, 'hostProcess');

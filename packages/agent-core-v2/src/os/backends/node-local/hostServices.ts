import { ScopeActivation, registerScopedService } from '#/_base/di/scope';
import { LifecycleScope } from '#/app/scopes';
import { IHostClock } from '#/os/interface/hostClock';
import { IHostEnvironment } from '#/os/interface/hostEnvironment';
import { IHostFileSystem } from '#/os/interface/hostFileSystem';
import { IHostProcessService } from '#/os/interface/hostProcess';

import { HostClockService } from './hostClockService';
import { HostEnvironmentService } from './hostEnvironmentService';
import { HostFileSystem } from './hostFsService';
import { HostProcessService } from './hostProcessService';

registerScopedService(LifecycleScope.App, IHostClock, HostClockService, ScopeActivation.OnScopeCreated, 'hostClock');
registerScopedService(LifecycleScope.App, IHostEnvironment, HostEnvironmentService, ScopeActivation.OnScopeCreated, 'hostEnvironment');
registerScopedService(LifecycleScope.App, IHostFileSystem, HostFileSystem, ScopeActivation.OnScopeCreated, 'hostFs');
registerScopedService(LifecycleScope.App, IHostProcessService, HostProcessService, ScopeActivation.OnScopeCreated, 'hostProcess');

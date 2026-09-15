import { LifecycleScope } from '#/app/scopes';
import { ScopeActivation, registerScopedService } from '#/_base/di/scope';
import { IHostClock } from '#/os/interface/hostClock';

export class HostClockService implements IHostClock {
  declare readonly _serviceBrand: undefined;

  now(): Date {
    return new Date();
  }

  timeZone(): string {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  }
}

registerScopedService(
  LifecycleScope.App,
  IHostClock,
  HostClockService,
  ScopeActivation.OnScopeCreated,
  'hostClock',
);

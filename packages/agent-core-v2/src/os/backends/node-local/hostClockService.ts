/**
 * `hostClock` domain — `IHostClock` implementation.
 *
 * Reads wall-clock time and the host's resolved local time zone through the
 * Node.js runtime. Bound at App scope.
 */

import { LifecycleScope, ScopeActivation, registerScopedService } from '#/_base/di/scope';
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

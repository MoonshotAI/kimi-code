/**
 * `hostClock` domain — current host time and local time-zone contract.
 *
 * Defines `IHostClock`, the App-scoped boundary used by time-sensitive
 * domains to observe the current instant and the host's local IANA time zone.
 */

import { createDecorator, type ServiceIdentifier } from '#/_base/di/instantiation';

export interface IHostClock {
  readonly _serviceBrand: undefined;

  now(): Date;
  timeZone(): string;
}

export const IHostClock: ServiceIdentifier<IHostClock> =
  createDecorator<IHostClock>('hostClock');

import { createDecorator, type ServiceIdentifier } from '#/_base/di/instantiation';

export interface IHostClock {
  readonly _serviceBrand: undefined;

  now(): Date;
  timeZone(): string;
}

export const IHostClock: ServiceIdentifier<IHostClock> =
  createDecorator<IHostClock>('hostClock');

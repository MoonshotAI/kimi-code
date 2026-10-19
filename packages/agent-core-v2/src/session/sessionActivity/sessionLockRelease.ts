import { createDecorator, type ServiceIdentifier } from '#/_base/di/instantiation';

export interface ISessionLockReleaseService {
  readonly _serviceBrand: undefined;
}

export const ISessionLockReleaseService: ServiceIdentifier<ISessionLockReleaseService> =
  createDecorator<ISessionLockReleaseService>('sessionLockReleaseService');

import { createDecorator, type ServiceIdentifier } from '#/_base/di/instantiation';

export interface IStaleGuardService {
  readonly _serviceBrand: undefined;

  recordedMtimeMs(path: string): number | undefined;
}

export const IStaleGuardService: ServiceIdentifier<IStaleGuardService> =
  createDecorator<IStaleGuardService>('staleGuardService');

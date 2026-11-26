import { createDecorator, type ServiceIdentifier } from '#/_base/di/instantiation';

export interface ISessionExternalHooksService {
  readonly _serviceBrand: undefined;

  takeSessionStartContext(): string | undefined;
  whenSessionStartSettled?(): Promise<void>;
}

export const ISessionExternalHooksService: ServiceIdentifier<ISessionExternalHooksService> =
  createDecorator<ISessionExternalHooksService>('sessionExternalHooksService');

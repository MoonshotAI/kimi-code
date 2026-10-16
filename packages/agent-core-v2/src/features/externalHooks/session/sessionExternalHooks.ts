import { createDecorator, type ServiceIdentifier } from '#/_base/di/instantiation';

export interface ISessionExternalHooksService {
  readonly _serviceBrand: undefined;
  drainSessionStartMessages?(): readonly string[];
}

export const ISessionExternalHooksService: ServiceIdentifier<ISessionExternalHooksService> =
  createDecorator<ISessionExternalHooksService>('sessionExternalHooksService');

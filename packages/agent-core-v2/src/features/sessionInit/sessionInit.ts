import { createDecorator, type ServiceIdentifier } from '#/_base/di/instantiation';

export interface ISessionInitService {
  readonly _serviceBrand: undefined;

  generateAgentsMd(): Promise<void>;

  cancelInit(): void;
}

export const ISessionInitService: ServiceIdentifier<ISessionInitService> =
  createDecorator<ISessionInitService>('sessionInitService');

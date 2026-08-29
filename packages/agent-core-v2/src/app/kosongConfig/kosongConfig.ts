import { createDecorator, type ServiceIdentifier } from '#/_base/di/instantiation';

export interface IKosongConfigService {
  readonly _serviceBrand: undefined;

  readonly ready: Promise<void>;
}

export const IKosongConfigService: ServiceIdentifier<IKosongConfigService> =
  createDecorator<IKosongConfigService>('kosongConfigService');

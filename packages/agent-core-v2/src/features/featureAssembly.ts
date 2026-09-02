import { createDecorator, type ServiceIdentifier } from '#/_base/di/instantiation';

export interface IFeatureAssemblyService {
  readonly _serviceBrand: undefined;
}

export const IFeatureAssemblyService: ServiceIdentifier<IFeatureAssemblyService> =
  createDecorator<IFeatureAssemblyService>('featureAssemblyService');

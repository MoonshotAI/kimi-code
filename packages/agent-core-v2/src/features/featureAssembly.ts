/**
 * `features` domain — the `IFeatureAssemblyService` contract.
 *
 * The assembly drains the module-level feature recipe table
 * (`featureRegistry`) into managed units at App-scope creation; it owns no
 * state of its own and exists so feature assembly runs through the same
 * provide path as every other unit. Bound at App scope.
 */

import { createDecorator, type ServiceIdentifier } from '#/_base/di/instantiation';

export interface IFeatureAssemblyService {
  readonly _serviceBrand: undefined;
}

export const IFeatureAssemblyService: ServiceIdentifier<IFeatureAssemblyService> =
  createDecorator<IFeatureAssemblyService>('featureAssemblyService');

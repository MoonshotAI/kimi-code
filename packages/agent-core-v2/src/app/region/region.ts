import type { KimiRegion, KimiRegionResolution } from '@moonshot-ai/kimi-code-oauth';

import { createDecorator, type ServiceIdentifier } from '#/_base/di/instantiation';

export interface IRegionService {
  readonly _serviceBrand: undefined;

  current(): KimiRegionResolution;
  getRegionAsync(): Promise<KimiRegion>;
}

export const IRegionService: ServiceIdentifier<IRegionService> =
  createDecorator<IRegionService>('regionService');

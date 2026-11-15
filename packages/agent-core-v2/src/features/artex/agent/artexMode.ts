import { createDecorator, type ServiceIdentifier } from '#/_base/di/instantiation';

export const ARTEX_MODE_INJECTION_VARIANT = 'artex_mode';

export interface IArtexModeService {
  readonly _serviceBrand: undefined;
  readonly isActive: boolean;
  enter(): void;
  exit(): void;
}

export const IArtexModeService: ServiceIdentifier<IArtexModeService> =
  createDecorator<IArtexModeService>('artexModeService');

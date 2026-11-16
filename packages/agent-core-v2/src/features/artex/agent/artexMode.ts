import { createDecorator, type ServiceIdentifier } from '#/_base/di/instantiation';

export const ARTEX_MODE_INJECTION_VARIANT = 'artex_mode';

export type ArtexExitReason = 'user' | 'mode-mutex';

export interface IArtexModeService {
  readonly _serviceBrand: undefined;
  readonly isActive: boolean;
  enter(explorationId?: number): void;
  exit(reason?: ArtexExitReason): void;
}

export const IArtexModeService: ServiceIdentifier<IArtexModeService> =
  createDecorator<IArtexModeService>('artexModeService');

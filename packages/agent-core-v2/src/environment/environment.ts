/**
 * `environment` domain (L1) — resolved environment paths and OS probe.
 *
 * Defines the public contract of the environment: the resolved paths
 * (`homeDir`, `configPath`) and the `IEnvironmentService` used by other
 * domains to locate config and detect the host `Environment`, plus the
 * Core-scope `environmentSeed`. Core-scoped — one shared instance.
 */

import type { Environment } from '@moonshot-ai/kaos';

import { createDecorator, type ServiceIdentifier } from '#/_base/di/instantiation';
import type { ScopeSeed } from '#/_base/di/scope';

export interface IEnvironmentOptions {
  readonly homeDir: string;
}

export const IEnvironmentOptions: ServiceIdentifier<IEnvironmentOptions> =
  createDecorator<IEnvironmentOptions>('environmentOptions');

export interface IEnvironmentService {
  readonly _serviceBrand: undefined;
  readonly homeDir: string;
  readonly configPath: string;
  detect(): Promise<Environment>;
}

export const IEnvironmentService: ServiceIdentifier<IEnvironmentService> =
  createDecorator<IEnvironmentService>('environmentService');

export function environmentSeed(homeDir: string): ScopeSeed {
  return [[IEnvironmentOptions as ServiceIdentifier<unknown>, { homeDir } satisfies IEnvironmentOptions]];
}

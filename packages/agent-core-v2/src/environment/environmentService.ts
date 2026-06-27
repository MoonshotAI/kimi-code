/**
 * `environment` domain (L1) — `IEnvironmentService` implementation.
 *
 * Resolves `homeDir` / `configPath` from the injected options and detects the
 * host `Environment` on demand. Bound at Core scope.
 */

import { join } from 'node:path';

import { type Environment, detectEnvironmentFromNode } from '@moonshot-ai/kaos';

import { InstantiationType } from '#/_base/di/extensions';
import { LifecycleScope, registerScopedService } from '#/_base/di/scope';

import {
  IEnvironmentOptions,
  IEnvironmentService,
} from './environment';

export class EnvironmentService implements IEnvironmentService {
  declare readonly _serviceBrand: undefined;
  readonly homeDir: string;
  readonly configPath: string;
  readonly sessionsDir: string;
  readonly blobsDir: string;
  readonly storeDir: string;
  readonly cacheDir: string;
  readonly logsDir: string;
  private detected?: Promise<Environment>;

  constructor(@IEnvironmentOptions options: IEnvironmentOptions) {
    this.homeDir = options.homeDir;
    this.configPath = join(options.homeDir, 'config.toml');
    this.sessionsDir = join(options.homeDir, 'sessions');
    this.blobsDir = join(options.homeDir, 'blobs');
    this.storeDir = join(options.homeDir, 'store');
    this.cacheDir = join(options.homeDir, 'cache');
    this.logsDir = join(options.homeDir, 'logs');
  }

  detect(): Promise<Environment> {
    this.detected ??= detectEnvironmentFromNode();
    return this.detected;
  }
}

registerScopedService(
  LifecycleScope.Core,
  IEnvironmentService,
  EnvironmentService,
  InstantiationType.Eager,
  'environment',
);

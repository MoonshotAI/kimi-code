/**
 * `environment` domain (L1) — `IEnvironmentService` implementation.
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
  private detected?: Promise<Environment>;

  constructor(@IEnvironmentOptions options: IEnvironmentOptions) {
    this.homeDir = options.homeDir;
    this.configPath = join(options.homeDir, 'config.toml');
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

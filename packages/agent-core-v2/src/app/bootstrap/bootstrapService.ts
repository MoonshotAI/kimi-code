/**
 * `bootstrap` domain (L1) — `IBootstrapService` implementation.
 *
 * Holds the resolved startup snapshot from the seeded `IBootstrapOptions` and
 * exposes the host facts and app path layout. Bound at App scope.
 */

import { join } from 'pathe';

import { InstantiationType } from '#/_base/di/extensions';
import { LifecycleScope, registerScopedService } from '#/_base/di/scope';

import { IBootstrapOptions, IBootstrapService } from './bootstrap';

export class BootstrapService implements IBootstrapService {
  declare readonly _serviceBrand: undefined;

  readonly platform: NodeJS.Platform;
  readonly arch: string;
  readonly cwd: string;
  readonly osHomeDir: string;
  readonly homeDir: string;
  readonly configPath: string;
  readonly sessionsDir: string;
  readonly blobsDir: string;
  readonly storeDir: string;
  readonly cacheDir: string;
  readonly logsDir: string;
  private readonly env: NodeJS.ProcessEnv;

  constructor(@IBootstrapOptions options: IBootstrapOptions) {
    this.platform = options.platform;
    this.arch = options.arch;
    this.cwd = options.cwd;
    this.osHomeDir = options.osHomeDir;
    this.env = options.env;
    this.homeDir = options.homeDir;
    this.configPath = options.configPath;
    this.sessionsDir = join(options.homeDir, 'sessions');
    this.blobsDir = join(options.homeDir, 'blobs');
    this.storeDir = join(options.homeDir, 'store');
    this.cacheDir = join(options.homeDir, 'cache');
    this.logsDir = join(options.homeDir, 'logs');
  }

  getEnv(name: string): string | undefined {
    return this.env[name];
  }
}

registerScopedService(LifecycleScope.App, IBootstrapService, BootstrapService, InstantiationType.Eager, 'bootstrap');

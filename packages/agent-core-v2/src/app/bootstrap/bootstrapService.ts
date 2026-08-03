/**
 * `bootstrap` domain — `IBootstrapService` implementation.
 *
 * Holds the resolved startup snapshot from the seeded `IBootstrapOptions` and
 * exposes the host facts, app path layout, and top-level scope mapping. All
 * `scope(name)` values and `configKey` are computed once at construction so
 * business code can read them synchronously.
 *
 * Bound at App scope.
 */

import { basename, join, relative } from 'pathe';

import type { KimiHostIdentity } from '@moonshot-ai/kimi-code-oauth';

import { LifecycleScope, ScopeActivation, registerScopedService } from '#/_base/di/scope';

import {
  IBootstrapOptions,
  IBootstrapService,
  type HostArgs,
  type PersistenceScopeName,
} from './bootstrap';

export class BootstrapService implements IBootstrapService {
  declare readonly _serviceBrand: undefined;

  readonly platform: NodeJS.Platform;
  readonly arch: string;
  readonly cwd: string;
  readonly osHomeDir: string;
  readonly homeDir: string;
  readonly configPath: string;
  readonly clientIdentity: KimiHostIdentity;
  readonly args: HostArgs;
  readonly sessionsDir: string;
  readonly blobsDir: string;
  readonly storeDir: string;
  readonly cacheDir: string;
  readonly logsDir: string;
  readonly configKey: string;

  private readonly env: NodeJS.ProcessEnv;
  private readonly scopes: Readonly<Record<PersistenceScopeName, string>>;

  constructor(@IBootstrapOptions options: IBootstrapOptions) {
    this.platform = options.platform;
    this.arch = options.arch;
    this.cwd = options.cwd;
    this.osHomeDir = options.osHomeDir;
    this.env = options.env;
    this.homeDir = options.homeDir;
    this.configPath = options.configPath;
    this.clientIdentity = options.clientIdentity;
    this.args = options.args;
    this.sessionsDir = join(options.homeDir, 'sessions');
    this.blobsDir = join(options.homeDir, 'blobs');
    this.storeDir = join(options.homeDir, 'store');
    this.cacheDir = join(options.homeDir, 'cache');
    this.logsDir = join(options.homeDir, 'logs');
    this.configKey = basename(options.configPath);
    this.scopes = {
      config: '',
      sessions: relative(options.homeDir, join(options.homeDir, 'sessions')),
      blobs: relative(options.homeDir, this.blobsDir),
      store: relative(options.homeDir, this.storeDir),
      logs: relative(options.homeDir, this.logsDir),
      cache: relative(options.homeDir, this.cacheDir),
      credentials: 'credentials',
      cron: 'cron',
    };
  }

  getEnv(name: string): string | undefined {
    return this.env[name];
  }

  scope(name: PersistenceScopeName): string {
    return this.scopes[name];
  }
}

registerScopedService(LifecycleScope.App, IBootstrapService, BootstrapService, ScopeActivation.OnScopeCreated, 'bootstrap');

/**
 * `bootstrap` domain (L1) — `IBootstrapService` implementation.
 *
 * Holds the resolved startup snapshot from the seeded `IBootstrapOptions` and
 * exposes the host facts, app path layout, and semantic scope mapping. All
 * `scope*(...)` methods and `configKey` are computed once at construction so
 * business code can read them synchronously. Path fields (`homeDir` / `*Dir` /
 * `configPath`) are kept alongside for now to ease migration, but new business
 * code should prefer `scope(name)` / `sessionScope(...)` / `agentScope(...)` —
 * only the file-only accessors (`sessionDir` / `agentHomedir`) still hand out
 * absolute paths, for the small number of legacy APIs that need them.
 *
 * Bound at App scope.
 */

import { basename, join, relative } from 'pathe';

import { InstantiationType } from '#/_base/di/extensions';
import { LifecycleScope, registerScopedService } from '#/_base/di/scope';

import {
  IBootstrapOptions,
  IBootstrapService,
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
  readonly clientVersion: string;
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
    this.clientVersion = options.clientVersion;
    this.sessionsDir = join(options.homeDir, 'sessions');
    this.blobsDir = join(options.homeDir, 'blobs');
    this.storeDir = join(options.homeDir, 'store');
    this.cacheDir = join(options.homeDir, 'cache');
    this.logsDir = join(options.homeDir, 'logs');
    this.configKey = basename(options.configPath);
    this.scopes = {
      config: '',
      sessions: relative(options.homeDir, this.sessionsDir),
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

  sessionScope(workspaceId: string, sessionId: string): string {
    return join(this.scopes.sessions, workspaceId, sessionId);
  }

  agentScope(workspaceId: string, sessionId: string, agentId: string): string {
    return join(this.sessionScope(workspaceId, sessionId), 'agents', agentId);
  }

  sessionDir(workspaceId: string, sessionId: string): string {
    return join(this.homeDir, this.sessionScope(workspaceId, sessionId));
  }

  agentHomedir(workspaceId: string, sessionId: string, agentId: string): string {
    return join(this.homeDir, this.agentScope(workspaceId, sessionId, agentId));
  }
}

registerScopedService(LifecycleScope.App, IBootstrapService, BootstrapService, InstantiationType.Eager, 'bootstrap');

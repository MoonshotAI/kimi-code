/**
 * `bootstrap` domain (L1) — frozen startup snapshot and composition root.
 *
 * Defines the `IBootstrapService`, the snapshot of the world the process runs
 * in, resolved once at startup and frozen for the process: observed host facts
 * (`platform`, `arch`, `cwd`, `osHomeDir`, `getEnv`) and the app path layout
 * (`homeDir`, `configPath`, …). `resolveBootstrapOptions` is the single place
 * that reads `process.env` / `os.homedir()` / invocation input to resolve
 * the snapshot; everything downstream reads from `IBootstrapService` instead of
 * touching `process` directly. Bound at App scope. Also seeds the
 * `IFileSystemStorageService` with a `FileStorageService` rooted at `homeDir`
 * so the byte layer (and every Store above it) persists to disk.
 */

import { mkdirSync } from 'node:fs';
import { homedir } from 'node:os';

import { join } from 'pathe';

import { SyncDescriptor } from '#/_base/di/descriptors';
import { createDecorator, type ServiceIdentifier } from '#/_base/di/instantiation';
import { createAppScope, type Scope, type ScopeSeed } from '#/_base/di/scope';
import {
  IFileSystemStorageService,
} from '#/persistence/interface/storage';
import { FileStorageService } from '#/persistence/backends/node-fs/fileStorageService';
import { FileSkillDiscovery } from '#/app/skillCatalog/fileSkillDiscovery';
import { ISkillDiscovery } from '#/app/skillCatalog/skillDiscovery';

export interface IBootstrapOptions {
  readonly homeDir: string;
  readonly configPath: string;
  readonly osHomeDir: string;
  readonly platform: NodeJS.Platform;
  readonly arch: string;
  readonly cwd: string;
  readonly env: NodeJS.ProcessEnv;
}

export const IBootstrapOptions: ServiceIdentifier<IBootstrapOptions> =
  createDecorator<IBootstrapOptions>('bootstrapOptions');

/**
 * Well-known top-level persistence areas. The bootstrap layer owns the mapping
 * from each semantic name to concrete backend addressing; business code passes
 * a scope string to `IFileSystemStorageService` / `IAtomicDocumentStore` / `IAppendLogStore`
 * without caring whether the byte layer talks to a filesystem, a database, or
 * a blob store.
 */
export type PersistenceScopeName =
  | 'config'
  | 'sessions'
  | 'blobs'
  | 'store'
  | 'logs'
  | 'cache'
  | 'credentials'
  | 'cron';

export interface IBootstrapService {
  readonly _serviceBrand: undefined;

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
  getEnv(name: string): string | undefined;
  /**
   * Scope string for a well-known top-level persistence area. Business code
   * passes this to `IFileSystemStorageService` / `IAtomicDocumentStore` / `IAppendLogStore`
   * — the backend layer converts it to concrete addressing.
   */
  scope(name: PersistenceScopeName): string;
  /**
   * Scope string for a session's persistence root.
   * Equivalent to `${scope('sessions')}/${workspaceId}/${sessionId}`.
   */
  sessionScope(workspaceId: string, sessionId: string): string;
  /**
   * Scope string for a specific agent's persistence root under a session.
   * Equivalent to `${sessionScope(wsId, sId)}/agents/${agentId}`.
   */
  agentScope(workspaceId: string, sessionId: string, agentId: string): string;
  /**
   * File-only: absolute on-disk directory for a session.
   * Prefer `sessionScope(...)` — this exists for legacy APIs (session logs,
   * task output files). Non-file bootstraps may throw.
   */
  sessionDir(workspaceId: string, sessionId: string): string;
  /**
   * File-only: absolute on-disk directory for a specific agent. Same caveat.
   */
  agentHomedir(workspaceId: string, sessionId: string, agentId: string): string;
  /** Key of the config document under `scope('config')` (file: `'config.toml'`). */
  readonly configKey: string;
}

export const IBootstrapService: ServiceIdentifier<IBootstrapService> =
  createDecorator<IBootstrapService>('bootstrapService');

export interface BootstrapInput {
  readonly homeDir?: string;
  readonly configPath?: string;
  readonly env?: NodeJS.ProcessEnv;
  readonly osHomeDir?: string;
  readonly platform?: NodeJS.Platform;
  readonly arch?: string;
  readonly cwd?: string;
}

export function resolveBootstrapOptions(input: BootstrapInput = {}): IBootstrapOptions {
  const env = input.env ?? process.env;
  const osHomeDir = input.osHomeDir ?? homedir();
  const homeDir = resolveKimiHome(input.homeDir, env, osHomeDir);
  const configPath = input.configPath ?? join(homeDir, 'config.toml');
  return {
    homeDir,
    configPath,
    osHomeDir,
    platform: input.platform ?? process.platform,
    arch: input.arch ?? process.arch,
    cwd: input.cwd ?? process.cwd(),
    env,
  };
}

export function bootstrapSeed(input: BootstrapInput = {}): ScopeSeed {
  return [[IBootstrapOptions as ServiceIdentifier<unknown>, resolveBootstrapOptions(input)]];
}

export interface BootstrapResult {
  readonly app: Scope;
}

export function bootstrap(input: BootstrapInput = {}, extraSeeds: ScopeSeed = []): BootstrapResult {
  const options = resolveBootstrapOptions(input);
  const app = createAppScope({
    extra: [...bootstrapSeed(input), ...storageSeed(options), ...skillSeed(), ...extraSeeds],
  });
  return { app };
}

function storageSeed(options: IBootstrapOptions): ScopeSeed {
  const file = (): SyncDescriptor<IFileSystemStorageService> =>
    new SyncDescriptor(FileStorageService, [options.homeDir, 0o700, 0o600], true);
  return [
    [IFileSystemStorageService as ServiceIdentifier<unknown>, file()],
  ];
}

function skillSeed(): ScopeSeed {
  // The skill catalog Store is bound to the filesystem backend so skill
  // discovery reads from disk. Tests rely on the in-memory backend registered
  // in the skill domain (this `extra` seed overrides it in production).
  return [
    [
      ISkillDiscovery as ServiceIdentifier<unknown>,
      new SyncDescriptor(FileSkillDiscovery, [], true),
    ],
  ];
}

export function resolveKimiHome(
  homeDir?: string,
  env: NodeJS.ProcessEnv = process.env,
  osHomeDir: string = homedir(),
): string {
  return homeDir ?? env['KIMI_CODE_HOME'] ?? join(osHomeDir, '.kimi-code');
}

export function resolveConfigPath(input: {
  readonly homeDir?: string;
  readonly configPath?: string;
}): string {
  return input.configPath ?? join(resolveKimiHome(input.homeDir), 'config.toml');
}

export function ensureKimiHome(homeDir: string): void {
  mkdirSync(homeDir, { recursive: true, mode: 0o700 });
}

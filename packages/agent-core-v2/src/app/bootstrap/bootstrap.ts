/**
 * `bootstrap` domain (L1) — frozen startup snapshot and composition root.
 *
 * Defines the `IBootstrapService`, the snapshot of the world the process runs
 * in, resolved once at startup and frozen for the process: observed host facts
 * (`platform`, `arch`, `cwd`, `osHomeDir`, `getEnv`, `clientVersion`) and the
 * app path layout (`homeDir`, `configPath`, …). `resolveBootstrapOptions` is
 * the single place that reads `process.env` / `os.homedir()` / invocation
 * input to resolve the snapshot; everything downstream reads from
 * `IBootstrapService` instead of touching `process` directly. Bound at App
 * scope. Also seeds the `IFileSystemStorageService` with a `FileStorageService`
 * rooted at `homeDir` so the byte layer (and every Store above it) persists
 * to disk.
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
  readonly clientVersion: string;
}

export const IBootstrapOptions: ServiceIdentifier<IBootstrapOptions> =
  createDecorator<IBootstrapOptions>('bootstrapOptions');

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
  readonly clientVersion: string;
  readonly sessionsDir: string;
  readonly blobsDir: string;
  readonly storeDir: string;
  readonly cacheDir: string;
  readonly logsDir: string;
  getEnv(name: string): string | undefined;
  scope(name: PersistenceScopeName): string;
  sessionScope(workspaceId: string, sessionId: string): string;
  agentScope(workspaceId: string, sessionId: string, agentId: string): string;
  sessionDir(workspaceId: string, sessionId: string): string;
  agentHomedir(workspaceId: string, sessionId: string, agentId: string): string;
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
  readonly clientVersion?: string;
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
    clientVersion: input.clientVersion ?? 'unknown',
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

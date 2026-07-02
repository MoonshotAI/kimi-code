/**
 * `bootstrap` domain (L1) — frozen startup snapshot and composition root.
 *
 * Defines the `IBootstrapService`, the snapshot of the world the process runs
 * in, resolved once at startup and frozen for the process: observed host facts
 * (`platform`, `arch`, `cwd`, `osHomeDir`, `getEnv`) and the app path layout
 * (`homeDir`, `configPath`, …). `resolveBootstrapOptions` is the single place
 * that reads `process.env` / `os.homedir()` / invocation input to resolve
 * the snapshot; everything downstream reads from `IBootstrapService` instead of
 * touching `process` directly. Bound at App scope. Also seeds the App storage
 * roles (`IStorageService`, `IAppendLogStorage`, `IAtomicDocumentStorage`,
 * `IBlobStorage`) each with its own `FileStorageService` rooted at `homeDir`
 * (via per-token `SyncDescriptor`s), so the byte layer (and every Store above
 * it) persists to disk while the roles stay independently routable.
 */

import { mkdirSync } from 'node:fs';
import { homedir } from 'node:os';

import { join } from 'pathe';

import { SyncDescriptor } from '#/_base/di/descriptors';
import { createDecorator, type ServiceIdentifier } from '#/_base/di/instantiation';
import { createAppScope, type Scope, type ScopeSeed } from '#/_base/di/scope';
import {
  FileStorageService,
  IAppendLogStorage,
  IAtomicDocumentStorage,
  IBlobStorage,
  IStorageService,
} from '#/app/storage';
import { FileSkillCatalogStore } from '#/app/globalSkillCatalog/fileSkillCatalogStore';
import { ISkillCatalogStore } from '#/app/globalSkillCatalog/skillCatalogStore';

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
  // Each storage role token resolves to its OWN `FileStorageService` instance
  // rooted at `homeDir`. The four roles are intentionally independent so a
  // composition profile can route any one of them (e.g. `IBlobStorage`) to a
  // different backend; bundling them into a single shared instance would bake
  // in the assumption that they are always the same backend. We seed a
  // per-token `SyncDescriptor` (VS Code's `new SyncDescriptor(Ctor, [args])`
  // pattern) so the container builds each instance via DI, while the `extra`
  // seed still overrides the in-memory default robustly.
  const file = (): SyncDescriptor<IStorageService> =>
    new SyncDescriptor(FileStorageService, [options.homeDir], true);
  return [
    [IStorageService as ServiceIdentifier<unknown>, file()],
    [IAppendLogStorage as ServiceIdentifier<unknown>, file()],
    [IAtomicDocumentStorage as ServiceIdentifier<unknown>, file()],
    [IBlobStorage as ServiceIdentifier<unknown>, file()],
  ];
}

function skillSeed(): ScopeSeed {
  // The skill catalog Store is bound to the filesystem backend so skill
  // discovery reads from disk. Tests rely on the in-memory backend registered
  // in the skill domain (this `extra` seed overrides it in production).
  return [
    [
      ISkillCatalogStore as ServiceIdentifier<unknown>,
      new SyncDescriptor(FileSkillCatalogStore, [], true),
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

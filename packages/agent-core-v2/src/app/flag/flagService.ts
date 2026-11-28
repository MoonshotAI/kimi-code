import { existsSync, lstatSync, readFileSync, realpathSync, type Stats } from 'node:fs';
import { basename, dirname, join, resolve } from 'pathe';

import { Disposable } from '#/_base/di/lifecycle';
import { Emitter, type Event } from '#/_base/event';
import { ILogService } from '#/_base/log/log';
import { LifecycleScope } from '#/app/scopes';
import { ScopeActivation, registerScopedService } from '#/_base/di/scope';
import { parseBooleanEnv } from '#/_base/utils/env';
import {
  IBootstrapService,
  resolveConfigPath,
  resolveExperimentalProfile,
  resolveExperimentalSurface,
} from '#/app/bootstrap/bootstrap';
import { IConfigService } from '#/app/config/config';
import { isPlainObject } from '#/app/config/configPure';
import { TOWER_FLAG_ENV, TOWER_FLAG_ID } from '#/features/tower/tower';
import { FileStorageService } from '#/persistence/backends/node-fs/fileStorageService';
import { IFileSystemStorageService } from '#/persistence/interface/storage';

import {
  BETA_MASTER_CONFIG_KEY,
  type BetaMasterSwitchState,
  type ExperimentalConfig,
  type ExperimentalFeatureState,
  type ExperimentalFlagConfig,
  type ExperimentalFlagMap,
  type ExperimentalFlagSource,
  EXPERIMENTAL_SECTION,
  IFlagService,
} from './flag';
import {
  EXPERIMENTAL_PROFILES,
  type ExperimentalProfile,
  type ExperimentalStage,
  type ExperimentalSurface,
  type FlagDefinitionInput,
  type FlagId,
  IFlagRegistry,
} from './flagRegistry';

export const MASTER_ENV = 'KIMI_CODE_EXPERIMENTAL_FLAG';
export const EXPERIMENTAL_MIGRATIONS_FILENAME = 'experimental-migrations.json';

const EXISTING_INSTALL_MARKERS = ['sessions', 'credentials', 'user-history'] as const;
const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

type LegacyTowerMode = 'none' | 'pending-persist' | 'fallback';
type MigrationRecord = Record<string, boolean>;

function safeLstat(filePath: string): Stats | 'error' | undefined {
  try {
    return lstatSync(filePath, { throwIfNoEntry: false });
  } catch {
    return 'error';
  }
}

function migrationKeyFor(profile: ExperimentalProfile, configPath: string): string {
  const resolved = resolve(configPath);
  try {
    return `${profile}:${join(realpathSync(dirname(resolved)), basename(resolved))}`;
  } catch {
    return `${profile}:${resolved}`;
  }
}

function parseMigrationRecord(text: string): MigrationRecord | undefined {
  try {
    const raw: unknown = JSON.parse(text);
    if (!isPlainObject(raw)) return undefined;
    if (Object.values(raw).some((value) => typeof value !== 'boolean')) return undefined;
    return raw as MigrationRecord;
  } catch {
    return undefined;
  }
}

function readDiskMigrationRecord(homeDir: string): MigrationRecord | 'corrupt' {
  const markerPath = join(homeDir, EXPERIMENTAL_MIGRATIONS_FILENAME);
  const stat = safeLstat(markerPath);
  if (stat === undefined) return {};
  if (stat === 'error' || !stat.isFile() || stat.nlink > 1) return 'corrupt';
  try {
    return parseMigrationRecord(readFileSync(markerPath, 'utf8')) ?? 'corrupt';
  } catch {
    return 'corrupt';
  }
}

function canPersistRegularFile(filePath: string): boolean {
  const stat = safeLstat(filePath);
  if (stat === undefined) return true;
  if (stat === 'error' || !stat.isFile() || stat.nlink > 1) return false;
  return process.platform === 'win32' || (stat.mode & 0o222) !== 0;
}

function hasExplicitTowerOptOut(rawExperimental: unknown, profile: ExperimentalProfile): boolean {
  return (
    isPlainObject(rawExperimental) &&
    isPlainObject(rawExperimental[profile]) &&
    rawExperimental[profile][TOWER_FLAG_ID] === false
  );
}

export class FlagService extends Disposable implements IFlagService {
  declare readonly _serviceBrand: undefined;
  readonly ready: Promise<void>;
  readonly registry: IFlagRegistry;
  private readonly _onDidChangeFlags = this._register(new Emitter<void>());
  readonly onDidChangeFlags: Event<void> = this._onDidChangeFlags.event;
  private configOverrides: ExperimentalFlagConfig;
  private legacyTowerMode: LegacyTowerMode = 'none';

  constructor(
    @IBootstrapService private readonly bootstrap: IBootstrapService,
    @IConfigService private readonly config: IConfigService,
    @IFlagRegistry registry: IFlagRegistry,
    @IFileSystemStorageService private readonly storage: IFileSystemStorageService,
    @ILogService private readonly log: ILogService,
  ) {
    super();
    this.registry = registry;
    this.configOverrides = this.readConfig();
    this._register(
      this.config.onDidChangeConfiguration((e) => {
        if (e.domain === EXPERIMENTAL_SECTION) {
          this.configOverrides = this.readConfig();
          this._onDidChangeFlags.fire();
        }
      }),
    );
    this.ready = this.initLegacyTowerMigration();
  }

  private initLegacyTowerMigration(): Promise<void> {
    const profile = this.profile;
    const { homeDir, configPath } = this.bootstrap;
    const defaultConfigPath = resolveConfigPath({ homeDir });
    const key = migrationKeyFor(profile, configPath);
    const marker =
      this.storage instanceof FileStorageService ? readDiskMigrationRecord(homeDir) : {};
    if (marker !== 'corrupt' && marker[key] === true) {
      return Promise.resolve();
    }

    const rawExperimental = this.config.inspect(EXPERIMENTAL_SECTION).userValue;
    const configStat = safeLstat(configPath);
    const defaultStat = safeLstat(defaultConfigPath);
    const existingInstall =
      rawExperimental !== undefined ||
      (configStat !== undefined && configStat !== 'error') ||
      (defaultStat !== undefined && defaultStat !== 'error') ||
      EXISTING_INSTALL_MARKERS.some((entry) => existsSync(join(homeDir, entry)));

    if (!existingInstall) {
      if (marker === 'corrupt') return Promise.resolve();
      const freshKeys = EXPERIMENTAL_PROFILES.flatMap((target) => [
        migrationKeyFor(target, configPath),
        migrationKeyFor(target, defaultConfigPath),
      ]);
      return this.stampMigrationKeys([...new Set(freshKeys)]);
    }

    const towerEnv = parseBooleanEnv(this.bootstrap.getEnv(TOWER_FLAG_ENV));
    if (towerEnv !== undefined || this.configOverrides[TOWER_FLAG_ID] !== undefined) {
      return marker === 'corrupt' ? Promise.resolve() : this.stampMigrationKeys([key]);
    }

    const masterOn = parseBooleanEnv(this.bootstrap.getEnv(MASTER_ENV)) === true;
    if (!masterOn || hasExplicitTowerOptOut(rawExperimental, profile)) {
      return Promise.resolve();
    }

    const canPersist =
      marker !== 'corrupt' &&
      dirname(resolve(configPath)) === resolve(homeDir) &&
      (!(this.storage instanceof FileStorageService) || canPersistRegularFile(configPath));

    this.legacyTowerMode = canPersist ? 'pending-persist' : 'fallback';
    return canPersist ? this.persistLegacyTowerMigration(profile, key) : Promise.resolve();
  }

  private async persistLegacyTowerMigration(
    profile: ExperimentalProfile,
    key: string,
  ): Promise<void> {
    try {
      await this.config.ready;
    } catch {}
    if (this._store.isDisposed) return;

    const latestMarker = await this.readStoredMigrationRecord();
    if (this._store.isDisposed) return;
    if (latestMarker === 'corrupt') {
      this.transitionLegacyTowerMode('fallback');
      return;
    }
    if (latestMarker[key] === true) {
      this.transitionLegacyTowerMode('none');
      return;
    }

    const rawAfterLoad = this.config.inspect(EXPERIMENTAL_SECTION).userValue;
    if (hasExplicitTowerOptOut(rawAfterLoad, profile)) {
      this.transitionLegacyTowerMode('none');
      try {
        this.config.assertValid(EXPERIMENTAL_SECTION);
        await this.stampMigrationKeys([key]);
      } catch {}
      return;
    }

    try {
      this.config.assertValid(EXPERIMENTAL_SECTION);
      if (
        this.storage instanceof FileStorageService &&
        !canPersistRegularFile(this.bootstrap.configPath)
      ) {
        this.transitionLegacyTowerMode('fallback');
        return;
      }
      const current = this.config.get<ExperimentalConfig>(EXPERIMENTAL_SECTION);
      if (current?.[profile]?.[TOWER_FLAG_ID] === undefined) {
        await this.config.set(EXPERIMENTAL_SECTION, {
          ...current,
          [profile]: { ...current?.[profile], [TOWER_FLAG_ID]: true },
        });
      }
      this.legacyTowerMode = 'none';
      if (!this._store.isDisposed) {
        await this.stampMigrationKeys([key]);
      }
    } catch (error) {
      this.log.warn('legacy tower config migration failed; keeping in-memory activation', {
        error,
      });
      this.transitionLegacyTowerMode('fallback');
    }
  }

  private async readStoredMigrationRecord(): Promise<MigrationRecord | 'corrupt'> {
    try {
      const bytes = await this.storage.read('', EXPERIMENTAL_MIGRATIONS_FILENAME);
      if (bytes === undefined) return {};
      return parseMigrationRecord(textDecoder.decode(bytes)) ?? 'corrupt';
    } catch {
      return 'corrupt';
    }
  }

  private async stampMigrationKeys(keys: readonly string[]): Promise<void> {
    try {
      await this.config.ready;
    } catch {}
    if (this._store.isDisposed) return;
    try {
      if (
        this.storage instanceof FileStorageService &&
        !canPersistRegularFile(join(this.bootstrap.homeDir, EXPERIMENTAL_MIGRATIONS_FILENAME))
      ) {
        return;
      }
      const current = await this.readStoredMigrationRecord();
      if (this._store.isDisposed || current === 'corrupt') return;
      const next: MigrationRecord = { ...current };
      for (const key of keys) {
        next[key] = true;
      }
      await this.storage.write(
        '',
        EXPERIMENTAL_MIGRATIONS_FILENAME,
        textEncoder.encode(`${JSON.stringify(next, null, 2)}\n`),
        { atomic: true },
      );
    } catch (error) {
      this.log.warn('legacy tower migration marker stamp failed', { error });
    }
  }

  private transitionLegacyTowerMode(next: LegacyTowerMode): void {
    if (this.legacyTowerMode === next) return;
    this.legacyTowerMode = next;
    this._onDidChangeFlags.fire();
  }

  private get surface(): ExperimentalSurface {
    return resolveExperimentalSurface(this.bootstrap.clientIdentity, this.bootstrap.args.surface);
  }

  get profile(): ExperimentalProfile {
    return resolveExperimentalProfile(
      this.bootstrap.clientIdentity,
      this.surface,
      this.bootstrap.args.experimentalProfile,
    );
  }

  private readConfig(): ExperimentalFlagConfig {
    const section = this.config.get<ExperimentalConfig>(EXPERIMENTAL_SECTION);
    return section?.[this.profile] ?? {};
  }

  setConfigOverrides(overrides: ExperimentalFlagConfig | undefined): void {
    this.configOverrides = overrides ?? {};
    this._onDidChangeFlags.fire();
  }

  betaState(): BetaMasterSwitchState {
    const profile = this.profile;
    const configValue = this.configOverrides[BETA_MASTER_CONFIG_KEY];
    if (parseBooleanEnv(this.bootstrap.getEnv(MASTER_ENV)) === true) {
      return { profile, enabled: true, source: 'env', env: MASTER_ENV, configValue };
    }
    if (configValue !== undefined) {
      return { profile, enabled: configValue, source: 'config', env: MASTER_ENV, configValue };
    }
    return { profile, enabled: false, source: 'default', env: MASTER_ENV, configValue: undefined };
  }

  enabled(id: FlagId): boolean {
    const def = this.registry.get(id);
    if (def === undefined) return false;
    return this.evaluate(def, def.stages[this.surface] ?? 'experimental').enabled;
  }

  explain(id: FlagId): ExperimentalFeatureState | undefined {
    const def = this.registry.get(id);
    if (def === undefined) return undefined;
    const stage = def.stages[this.surface] ?? 'experimental';
    const resolved = this.evaluate(def, stage);
    return this.state(def, stage, resolved.enabled, resolved.source, resolved.env, resolved.configValue);
  }

  snapshot(): ExperimentalFlagMap {
    return Object.fromEntries(
      this.registry.list().map((def) => [def.id, this.enabled(def.id)]),
    );
  }

  enabledIds(): readonly FlagId[] {
    return this.registry
      .list()
      .filter((def) => this.enabled(def.id))
      .map((def) => def.id);
  }

  exposedIds(): readonly FlagId[] {
    return this.registry
      .list()
      .filter((def) => {
        const stage = def.stages[this.surface];
        return stage !== undefined && stage !== 'ga';
      })
      .filter((def) => this.enabled(def.id))
      .filter((def) => def.isExposed?.(this) ?? true)
      .map((def) => def.id);
  }

  explainAll(): readonly ExperimentalFeatureState[] {
    return this.registry
      .list()
      .filter((def) => def.stages[this.surface] !== undefined)
      .map((def) => this.explain(def.id))
      .filter((state): state is ExperimentalFeatureState => state !== undefined);
  }

  private evaluate(
    def: FlagDefinitionInput,
    stage: ExperimentalStage,
  ): {
    readonly enabled: boolean;
    readonly source: ExperimentalFlagSource;
    readonly env: string;
    readonly configValue: boolean | undefined;
  } {
    const configValue = this.configOverrides[def.id];
    const envOverride = parseBooleanEnv(this.bootstrap.getEnv(def.env));
    if (envOverride !== undefined) {
      return { enabled: envOverride, source: 'env', env: def.env, configValue };
    }
    if (stage === 'ga') {
      return { enabled: true, source: 'default', env: def.env, configValue };
    }
    if (stage === 'beta') {
      const beta = this.betaState();
      if (beta.enabled) {
        return {
          enabled: true,
          source: beta.source === 'env' ? 'master-env' : 'beta-config',
          env: def.env,
          configValue,
        };
      }
    }
    if (configValue !== undefined) {
      return { enabled: configValue, source: 'config', env: def.env, configValue };
    }
    if (def.id === TOWER_FLAG_ID) {
      if (this.legacyTowerMode === 'pending-persist') {
        return { enabled: true, source: 'config', env: def.env, configValue: true };
      }
      if (this.legacyTowerMode === 'fallback') {
        return { enabled: true, source: 'env', env: def.env, configValue: undefined };
      }
    }
    return { enabled: false, source: 'default', env: def.env, configValue: undefined };
  }

  private state(
    def: FlagDefinitionInput,
    stage: ExperimentalStage,
    enabled: boolean,
    source: ExperimentalFlagSource,
    env: string,
    configValue: boolean | undefined,
  ): ExperimentalFeatureState {
    const active = def.isExposed !== undefined ? def.isExposed(this) && enabled : enabled;
    return {
      id: def.id,
      title: def.title,
      description: def.description,
      stage,
      effectTiming: def.effectTiming ?? 'immediate',
      env,
      enabled,
      active,
      source,
      configValue,
    };
  }
}

registerScopedService(
  LifecycleScope.App,
  IFlagService,
  FlagService,
  ScopeActivation.OnScopeCreated,
  'flag',
);

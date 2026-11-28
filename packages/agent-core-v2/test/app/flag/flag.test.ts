import {
  chmodSync,
  existsSync,
  linkSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { SyncDescriptor } from '#/_base/di/descriptors';
import { DisposableStore } from '#/_base/di/lifecycle';
import { TestInstantiationService } from '#/_base/di/test';
import { IBootstrapService } from '#/app/bootstrap/bootstrap';
import { IConfigRegistry, IConfigService } from '#/app/config/config';
import type { ConfigChangedEvent as WireConfigChangedEvent } from '#/app/config/configEvents';
import { ConfigRegistry, ConfigService } from '#/app/config/configService';
import {
  BETA_MASTER_CONFIG_KEY,
  type ExperimentalConfig,
  EXPERIMENTAL_SECTION,
  IFlagService,
  experimentalFromToml,
  experimentalToToml,
} from '#/app/flag/flag';
import {
  type ExperimentalProfile,
  type ExperimentalSurface,
  IFlagRegistry,
  type FlagDefinitionInput,
} from '#/app/flag/flagRegistry';
import { FlagRegistryService } from '#/app/flag/flagRegistryService';
import { FlagService, MASTER_ENV } from '#/app/flag/flagService';
import {
  EXPERIMENTAL_MIGRATIONS_FILENAME,
  normalizeMigrationConfigKey,
} from '#/app/flag/legacyMasterEnvMigration';
import { TOWER_FLAG_ENV, TOWER_FLAG_ID } from '#/features/tower/tower';
import { ILogService } from '#/_base/log/log';
import { IAtomicTomlDocumentStore } from '#/persistence/interface/atomicDocumentStore';
import { TomlAtomicDocumentStore } from '#/persistence/backends/node-fs/atomicDocumentStore';
import { FileStorageService } from '#/persistence/backends/node-fs/fileStorageService';
import { InMemoryStorageService } from '#/persistence/backends/memory/inMemoryStorageService';
import { IFileSystemStorageService } from '#/persistence/interface/storage';

import { stubBootstrap } from '../bootstrap/stubs';
import { stubLog } from '../../_base/log/stubs';

const exampleBetaFlag: FlagDefinitionInput = {
  id: 'example_beta',
  title: 'Example Beta flag',
  description: 'Beta feature used to exercise the flag service.',
  env: 'KIMI_CODE_EXPERIMENTAL_EXAMPLE_BETA',
  stages: { tui: 'beta', desktop: 'beta', web: 'beta' },
  effectTiming: 'next-session',
};

const exampleExperimentalFlag: FlagDefinitionInput = {
  id: 'example_exp',
  title: 'Example Experimental flag',
  description: 'Experimental feature used to exercise the flag service.',
  env: 'KIMI_CODE_EXPERIMENTAL_EXAMPLE_EXP',
  stages: { tui: 'experimental', desktop: 'experimental' },
  effectTiming: 'restart',
};

describe('FlagRegistryService', () => {
  it('registers and resolves by id', () => {
    const reg = new FlagRegistryService();
    reg.register(exampleBetaFlag);
    expect(reg.list().map((d) => d.id)).toEqual(['example_beta']);
    expect(reg.get('example_beta')?.env).toBe('KIMI_CODE_EXPERIMENTAL_EXAMPLE_BETA');
  });

  it('returns undefined for an unknown id', () => {
    const reg = new FlagRegistryService();
    expect(reg.get('does_not_exist')).toBeUndefined();
  });

  it('throws on a duplicate id', () => {
    const reg = new FlagRegistryService();
    reg.register(exampleBetaFlag);
    expect(() => reg.register(exampleBetaFlag)).toThrow();
  });

  it('unregisters when the returned disposable is disposed', () => {
    const reg = new FlagRegistryService();
    const handle = reg.register(exampleBetaFlag);
    handle.dispose();
    expect(reg.get('example_beta')).toBeUndefined();
  });
});

describe('FlagService', () => {
  let disposables: DisposableStore;
  let homeDir: string;

  beforeEach(() => {
    disposables = new DisposableStore();
    homeDir = `/tmp/kimi-code-flag-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  });
  afterEach(() => disposables.dispose());

  function makeFlags(
    env: Readonly<Record<string, string | undefined>> = {},
    surface: ExperimentalSurface = 'tui',
    experimentalProfile?: ExperimentalProfile,
  ) {
    const ix = disposables.add(new TestInstantiationService());
    ix.stub(IBootstrapService, stubBootstrap(homeDir, env, { surface, experimentalProfile }));
    ix.stub(ILogService, stubLog());
    ix.stub(IFileSystemStorageService, new InMemoryStorageService());
    ix.set(IAtomicTomlDocumentStore, new SyncDescriptor(TomlAtomicDocumentStore));
    ix.set(IConfigRegistry, new SyncDescriptor(ConfigRegistry));
    ix.set(IConfigService, new SyncDescriptor(ConfigService));
    ix.set(IFlagRegistry, new SyncDescriptor(FlagRegistryService));
    ix.set(IFlagService, new SyncDescriptor(FlagService));
    ix.get(IFlagRegistry).register(exampleBetaFlag);
    ix.get(IFlagRegistry).register(exampleExperimentalFlag);
    return {
      registry: ix.get(IConfigRegistry),
      flagRegistry: ix.get(IFlagRegistry),
      config: ix.get(IConfigService),
      flags: ix.get(IFlagService),
    };
  }

  it('registers the experimental config section downward', () => {
    const { registry } = makeFlags();
    expect(registry.getSection(EXPERIMENTAL_SECTION)).toMatchObject({
      domain: EXPERIMENTAL_SECTION,
    });
    expect(registry.getSection(EXPERIMENTAL_SECTION)?.schema).toBeDefined();
  });

  it('defaults both beta and experimental flags to false when unconfigured', () => {
    const { flags } = makeFlags();
    expect(flags.explain('example_beta')).toMatchObject({
      enabled: false,
      active: false,
      stage: 'beta',
      effectTiming: 'next-session',
      source: 'default',
    });
    expect(flags.explain('example_exp')).toMatchObject({
      enabled: false,
      active: false,
      stage: 'experimental',
      effectTiming: 'restart',
      source: 'default',
    });
    expect(flags.betaState()).toEqual({
      profile: 'cli',
      enabled: false,
      source: 'default',
      env: MASTER_ENV,
      configValue: undefined,
    });
  });

  it('returns undefined for an unregistered flag', () => {
    const { flags } = makeFlags();
    expect(flags.explain('does_not_exist')).toBeUndefined();
    expect(flags.enabled('does_not_exist')).toBe(false);
  });

  it('enables only beta flags via KIMI_CODE_EXPERIMENTAL_FLAG and leaves experimental flags off', async () => {
    const { config, flags } = makeFlags({ [MASTER_ENV]: '1' });
    await config.set(EXPERIMENTAL_SECTION, { cli: { example_beta: false } });

    expect(flags.betaState()).toEqual({
      profile: 'cli',
      enabled: true,
      source: 'env',
      env: MASTER_ENV,
      configValue: undefined,
    });
    expect(flags.explain('example_beta')).toMatchObject({
      enabled: true,
      source: 'master-env',
      configValue: false,
    });
    expect(flags.explain('example_exp')).toMatchObject({
      enabled: false,
      source: 'default',
    });
  });

  it('enables only beta flags via [experimental.cli].beta without overwriting child config values', async () => {
    const { config, flags } = makeFlags({ [MASTER_ENV]: '0' });
    await config.set(EXPERIMENTAL_SECTION, {
      cli: {
        example_beta: false,
        [BETA_MASTER_CONFIG_KEY]: true,
      },
    });

    expect(flags.betaState()).toEqual({
      profile: 'cli',
      enabled: true,
      source: 'config',
      env: MASTER_ENV,
      configValue: true,
    });
    expect(flags.explain('example_beta')).toMatchObject({
      enabled: true,
      source: 'beta-config',
      configValue: false,
    });
    expect(flags.explain('example_exp')).toMatchObject({
      enabled: false,
      source: 'default',
    });

    await config.set(EXPERIMENTAL_SECTION, {
      cli: {
        example_beta: false,
        [BETA_MASTER_CONFIG_KEY]: false,
      },
    });
    expect(flags.explain('example_beta')).toMatchObject({
      enabled: false,
      source: 'config',
      configValue: false,
    });
  });

  it('lets per-feature env override both beta master switch and config', async () => {
    const { config, flags } = makeFlags({
      KIMI_CODE_EXPERIMENTAL_EXAMPLE_BETA: 'false',
      [MASTER_ENV]: '1',
    });
    await config.set(EXPERIMENTAL_SECTION, {
      cli: {
        example_beta: true,
        [BETA_MASTER_CONFIG_KEY]: true,
      },
    });
    expect(flags.explain('example_beta')).toMatchObject({
      enabled: false,
      source: 'env',
      configValue: true,
    });
  });

  it('isolates [experimental.cli] (tui + web) from [experimental.desktop]', async () => {
    const sharedSection = {
      cli: {
        [BETA_MASTER_CONFIG_KEY]: true,
        example_exp: false,
      },
      desktop: {
        [BETA_MASTER_CONFIG_KEY]: false,
        example_exp: true,
      },
    };

    const tui = makeFlags({}, 'tui');
    await tui.config.set(EXPERIMENTAL_SECTION, sharedSection);
    expect(tui.flags.betaState()).toMatchObject({ profile: 'cli', enabled: true, source: 'config' });
    expect(tui.flags.enabled('example_beta')).toBe(true);
    expect(tui.flags.enabled('example_exp')).toBe(false);

    const web = makeFlags({}, 'web');
    await web.config.set(EXPERIMENTAL_SECTION, sharedSection);
    expect(web.flags.betaState()).toMatchObject({ profile: 'cli', enabled: true, source: 'config' });
    expect(web.flags.enabled('example_beta')).toBe(true);
    expect(web.flags.enabled('example_exp')).toBe(false);

    const desktop = makeFlags({}, 'desktop');
    await desktop.config.set(EXPERIMENTAL_SECTION, sharedSection);
    expect(desktop.flags.betaState()).toMatchObject({
      profile: 'desktop',
      enabled: false,
      source: 'config',
      configValue: false,
    });
    expect(desktop.flags.enabled('example_beta')).toBe(false);
    expect(desktop.flags.enabled('example_exp')).toBe(true);
  });

  it('normalizes legacy flat [experimental] TOML keys without leaking CLI-only keys into desktop', () => {
    const parsed = experimentalFromToml({
      notify_user: true,
      wait_for: true,
      prompt_prediction: true,
      tower: false,
      desktop: {
        prompt_prediction: false,
      },
    });
    expect(parsed).toEqual({
      cli: {
        notify_user: true,
        wait_for: true,
        prompt_prediction: true,
        tower: false,
      },
      desktop: {
        prompt_prediction: false,
        tower: false,
      },
    });
    expect(experimentalToToml({ cli: {}, desktop: { notify_user: true } })).toEqual({
      desktop: { notify_user: true },
    });
    expect(experimentalToToml({})).toEqual({});
  });

  it('evaluates ga stage per surface, ignores false in shared config.toml, and excludes ga from exposedIds', async () => {
    const { flagRegistry, config, flags: tuiFlags } = makeFlags({}, 'tui');
    flagRegistry.register({
      id: 'graduated_on_tui',
      title: 'Graduated on TUI',
      description: 'GA on TUI, Beta on Desktop.',
      env: 'KIMI_CODE_EXPERIMENTAL_GRADUATED_ON_TUI',
      stages: { tui: 'ga', desktop: 'beta' },
    });
    await config.set(EXPERIMENTAL_SECTION, { cli: { graduated_on_tui: false } });

    expect(tuiFlags.enabled('graduated_on_tui')).toBe(true);
    expect(tuiFlags.explain('graduated_on_tui')).toMatchObject({
      stage: 'ga',
      enabled: true,
      active: true,
      source: 'default',
    });
    expect(tuiFlags.exposedIds()).not.toContain('graduated_on_tui');

    const { flagRegistry: desktopReg, config: desktopCfg, flags: desktopFlags } = makeFlags({}, 'desktop');
    desktopReg.register({
      id: 'graduated_on_tui',
      title: 'Graduated on TUI',
      description: 'GA on TUI, Beta on Desktop.',
      env: 'KIMI_CODE_EXPERIMENTAL_GRADUATED_ON_TUI',
      stages: { tui: 'ga', desktop: 'beta' },
    });
    await desktopCfg.set(EXPERIMENTAL_SECTION, { desktop: { graduated_on_tui: false } });
    expect(desktopFlags.enabled('graduated_on_tui')).toBe(false);
    expect(desktopFlags.explain('graduated_on_tui')).toMatchObject({
      stage: 'beta',
      enabled: false,
      source: 'config',
    });
  });

  it('allows per-feature env=false to disable a ga flag for debugging', () => {
    const { flagRegistry, flags } = makeFlags(
      { KIMI_CODE_EXPERIMENTAL_GRADUATED_ON_TUI: '0' },
      'tui',
    );
    flagRegistry.register({
      id: 'graduated_on_tui',
      title: 'Graduated on TUI',
      description: 'GA on TUI.',
      env: 'KIMI_CODE_EXPERIMENTAL_GRADUATED_ON_TUI',
      stages: { tui: 'ga' },
    });
    expect(flags.enabled('graduated_on_tui')).toBe(false);
    expect(flags.explain('graduated_on_tui')?.source).toBe('env');
  });

  it('filters explainAll and exposedIds to flags declared for the active surface while keeping enabled() functional across surfaces', async () => {
    const { config, flags: webFlags } = makeFlags({}, 'web');
    expect(webFlags.explainAll().map((f) => f.id)).toEqual(['example_beta']);

    await config.set(EXPERIMENTAL_SECTION, { cli: { example_exp: true } });
    expect(webFlags.enabled('example_exp')).toBe(true);
    expect(webFlags.exposedIds()).not.toContain('example_exp');
  });

  it('distinguishes active from enabled when isExposed is false before restart', async () => {
    const { flagRegistry, config, flags } = makeFlags();
    flagRegistry.register({
      id: 'assembled_only',
      title: 'Assembled-only flag',
      description: 'Enabled in config but not yet assembled in this process.',
      env: 'KIMI_CODE_EXPERIMENTAL_ASSEMBLED_ONLY',
      stages: { tui: 'experimental' },
      effectTiming: 'restart',
      isExposed: () => false,
    });
    await config.set(EXPERIMENTAL_SECTION, { cli: { assembled_only: true } });

    expect(flags.explain('assembled_only')).toMatchObject({
      enabled: true,
      active: false,
      effectTiming: 'restart',
    });
    expect(flags.enabledIds()).toContain('assembled_only');
    expect(flags.exposedIds()).not.toContain('assembled_only');
  });

  it('supports imperative setConfigOverrides and ignores obsolete config keys', async () => {
    const { config, flags } = makeFlags();
    flags.setConfigOverrides({ example_exp: true });
    expect(flags.enabled('example_exp')).toBe(true);
    flags.setConfigOverrides(undefined);
    expect(flags.enabled('example_exp')).toBe(false);

    await config.set(EXPERIMENTAL_SECTION, {
      cli: {
        obsolete_flag: true,
        example_exp: true,
      },
    });
    expect(flags.snapshot()).toEqual({ example_beta: false, example_exp: true });
    expect(flags.explain('obsolete_flag')).toBeUndefined();
  });
});

const towerTestFlag: FlagDefinitionInput = {
  id: TOWER_FLAG_ID,
  title: 'Tower',
  description: 'Multi-session git coordinator.',
  env: TOWER_FLAG_ENV,
  stages: { tui: 'experimental', desktop: 'experimental', web: 'experimental' },
  effectTiming: 'restart',
};

describe('FlagService legacy master env tower migration', () => {
  let disposables: DisposableStore;
  let tempDir: string;

  beforeEach(() => {
    disposables = new DisposableStore();
    tempDir = mkdtempSync(join(tmpdir(), 'kimi-legacy-tower-migration-'));
  });

  afterEach(() => {
    disposables.dispose();
    rmSync(tempDir, { recursive: true, force: true });
  });

  function bootDiskFlags(options: {
    readonly homeDir?: string;
    readonly configPath?: string;
    readonly env?: NodeJS.ProcessEnv;
    readonly profile?: ExperimentalProfile;
  } = {}) {
    const targetHome = options.homeDir ?? tempDir;
    const targetConfigPath = options.configPath ?? join(targetHome, 'config.toml');
    const profile = options.profile ?? 'cli';
    const surface: ExperimentalSurface = profile === 'desktop' ? 'desktop' : 'tui';
    const base = stubBootstrap(targetHome, options.env ?? {}, {
      surface,
      experimentalProfile: profile,
    });
    const bootstrap: IBootstrapService = {
      ...base,
      configPath: targetConfigPath,
      configKey: basename(targetConfigPath),
    };
    const store = new DisposableStore();
    disposables.add(store);
    const ix = store.add(new TestInstantiationService());
    ix.stub(IBootstrapService, bootstrap);
    ix.stub(ILogService, stubLog());
    ix.stub(IFileSystemStorageService, new FileStorageService(targetHome));
    ix.set(IAtomicTomlDocumentStore, new SyncDescriptor(TomlAtomicDocumentStore));
    ix.set(IConfigRegistry, new SyncDescriptor(ConfigRegistry));
    ix.set(IConfigService, new SyncDescriptor(ConfigService));
    ix.set(IFlagRegistry, new SyncDescriptor(FlagRegistryService));
    ix.set(IFlagService, new SyncDescriptor(FlagService));
    ix.get(IFlagRegistry).register(towerTestFlag);
    const flags = ix.get(IFlagService);
    const startupTowerEnabled = flags.enabled(TOWER_FLAG_ID);
    return {
      store,
      config: ix.get(IConfigService),
      flags,
      startupTowerEnabled,
    };
  }

  it('stamps fresh installations without creating tower = true even when KIMI_CODE_EXPERIMENTAL_FLAG=1', async () => {
    const run = bootDiskFlags({ env: { [MASTER_ENV]: '1' } });
    expect(run.startupTowerEnabled).toBe(false);
    await run.flags.ready;
    expect(run.flags.enabled(TOWER_FLAG_ID)).toBe(false);
    expect(existsSync(join(tempDir, 'config.toml'))).toBe(false);
    const marker = JSON.parse(
      readFileSync(join(tempDir, EXPERIMENTAL_MIGRATIONS_FILENAME), 'utf8'),
    ) as { legacyMasterEnvTowerMigrated?: boolean };
    expect(marker.legacyMasterEnvTowerMigrated).toBe(true);
  });

  it('stamps both cli and desktop profiles when a fresh installation starts on Desktop first', async () => {
    const first = bootDiskFlags({ profile: 'desktop' });
    expect(first.startupTowerEnabled).toBe(false);
    await first.flags.ready;

    mkdirSync(join(tempDir, 'sessions'));
    writeFileSync(join(tempDir, 'config.toml'), 'default_model = "kimi-k2"\n', 'utf8');

    const second = bootDiskFlags({ env: { [MASTER_ENV]: '1' }, profile: 'cli' });
    expect(second.startupTowerEnabled).toBe(false);
    await second.flags.ready;
    expect(second.flags.enabled(TOWER_FLAG_ID)).toBe(false);
    expect(readFileSync(join(tempDir, 'config.toml'), 'utf8')).toBe('default_model = "kimi-k2"\n');
  });

  it('migrates existing installations with KIMI_CODE_EXPERIMENTAL_FLAG=1 once while preserving comments', async () => {
    writeFileSync(
      join(tempDir, 'config.toml'),
      '# user comment\ndefault_model = "kimi-k2"\n',
      'utf8',
    );
    const first = bootDiskFlags({ env: { [MASTER_ENV]: '1' } });
    expect(first.startupTowerEnabled).toBe(true);
    await first.flags.ready;
    expect(first.flags.explain(TOWER_FLAG_ID)).toMatchObject({
      enabled: true,
      source: 'config',
      configValue: true,
    });
    const migratedText = readFileSync(join(tempDir, 'config.toml'), 'utf8');
    expect(migratedText).toContain('# user comment');
    expect(migratedText).toContain('default_model = "kimi-k2"');
    expect(migratedText).toContain('tower = true');

    writeFileSync(join(tempDir, 'config.toml'), '[experimental]\ntower = false\n', 'utf8');
    const second = bootDiskFlags({ env: { [MASTER_ENV]: '1' } });
    expect(second.startupTowerEnabled).toBe(false);
    await second.flags.ready;
    expect(second.flags.enabled(TOWER_FLAG_ID)).toBe(false);
    expect(readFileSync(join(tempDir, 'config.toml'), 'utf8')).toContain('tower = false');
  });

  it('preserves explicit tower = false or KIMI_CODE_EXPERIMENTAL_TOWER=0 on first run', async () => {
    writeFileSync(join(tempDir, 'config.toml'), '[experimental]\ntower = false\n', 'utf8');
    const fromConfig = bootDiskFlags({ env: { [MASTER_ENV]: '1' } });
    expect(fromConfig.startupTowerEnabled).toBe(false);
    await fromConfig.flags.ready;
    expect(readFileSync(join(tempDir, 'config.toml'), 'utf8')).toContain('tower = false');

    const envBlockedDir = mkdtempSync(join(tmpdir(), 'kimi-legacy-tower-env0-'));
    try {
      mkdirSync(join(envBlockedDir, 'sessions'));
      const first = bootDiskFlags({
        homeDir: envBlockedDir,
        env: { [MASTER_ENV]: '1', [TOWER_FLAG_ENV]: '0' },
      });
      expect(first.startupTowerEnabled).toBe(false);
      await first.flags.ready;
      expect(existsSync(join(envBlockedDir, EXPERIMENTAL_MIGRATIONS_FILENAME))).toBe(true);

      const second = bootDiskFlags({
        homeDir: envBlockedDir,
        env: { [MASTER_ENV]: '1' },
      });
      expect(second.startupTowerEnabled).toBe(false);
      await second.flags.ready;
      expect(existsSync(join(envBlockedDir, 'config.toml'))).toBe(false);
    } finally {
      rmSync(envBlockedDir, { recursive: true, force: true });
    }
  });

  it('keeps tower active in memory without stamping marker when config.toml has syntax errors, allowing retry after fix', async () => {
    const configPath = join(tempDir, 'config.toml');
    writeFileSync(configPath, '[experimental\nbroken =', 'utf8');

    const withoutMaster = bootDiskFlags({ env: {} });
    expect(withoutMaster.startupTowerEnabled).toBe(false);
    await withoutMaster.flags.ready;

    const brokenWithMaster = bootDiskFlags({ env: { [MASTER_ENV]: '1' } });
    expect(brokenWithMaster.startupTowerEnabled).toBe(true);
    await brokenWithMaster.flags.ready;
    expect(brokenWithMaster.flags.explain(TOWER_FLAG_ID)).toMatchObject({
      enabled: true,
      source: 'env',
      configValue: undefined,
    });
    expect(existsSync(join(tempDir, EXPERIMENTAL_MIGRATIONS_FILENAME))).toBe(false);

    writeFileSync(configPath, 'default_model = "kimi-k2"\n', 'utf8');
    const fixed = bootDiskFlags({ env: { [MASTER_ENV]: '1' } });
    expect(fixed.startupTowerEnabled).toBe(true);
    await fixed.flags.ready;
    expect(readFileSync(configPath, 'utf8')).toContain('tower = true');
    expect(existsSync(join(tempDir, EXPERIMENTAL_MIGRATIONS_FILENAME))).toBe(true);
  });

  it('keeps migration pending when master env is absent or false so a later master-enabled launch still migrates tower', async () => {
    const configPath = join(tempDir, 'config.toml');
    writeFileSync(configPath, 'default_model = "kimi-k2"\n', 'utf8');

    const unsetRun = bootDiskFlags({ env: {} });
    await unsetRun.flags.ready;
    const falseRun = bootDiskFlags({ env: { [MASTER_ENV]: '0' } });
    await falseRun.flags.ready;
    expect(existsSync(join(tempDir, EXPERIMENTAL_MIGRATIONS_FILENAME))).toBe(false);
    expect(readFileSync(configPath, 'utf8')).not.toContain('tower');

    const enabledRun = bootDiskFlags({ env: { [MASTER_ENV]: '1' } });
    expect(enabledRun.startupTowerEnabled).toBe(true);
    await enabledRun.flags.ready;
    expect(readFileSync(configPath, 'utf8')).toContain('tower = true');
  });

  it('keeps tower active in memory when config.toml cannot be written', async () => {
    mkdirSync(join(tempDir, 'sessions'));
    const blockerFile = join(tempDir, 'readonly-parent');
    writeFileSync(blockerFile, 'not-a-directory', 'utf8');
    const unwritableConfigPath = join(blockerFile, 'config.toml');

    for (const towerEnv of [undefined, '', 'placeholder']) {
      const run = bootDiskFlags({
        configPath: unwritableConfigPath,
        env: {
          [MASTER_ENV]: '1',
          ...(towerEnv === undefined ? {} : { [TOWER_FLAG_ENV]: towerEnv }),
        },
      });
      expect(run.startupTowerEnabled).toBe(true);
      await run.flags.ready;
      expect(run.flags.explain(TOWER_FLAG_ID)).toMatchObject({
        enabled: true,
        source: 'env',
        configValue: undefined,
      });
    }
    expect(existsSync(join(tempDir, 'config.toml'))).toBe(false);
    expect(existsSync(join(tempDir, EXPERIMENTAL_MIGRATIONS_FILENAME))).toBe(false);
  });

  it('leaves symlinked, read-only, dangling, and hard-linked config.toml untouched on disk while activating tower in memory', async () => {
    const dotfilesDir = mkdtempSync(join(tmpdir(), 'kimi-legacy-dotfiles-'));
    const readonlyHomeDir = mkdtempSync(join(tmpdir(), 'kimi-legacy-readonly-home-'));
    const danglingHomeDir = mkdtempSync(join(tmpdir(), 'kimi-legacy-dangling-link-'));
    const hardlinkHomeDir = mkdtempSync(join(tmpdir(), 'kimi-legacy-hardlink-home-'));
    const readonlyTarget = join(dotfilesDir, 'readonly-config.toml');
    try {
      const writableTarget = join(dotfilesDir, 'writable-config.toml');
      writeFileSync(writableTarget, 'default_model = "kimi-k2"\n', 'utf8');
      const symlinkConfig = join(tempDir, 'config.toml');
      symlinkSync(writableTarget, symlinkConfig);

      const symlinkRun = bootDiskFlags({ env: { [MASTER_ENV]: '1' } });
      expect(symlinkRun.startupTowerEnabled).toBe(true);
      await symlinkRun.flags.ready;
      expect(symlinkRun.flags.explain(TOWER_FLAG_ID)).toMatchObject({
        enabled: true,
        source: 'env',
      });
      expect(lstatSync(symlinkConfig).isSymbolicLink()).toBe(true);
      expect(readFileSync(writableTarget, 'utf8')).toBe('default_model = "kimi-k2"\n');

      writeFileSync(readonlyTarget, 'default_model = "kimi-k2"\n', 'utf8');
      chmodSync(readonlyTarget, 0o444);
      const readonlyLink = join(readonlyHomeDir, 'config.toml');
      symlinkSync(readonlyTarget, readonlyLink);

      const readonlyRun = bootDiskFlags({
        homeDir: readonlyHomeDir,
        env: { [MASTER_ENV]: '1' },
      });
      expect(readonlyRun.startupTowerEnabled).toBe(true);
      await readonlyRun.flags.ready;
      expect(lstatSync(readonlyLink).isSymbolicLink()).toBe(true);
      expect(readFileSync(readonlyTarget, 'utf8')).toBe('default_model = "kimi-k2"\n');

      const missingTarget = join(dotfilesDir, 'missing-config.toml');
      const danglingLink = join(danglingHomeDir, 'config.toml');
      symlinkSync(missingTarget, danglingLink);

      const danglingRun = bootDiskFlags({
        homeDir: danglingHomeDir,
        env: { [MASTER_ENV]: '1' },
      });
      expect(danglingRun.startupTowerEnabled).toBe(true);
      await danglingRun.flags.ready;
      expect(lstatSync(danglingLink).isSymbolicLink()).toBe(true);
      expect(existsSync(join(danglingHomeDir, EXPERIMENTAL_MIGRATIONS_FILENAME))).toBe(false);

      const hardlinkConfig = join(hardlinkHomeDir, 'config.toml');
      const dotfileHardlink = join(hardlinkHomeDir, 'dotfiles-config.toml');
      writeFileSync(hardlinkConfig, 'default_model = "kimi-k2"\n', 'utf8');
      linkSync(hardlinkConfig, dotfileHardlink);
      const originalIno = statSync(hardlinkConfig).ino;

      const hardlinkRun = bootDiskFlags({
        homeDir: hardlinkHomeDir,
        env: { [MASTER_ENV]: '1' },
      });
      expect(hardlinkRun.startupTowerEnabled).toBe(true);
      await hardlinkRun.flags.ready;
      expect(statSync(hardlinkConfig).ino).toBe(originalIno);
      expect(statSync(dotfileHardlink).ino).toBe(originalIno);
      expect(readFileSync(dotfileHardlink, 'utf8')).toBe('default_model = "kimi-k2"\n');
    } finally {
      try {
        chmodSync(readonlyTarget, 0o644);
      } catch {}
      rmSync(dotfilesDir, { recursive: true, force: true });
      rmSync(readonlyHomeDir, { recursive: true, force: true });
      rmSync(danglingHomeDir, { recursive: true, force: true });
      rmSync(hardlinkHomeDir, { recursive: true, force: true });
    }
  });

  it('tracks migration independently per configPath within the same homeDir', async () => {
    const defaultConfig = join(tempDir, 'config.toml');
    const secondaryConfig = join(tempDir, 'secondary.toml');
    writeFileSync(defaultConfig, 'default_model = "kimi-k2"\n', 'utf8');
    writeFileSync(secondaryConfig, 'default_model = "kimi-k2.5"\n', 'utf8');

    const first = bootDiskFlags({ env: { [MASTER_ENV]: '1' } });
    await first.flags.ready;
    expect(readFileSync(defaultConfig, 'utf8')).toContain('tower = true');
    expect(readFileSync(secondaryConfig, 'utf8')).not.toContain('tower');

    const second = bootDiskFlags({
      configPath: secondaryConfig,
      env: { [MASTER_ENV]: '1' },
    });
    expect(second.startupTowerEnabled).toBe(true);
    await second.flags.ready;
    expect(readFileSync(secondaryConfig, 'utf8')).toContain('tower = true');

    writeFileSync(secondaryConfig, '[experimental]\ntower = false\n', 'utf8');
    const third = bootDiskFlags({
      configPath: secondaryConfig,
      env: { [MASTER_ENV]: '1' },
    });
    expect(third.startupTowerEnabled).toBe(false);
    await third.flags.ready;
    expect(readFileSync(secondaryConfig, 'utf8')).toContain('tower = false');
  });

  it('rejects schema-invalid experimental values without stamping and keeps tower active in memory when master flag is set', async () => {
    const configPath = join(tempDir, 'config.toml');
    writeFileSync(configPath, '[experimental]\ntower = "yes"\n', 'utf8');

    const withoutMaster = bootDiskFlags({ env: {} });
    expect(withoutMaster.startupTowerEnabled).toBe(false);
    await withoutMaster.flags.ready;

    const invalidTower = bootDiskFlags({ env: { [MASTER_ENV]: '1' } });
    expect(invalidTower.startupTowerEnabled).toBe(true);
    await invalidTower.flags.ready;
    expect(invalidTower.flags.explain(TOWER_FLAG_ID)).toMatchObject({
      enabled: true,
      source: 'env',
    });
    expect(existsSync(join(tempDir, EXPERIMENTAL_MIGRATIONS_FILENAME))).toBe(false);

    writeFileSync(configPath, '[experimental]\nother = 123\n', 'utf8');
    const invalidKey = bootDiskFlags({ env: { [MASTER_ENV]: '1' } });
    expect(invalidKey.startupTowerEnabled).toBe(true);
    await invalidKey.flags.ready;
    expect(readFileSync(configPath, 'utf8')).not.toContain('tower');
    expect(existsSync(join(tempDir, EXPERIMENTAL_MIGRATIONS_FILENAME))).toBe(false);

    writeFileSync(configPath, '[experimental]\nother = 123\ntower = false\n', 'utf8');
    const invalidWithOptOut = bootDiskFlags({ env: { [MASTER_ENV]: '1' } });
    expect(invalidWithOptOut.startupTowerEnabled).toBe(false);
    await invalidWithOptOut.flags.ready;
    expect(invalidWithOptOut.flags.enabled(TOWER_FLAG_ID)).toBe(false);

    writeFileSync(configPath, '[experimental]\nnotify_user = true\n', 'utf8');
    const validLegacy = bootDiskFlags({ env: { [MASTER_ENV]: '1' } });
    expect(validLegacy.startupTowerEnabled).toBe(true);
    await validLegacy.flags.ready;
    expect(readFileSync(configPath, 'utf8')).toContain('tower = true');
  });

  it('keeps tower active in memory when experimental-migrations.json is malformed while honoring explicit tower opt-outs', async () => {
    const configPath = join(tempDir, 'config.toml');
    const markerPath = join(tempDir, EXPERIMENTAL_MIGRATIONS_FILENAME);
    writeFileSync(configPath, 'default_model = "kimi-k2"\n', 'utf8');
    writeFileSync(markerPath, '{truncated', 'utf8');

    const withoutMaster = bootDiskFlags({ env: {} });
    expect(withoutMaster.startupTowerEnabled).toBe(false);
    await withoutMaster.flags.ready;

    const withMaster = bootDiskFlags({ env: { [MASTER_ENV]: '1' } });
    expect(withMaster.startupTowerEnabled).toBe(true);
    await withMaster.flags.ready;
    expect(withMaster.flags.explain(TOWER_FLAG_ID)).toMatchObject({
      enabled: true,
      source: 'env',
    });
    expect(readFileSync(configPath, 'utf8')).not.toContain('tower');
    expect(readFileSync(markerPath, 'utf8')).toBe('{truncated');

    const envOptOut = bootDiskFlags({
      env: { [MASTER_ENV]: '1', [TOWER_FLAG_ENV]: '0' },
    });
    expect(envOptOut.startupTowerEnabled).toBe(false);
    await envOptOut.flags.ready;
    expect(envOptOut.flags.enabled(TOWER_FLAG_ID)).toBe(false);

    writeFileSync(configPath, '[experimental]\ntower = false\n', 'utf8');
    const configOptOut = bootDiskFlags({ env: { [MASTER_ENV]: '1' } });
    expect(configOptOut.startupTowerEnabled).toBe(false);
    await configOptOut.flags.ready;
    expect(configOptOut.flags.enabled(TOWER_FLAG_ID)).toBe(false);
  });

  it('re-reads config.toml through ConfigService and preserves concurrent edits made before committing the tower migration', async () => {
    const configPath = join(tempDir, 'config.toml');
    writeFileSync(configPath, 'default_model = "kimi-old"\n', 'utf8');

    const run = bootDiskFlags({ env: { [MASTER_ENV]: '1' } });
    writeFileSync(configPath, 'default_model = "kimi-new"\ntelemetry = false\n', 'utf8');
    await run.flags.ready;

    const finalText = readFileSync(configPath, 'utf8');
    expect(finalText).toContain('default_model = "kimi-new"');
    expect(finalText).toContain('telemetry = false');
    expect(finalText).toContain('tower = true');
  });

  it('does not persist tower = true into config.toml when KIMI_CODE_EXPERIMENTAL_TOWER=1 is explicitly set', async () => {
    const configPath = join(tempDir, 'config.toml');
    writeFileSync(configPath, 'default_model = "kimi-k2"\n', 'utf8');

    const first = bootDiskFlags({
      env: { [MASTER_ENV]: '1', [TOWER_FLAG_ENV]: '1' },
    });
    expect(first.startupTowerEnabled).toBe(true);
    await first.flags.ready;
    expect(readFileSync(configPath, 'utf8')).toBe('default_model = "kimi-k2"\n');

    const second = bootDiskFlags({ env: { [MASTER_ENV]: '1' } });
    expect(second.startupTowerEnabled).toBe(false);
    await second.flags.ready;
    expect(readFileSync(configPath, 'utf8')).toBe('default_model = "kimi-k2"\n');
  });

  it('migrates cli and desktop profiles into their own [experimental.<profile>] buckets independently', async () => {
    const configPath = join(tempDir, 'config.toml');
    writeFileSync(configPath, 'default_model = "kimi-k2"\n', 'utf8');

    const cliRun = bootDiskFlags({ env: { [MASTER_ENV]: '1' }, profile: 'cli' });
    await cliRun.flags.ready;
    const cliText = readFileSync(configPath, 'utf8');
    expect(cliText).toContain('[experimental.cli]');
    expect(cliText).not.toContain('[experimental.desktop]');

    const desktopRun = bootDiskFlags({ env: { [MASTER_ENV]: '1' }, profile: 'desktop' });
    expect(desktopRun.startupTowerEnabled).toBe(true);
    await desktopRun.flags.ready;
    const bothText = readFileSync(configPath, 'utf8');
    expect(bothText).toContain('[experimental.cli]');
    expect(bothText).toContain('[experimental.desktop]');
  });

  it('merges existing sibling profile stamps in experimental-migrations.json without dropping entries', async () => {
    const configPath = join(tempDir, 'config.toml');
    const markerPath = join(tempDir, EXPERIMENTAL_MIGRATIONS_FILENAME);
    const canonicalConfigKey = normalizeMigrationConfigKey(configPath);
    writeFileSync(configPath, 'default_model = "kimi-k2"\n', 'utf8');
    writeFileSync(
      markerPath,
      `${JSON.stringify(
        {
          legacyMasterEnvTowerMigratedProfiles: {
            desktop: { [canonicalConfigKey]: true },
          },
        },
        null,
        2,
      )}\n`,
      'utf8',
    );

    const cliRun = bootDiskFlags({ env: { [MASTER_ENV]: '1' }, profile: 'cli' });
    await cliRun.flags.ready;

    const merged = JSON.parse(readFileSync(markerPath, 'utf8')) as {
      legacyMasterEnvTowerMigratedProfiles?: Record<string, Record<string, boolean>>;
    };
    expect(merged.legacyMasterEnvTowerMigratedProfiles?.['desktop']?.[canonicalConfigKey]).toBe(
      true,
    );
    expect(merged.legacyMasterEnvTowerMigratedProfiles?.['cli']?.[canonicalConfigKey]).toBe(true);
  });

  it('aborts background migration writes cleanly if disposed before ConfigService.ready settles', async () => {
    const configPath = join(tempDir, 'config.toml');
    writeFileSync(configPath, 'default_model = "kimi-k2"\n', 'utf8');

    const run = bootDiskFlags({ env: { [MASTER_ENV]: '1' } });
    expect(run.startupTowerEnabled).toBe(true);
    run.store.dispose();
    await run.flags.ready;

    expect(existsSync(join(tempDir, EXPERIMENTAL_MIGRATIONS_FILENAME))).toBe(false);
    expect(readFileSync(configPath, 'utf8')).toBe('default_model = "kimi-k2"\n');
  });

  it('aligns ConfigChangedEvent experimental payload type with profile buckets', () => {
    const sampleEvent: WireConfigChangedEvent = {
      type: 'event.config.changed',
      changedFields: ['experimental'],
      config: {
        providers: {},
        experimental: {
          cli: { beta: true, wait_for: true },
          desktop: { context_inspector: true },
        },
      },
    };
    const experimental: ExperimentalConfig | undefined = sampleEvent.config.experimental;
    expect(experimental?.cli?.['wait_for']).toBe(true);
    expect(experimental?.desktop?.['context_inspector']).toBe(true);
  });
});

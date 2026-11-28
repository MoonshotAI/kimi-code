import {
  chmodSync,
  linkSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Worker } from 'node:worker_threads';

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
  migrateLegacyMasterEnvTower,
  resolveBootstrapEnvWithLegacyTowerMigration,
} from '#/app/flag/legacyMasterEnvMigration';
import { ILogService } from '#/_base/log/log';
import { IAtomicTomlDocumentStore } from '#/persistence/interface/atomicDocumentStore';
import { TomlAtomicDocumentStore } from '#/persistence/backends/node-fs/atomicDocumentStore';
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

describe('migrateLegacyMasterEnvTower', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'kimi-legacy-tower-migration-'));
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('stamps fresh installations without creating tower = true even when KIMI_CODE_EXPERIMENTAL_FLAG=1', () => {
    const outcome = migrateLegacyMasterEnvTower({
      homeDir: tempDir,
      env: { [MASTER_ENV]: '1' },
    });
    expect(outcome).toBe('stamped-fresh-install');
    expect(() => readFileSync(join(tempDir, 'config.toml'), 'utf8')).toThrow();
    const marker = JSON.parse(
      readFileSync(join(tempDir, EXPERIMENTAL_MIGRATIONS_FILENAME), 'utf8'),
    ) as { legacyMasterEnvTowerMigrated?: boolean };
    expect(marker.legacyMasterEnvTowerMigrated).toBe(true);
  });

  it('stamps both cli and desktop profiles when a fresh installation starts on Desktop first', () => {
    expect(
      migrateLegacyMasterEnvTower({
        homeDir: tempDir,
        profile: 'desktop',
      }),
    ).toBe('stamped-fresh-install');

    mkdirSync(join(tempDir, 'sessions'));
    writeFileSync(join(tempDir, 'config.toml'), 'default_model = "kimi-k2"\n', 'utf8');

    expect(
      migrateLegacyMasterEnvTower({
        homeDir: tempDir,
        env: { [MASTER_ENV]: '1' },
        profile: 'cli',
      }),
    ).toBe('already-migrated');
    expect(readFileSync(join(tempDir, 'config.toml'), 'utf8')).toBe('default_model = "kimi-k2"\n');
  });

  it('migrates existing installations with KIMI_CODE_EXPERIMENTAL_FLAG=1 once while preserving comments', () => {
    writeFileSync(
      join(tempDir, 'config.toml'),
      '# user comment\ndefault_model = "kimi-k2"\n',
      'utf8',
    );
    const first = migrateLegacyMasterEnvTower({
      homeDir: tempDir,
      env: { [MASTER_ENV]: '1' },
    });
    expect(first).toBe('migrated-tower');
    const migratedText = readFileSync(join(tempDir, 'config.toml'), 'utf8');
    expect(migratedText).toContain('# user comment');
    expect(migratedText).toContain('default_model = "kimi-k2"');
    expect(migratedText).toContain('tower = true');

    writeFileSync(
      join(tempDir, 'config.toml'),
      '[experimental]\ntower = false\n',
      'utf8',
    );
    const second = migrateLegacyMasterEnvTower({
      homeDir: tempDir,
      env: { [MASTER_ENV]: '1' },
    });
    expect(second).toBe('already-migrated');
    expect(readFileSync(join(tempDir, 'config.toml'), 'utf8')).toContain('tower = false');
  });

  it('preserves explicit tower = false or KIMI_CODE_EXPERIMENTAL_TOWER=0 on first run', () => {
    writeFileSync(
      join(tempDir, 'config.toml'),
      '[experimental]\ntower = false\n',
      'utf8',
    );
    expect(
      migrateLegacyMasterEnvTower({
        homeDir: tempDir,
        env: { [MASTER_ENV]: '1' },
      }),
    ).toBe('stamped-noop');
    expect(readFileSync(join(tempDir, 'config.toml'), 'utf8')).toContain('tower = false');

    const envBlockedDir = mkdtempSync(join(tmpdir(), 'kimi-legacy-tower-env0-'));
    try {
      mkdirSync(join(envBlockedDir, 'sessions'));
      expect(
        migrateLegacyMasterEnvTower({
          homeDir: envBlockedDir,
          env: { [MASTER_ENV]: '1', KIMI_CODE_EXPERIMENTAL_TOWER: '0' },
        }),
      ).toBe('stamped-noop');
    } finally {
      rmSync(envBlockedDir, { recursive: true, force: true });
    }
  });

  it('falls back to env override without stamping marker when config.toml has syntax errors, allowing retry after fix', () => {
    const configPath = join(tempDir, 'config.toml');
    writeFileSync(configPath, '[experimental\nbroken =', 'utf8');

    expect(
      migrateLegacyMasterEnvTower({
        homeDir: tempDir,
        env: {},
      }),
    ).toBe('skipped-error');

    expect(
      migrateLegacyMasterEnvTower({
        homeDir: tempDir,
        env: { [MASTER_ENV]: '1' },
      }),
    ).toBe('fallback-env');
    const resolvedEnv = resolveBootstrapEnvWithLegacyTowerMigration({
      homeDir: tempDir,
      env: { [MASTER_ENV]: '1' },
    });
    expect(resolvedEnv?.['KIMI_CODE_EXPERIMENTAL_TOWER']).toBe('1');
    expect(() =>
      readFileSync(join(tempDir, EXPERIMENTAL_MIGRATIONS_FILENAME), 'utf8'),
    ).toThrow();

    writeFileSync(configPath, 'default_model = "kimi-k2"\n', 'utf8');
    expect(
      migrateLegacyMasterEnvTower({
        homeDir: tempDir,
        env: { [MASTER_ENV]: '1' },
      }),
    ).toBe('migrated-tower');
    expect(readFileSync(configPath, 'utf8')).toContain('tower = true');
  });

  it('keeps migration pending when master env is absent or false so a later master-enabled launch still migrates tower', () => {
    const configPath = join(tempDir, 'config.toml');
    writeFileSync(configPath, 'default_model = "kimi-k2"\n', 'utf8');

    expect(
      migrateLegacyMasterEnvTower({
        homeDir: tempDir,
        env: {},
      }),
    ).toBe('pending-master-env');
    expect(
      migrateLegacyMasterEnvTower({
        homeDir: tempDir,
        env: { [MASTER_ENV]: '0' },
      }),
    ).toBe('pending-master-env');
    expect(() =>
      readFileSync(join(tempDir, EXPERIMENTAL_MIGRATIONS_FILENAME), 'utf8'),
    ).toThrow();
    expect(readFileSync(configPath, 'utf8')).not.toContain('tower');

    expect(
      migrateLegacyMasterEnvTower({
        homeDir: tempDir,
        env: { [MASTER_ENV]: '1' },
      }),
    ).toBe('migrated-tower');
    expect(readFileSync(configPath, 'utf8')).toContain('tower = true');
  });

  it('falls back to process env Tower override when config.toml cannot be written', () => {
    mkdirSync(join(tempDir, 'sessions'));
    const blockerFile = join(tempDir, 'readonly-parent');
    writeFileSync(blockerFile, 'not-a-directory', 'utf8');
    const unwritableConfigPath = join(blockerFile, 'config.toml');

    expect(
      migrateLegacyMasterEnvTower({
        homeDir: tempDir,
        configPath: unwritableConfigPath,
        env: { [MASTER_ENV]: '1' },
      }),
    ).toBe('fallback-env');

    const resolvedEnv = resolveBootstrapEnvWithLegacyTowerMigration({
      homeDir: tempDir,
      configPath: unwritableConfigPath,
      env: { [MASTER_ENV]: '1' },
    });
    expect(resolvedEnv?.['KIMI_CODE_EXPERIMENTAL_TOWER']).toBe('1');

    const emptyTowerEnv = resolveBootstrapEnvWithLegacyTowerMigration({
      homeDir: tempDir,
      configPath: unwritableConfigPath,
      env: { [MASTER_ENV]: '1', KIMI_CODE_EXPERIMENTAL_TOWER: '' },
    });
    expect(emptyTowerEnv?.['KIMI_CODE_EXPERIMENTAL_TOWER']).toBe('1');

    const unparsedTowerEnv = resolveBootstrapEnvWithLegacyTowerMigration({
      homeDir: tempDir,
      configPath: unwritableConfigPath,
      env: { [MASTER_ENV]: '1', KIMI_CODE_EXPERIMENTAL_TOWER: 'placeholder' },
    });
    expect(unparsedTowerEnv?.['KIMI_CODE_EXPERIMENTAL_TOWER']).toBe('1');
  });

  it('updates the symlink target and preserves symlinked config.toml during migration', () => {
    const dotfilesDir = mkdtempSync(join(tmpdir(), 'kimi-legacy-dotfiles-'));
    try {
      const targetConfigPath = join(dotfilesDir, 'config.toml');
      writeFileSync(targetConfigPath, 'default_model = "kimi-k2"\n', 'utf8');
      const linkConfigPath = join(tempDir, 'config.toml');
      symlinkSync(targetConfigPath, linkConfigPath);

      expect(
        migrateLegacyMasterEnvTower({
          homeDir: tempDir,
          env: { [MASTER_ENV]: '1' },
        }),
      ).toBe('migrated-tower');

      expect(lstatSync(linkConfigPath).isSymbolicLink()).toBe(true);
      const targetText = readFileSync(targetConfigPath, 'utf8');
      expect(targetText).toContain('default_model = "kimi-k2"');
      expect(targetText).toContain('tower = true');

      writeFileSync(
        targetConfigPath,
        'default_model = "kimi-k2.5"\n[experimental]\ntower = true\n',
        'utf8',
      );
      expect(readFileSync(linkConfigPath, 'utf8')).toContain('default_model = "kimi-k2.5"');
    } finally {
      rmSync(dotfilesDir, { recursive: true, force: true });
    }
  });

  it('preserves read-only and dangling config.toml symlinks and falls back to env override', () => {
    const readonlyStoreDir = mkdtempSync(join(tmpdir(), 'kimi-legacy-readonly-link-'));
    const danglingHomeDir = mkdtempSync(join(tmpdir(), 'kimi-legacy-dangling-link-'));
    const readonlyTarget = join(readonlyStoreDir, 'config.toml');
    try {
      writeFileSync(readonlyTarget, 'default_model = "kimi-k2"\n', 'utf8');
      chmodSync(readonlyTarget, 0o444);
      const readonlyLink = join(tempDir, 'config.toml');
      symlinkSync(readonlyTarget, readonlyLink);

      const readonlyResolvedEnv = resolveBootstrapEnvWithLegacyTowerMigration({
        homeDir: tempDir,
        env: { [MASTER_ENV]: '1' },
      });
      expect(readonlyResolvedEnv?.['KIMI_CODE_EXPERIMENTAL_TOWER']).toBe('1');
      expect(lstatSync(readonlyLink).isSymbolicLink()).toBe(true);
      expect(readFileSync(readonlyTarget, 'utf8')).not.toContain('tower');

      const missingTarget = join(readonlyStoreDir, 'missing-config.toml');
      const danglingLink = join(danglingHomeDir, 'config.toml');
      symlinkSync(missingTarget, danglingLink);

      const danglingResolvedEnv = resolveBootstrapEnvWithLegacyTowerMigration({
        homeDir: danglingHomeDir,
        env: { [MASTER_ENV]: '1' },
      });
      expect(danglingResolvedEnv?.['KIMI_CODE_EXPERIMENTAL_TOWER']).toBe('1');
      expect(lstatSync(danglingLink).isSymbolicLink()).toBe(true);
      expect(() =>
        readFileSync(join(danglingHomeDir, EXPERIMENTAL_MIGRATIONS_FILENAME), 'utf8'),
      ).toThrow();

      writeFileSync(missingTarget, 'default_model = "kimi-k2"\n', 'utf8');
      expect(
        migrateLegacyMasterEnvTower({
          homeDir: danglingHomeDir,
          env: { [MASTER_ENV]: '1' },
        }),
      ).toBe('migrated-tower');
      expect(lstatSync(danglingLink).isSymbolicLink()).toBe(true);
      expect(readFileSync(missingTarget, 'utf8')).toContain('tower = true');
    } finally {
      try {
        chmodSync(readonlyTarget, 0o644);
      } catch {}
      rmSync(readonlyStoreDir, { recursive: true, force: true });
      rmSync(danglingHomeDir, { recursive: true, force: true });
    }
  });

  it('tracks migration independently per configPath within the same homeDir', () => {
    const defaultConfig = join(tempDir, 'config.toml');
    const secondaryConfig = join(tempDir, 'secondary.toml');
    writeFileSync(defaultConfig, 'default_model = "kimi-k2"\n', 'utf8');
    writeFileSync(secondaryConfig, 'default_model = "kimi-k2.5"\n', 'utf8');

    expect(
      migrateLegacyMasterEnvTower({
        homeDir: tempDir,
        env: { [MASTER_ENV]: '1' },
      }),
    ).toBe('migrated-tower');
    expect(readFileSync(defaultConfig, 'utf8')).toContain('tower = true');
    expect(readFileSync(secondaryConfig, 'utf8')).not.toContain('tower');

    expect(
      migrateLegacyMasterEnvTower({
        homeDir: tempDir,
        configPath: secondaryConfig,
        env: { [MASTER_ENV]: '1' },
      }),
    ).toBe('migrated-tower');
    expect(readFileSync(secondaryConfig, 'utf8')).toContain('tower = true');

    expect(
      migrateLegacyMasterEnvTower({
        homeDir: tempDir,
        configPath: secondaryConfig,
        env: { [MASTER_ENV]: '1' },
      }),
    ).toBe('already-migrated');
  });

  it('rejects schema-invalid experimental values without stamping and falls back to env when master flag is set', () => {
    const configPath = join(tempDir, 'config.toml');
    writeFileSync(configPath, '[experimental]\ntower = "yes"\n', 'utf8');

    expect(
      migrateLegacyMasterEnvTower({
        homeDir: tempDir,
        env: {},
      }),
    ).toBe('skipped-error');
    expect(
      migrateLegacyMasterEnvTower({
        homeDir: tempDir,
        env: { [MASTER_ENV]: '1' },
      }),
    ).toBe('fallback-env');
    expect(
      resolveBootstrapEnvWithLegacyTowerMigration({
        homeDir: tempDir,
        env: { [MASTER_ENV]: '1' },
      })?.['KIMI_CODE_EXPERIMENTAL_TOWER'],
    ).toBe('1');
    expect(() =>
      readFileSync(join(tempDir, EXPERIMENTAL_MIGRATIONS_FILENAME), 'utf8'),
    ).toThrow();

    writeFileSync(configPath, '[experimental]\nother = 123\n', 'utf8');
    expect(
      migrateLegacyMasterEnvTower({
        homeDir: tempDir,
        env: { [MASTER_ENV]: '1' },
      }),
    ).toBe('fallback-env');
    expect(readFileSync(configPath, 'utf8')).not.toContain('tower');
    expect(() =>
      readFileSync(join(tempDir, EXPERIMENTAL_MIGRATIONS_FILENAME), 'utf8'),
    ).toThrow();

    writeFileSync(configPath, '[experimental]\nnotify_user = true\n', 'utf8');
    expect(
      migrateLegacyMasterEnvTower({
        homeDir: tempDir,
        env: { [MASTER_ENV]: '1' },
      }),
    ).toBe('migrated-tower');
    expect(readFileSync(configPath, 'utf8')).toContain('tower = true');
  });

  it('falls back to env override when experimental-migrations.json is malformed while honoring explicit tower opt-outs', () => {
    const configPath = join(tempDir, 'config.toml');
    const markerPath = join(tempDir, EXPERIMENTAL_MIGRATIONS_FILENAME);
    writeFileSync(configPath, 'default_model = "kimi-k2"\n', 'utf8');
    writeFileSync(markerPath, '{truncated', 'utf8');

    expect(
      migrateLegacyMasterEnvTower({
        homeDir: tempDir,
        env: {},
      }),
    ).toBe('skipped-error');
    expect(
      migrateLegacyMasterEnvTower({
        homeDir: tempDir,
        env: { [MASTER_ENV]: '1' },
      }),
    ).toBe('fallback-env');
    expect(
      resolveBootstrapEnvWithLegacyTowerMigration({
        homeDir: tempDir,
        env: { [MASTER_ENV]: '1' },
      })?.['KIMI_CODE_EXPERIMENTAL_TOWER'],
    ).toBe('1');
    expect(readFileSync(configPath, 'utf8')).not.toContain('tower');
    expect(readFileSync(markerPath, 'utf8')).toBe('{truncated');

    expect(
      resolveBootstrapEnvWithLegacyTowerMigration({
        homeDir: tempDir,
        env: { [MASTER_ENV]: '1', KIMI_CODE_EXPERIMENTAL_TOWER: '0' },
      })?.['KIMI_CODE_EXPERIMENTAL_TOWER'],
    ).toBe('0');

    writeFileSync(configPath, '[experimental]\ntower = false\n', 'utf8');
    expect(
      migrateLegacyMasterEnvTower({
        homeDir: tempDir,
        env: { [MASTER_ENV]: '1' },
      }),
    ).toBe('skipped-error');
    expect(
      resolveBootstrapEnvWithLegacyTowerMigration({
        homeDir: tempDir,
        env: { [MASTER_ENV]: '1' },
      })?.['KIMI_CODE_EXPERIMENTAL_TOWER'],
    ).toBeUndefined();
  });

  it('falls back to env override without breaking hard-linked config.toml', () => {
    const configPath = join(tempDir, 'config.toml');
    const dotfileLinkPath = join(tempDir, 'dotfiles-config.toml');
    writeFileSync(configPath, 'default_model = "kimi-k2"\n', 'utf8');
    linkSync(configPath, dotfileLinkPath);
    const originalIno = statSync(configPath).ino;

    expect(
      migrateLegacyMasterEnvTower({
        homeDir: tempDir,
        env: { [MASTER_ENV]: '1' },
      }),
    ).toBe('fallback-env');
    expect(
      resolveBootstrapEnvWithLegacyTowerMigration({
        homeDir: tempDir,
        env: { [MASTER_ENV]: '1' },
      })?.['KIMI_CODE_EXPERIMENTAL_TOWER'],
    ).toBe('1');
    expect(statSync(configPath).ino).toBe(originalIno);
    expect(statSync(dotfileLinkPath).ino).toBe(originalIno);
    expect(readFileSync(dotfileLinkPath, 'utf8')).toBe('default_model = "kimi-k2"\n');
  });

  it('re-reads config.toml and preserves concurrent edits made before committing the tower migration', () => {
    const configPath = join(tempDir, 'config.toml');
    writeFileSync(configPath, 'default_model = "kimi-old"\n', 'utf8');

    const outcome = migrateLegacyMasterEnvTower({
      homeDir: tempDir,
      env: { [MASTER_ENV]: '1' },
      onBeforeWrite: (attempt) => {
        if (attempt === 0) {
          writeFileSync(
            configPath,
            'default_model = "kimi-new"\ntelemetry = false\n',
            'utf8',
          );
        }
      },
    });

    expect(outcome).toBe('migrated-tower');
    const finalText = readFileSync(configPath, 'utf8');
    expect(finalText).toContain('default_model = "kimi-new"');
    expect(finalText).toContain('telemetry = false');
    expect(finalText).toContain('tower = true');
  });

  it('does not persist tower = true into config.toml when KIMI_CODE_EXPERIMENTAL_TOWER=1 is explicitly set', () => {
    const configPath = join(tempDir, 'config.toml');
    writeFileSync(configPath, 'default_model = "kimi-k2"\n', 'utf8');

    expect(
      migrateLegacyMasterEnvTower({
        homeDir: tempDir,
        env: { [MASTER_ENV]: '1', KIMI_CODE_EXPERIMENTAL_TOWER: '1' },
      }),
    ).toBe('stamped-noop');
    expect(readFileSync(configPath, 'utf8')).toBe('default_model = "kimi-k2"\n');
    expect(
      resolveBootstrapEnvWithLegacyTowerMigration({
        homeDir: tempDir,
        env: { [MASTER_ENV]: '1', KIMI_CODE_EXPERIMENTAL_TOWER: '1' },
      })?.['KIMI_CODE_EXPERIMENTAL_TOWER'],
    ).toBe('1');
    expect(
      migrateLegacyMasterEnvTower({
        homeDir: tempDir,
        env: { [MASTER_ENV]: '1' },
      }),
    ).toBe('already-migrated');
    expect(readFileSync(configPath, 'utf8')).toBe('default_model = "kimi-k2"\n');
  });

  it('migrates cli and desktop profiles into their own [experimental.<profile>] buckets independently', () => {
    const configPath = join(tempDir, 'config.toml');
    writeFileSync(configPath, 'default_model = "kimi-k2"\n', 'utf8');

    expect(
      migrateLegacyMasterEnvTower({
        homeDir: tempDir,
        env: { [MASTER_ENV]: '1' },
        profile: 'cli',
      }),
    ).toBe('migrated-tower');
    const cliText = readFileSync(configPath, 'utf8');
    expect(cliText).toContain('[experimental.cli]');
    expect(cliText).not.toContain('[experimental.desktop]');

    expect(
      migrateLegacyMasterEnvTower({
        homeDir: tempDir,
        env: { [MASTER_ENV]: '1' },
        profile: 'desktop',
      }),
    ).toBe('migrated-tower');
    const bothText = readFileSync(configPath, 'utf8');
    expect(bothText).toContain('[experimental.cli]');
    expect(bothText).toContain('[experimental.desktop]');
  });

  it('serializes concurrent fresh-install marker stamps so neither cli nor desktop loses its stamp', async () => {
    const markerPath = join(tempDir, EXPERIMENTAL_MIGRATIONS_FILENAME);
    const canonicalConfigKey = join(realpathSync(tempDir), 'config.toml');
    const syncState = new Int32Array(new SharedArrayBuffer(8));

    const worker = new Worker(
      `
      const { writeFileSync } = require('node:fs');
      const { workerData } = require('node:worker_threads');
      const lockfile = require('proper-lockfile');
      const state = new Int32Array(workerData.buffer);
      const release = lockfile.lockSync(workerData.markerPath, {
        realpath: false,
        lockfilePath: workerData.markerPath + '.lock',
      });
      writeFileSync(
        workerData.markerPath,
        JSON.stringify({
          legacyMasterEnvTowerMigratedProfiles: {
            desktop: { [workerData.configKey]: true },
          },
        }, null, 2) + '\\n',
        'utf8',
      );
      Atomics.store(state, 0, 1);
      Atomics.notify(state, 0);
      Atomics.wait(state, 1, 0, 25);
      release();
      `,
      {
        eval: true,
        workerData: {
          buffer: syncState.buffer,
          markerPath,
          configKey: canonicalConfigKey,
        },
      },
    );

    try {
      while (Atomics.load(syncState, 0) === 0) {
        Atomics.wait(syncState, 0, 0, 10);
      }
      expect(
        migrateLegacyMasterEnvTower({
          homeDir: tempDir,
          profile: 'cli',
        }),
      ).toBe('stamped-fresh-install');
    } finally {
      await worker.terminate();
    }

    mkdirSync(join(tempDir, 'sessions'));
    expect(
      migrateLegacyMasterEnvTower({
        homeDir: tempDir,
        env: { [MASTER_ENV]: '1' },
        profile: 'cli',
      }),
    ).toBe('already-migrated');
    expect(
      migrateLegacyMasterEnvTower({
        homeDir: tempDir,
        env: { [MASTER_ENV]: '1' },
        profile: 'desktop',
      }),
    ).toBe('already-migrated');
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

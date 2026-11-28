import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
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
import {
  EXPERIMENTAL_MIGRATIONS_FILENAME,
  FlagService,
  MASTER_ENV,
} from '#/app/flag/flagService';
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

describe('FlagService legacy tower migration', () => {
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
    const store = new DisposableStore();
    disposables.add(store);
    const ix = store.add(new TestInstantiationService());
    ix.stub(IBootstrapService, {
      ...base,
      configPath: targetConfigPath,
      configKey: basename(targetConfigPath),
    });
    ix.stub(ILogService, stubLog());
    ix.stub(IFileSystemStorageService, new FileStorageService(targetHome));
    ix.set(IAtomicTomlDocumentStore, new SyncDescriptor(TomlAtomicDocumentStore));
    ix.set(IConfigRegistry, new SyncDescriptor(ConfigRegistry));
    ix.set(IConfigService, new SyncDescriptor(ConfigService));
    ix.set(IFlagRegistry, new SyncDescriptor(FlagRegistryService));
    ix.set(IFlagService, new SyncDescriptor(FlagService));
    ix.get(IFlagRegistry).register(towerTestFlag);
    const flags = ix.get(IFlagService);
    return { store, flags, startupTowerEnabled: flags.enabled(TOWER_FLAG_ID) };
  }

  it('stamps both profiles on fresh install without enabling tower', async () => {
    const first = bootDiskFlags({ env: { [MASTER_ENV]: '1' }, profile: 'desktop' });
    expect(first.startupTowerEnabled).toBe(false);
    await first.flags.ready;
    expect(existsSync(join(tempDir, 'config.toml'))).toBe(false);

    mkdirSync(join(tempDir, 'sessions'));
    writeFileSync(join(tempDir, 'config.toml'), 'default_model = "kimi-k2"\n', 'utf8');

    const second = bootDiskFlags({ env: { [MASTER_ENV]: '1' }, profile: 'cli' });
    expect(second.startupTowerEnabled).toBe(false);
    await second.flags.ready;
    expect(readFileSync(join(tempDir, 'config.toml'), 'utf8')).toBe('default_model = "kimi-k2"\n');
  });

  it('migrates existing installations per profile via ConfigService while preserving comments and subsequent opt-outs', async () => {
    const configPath = join(tempDir, 'config.toml');
    writeFileSync(configPath, '# user comment\ndefault_model = "kimi-k2"\n', 'utf8');

    const pendingRun = bootDiskFlags({ env: { [MASTER_ENV]: '0' } });
    await pendingRun.flags.ready;
    expect(existsSync(join(tempDir, EXPERIMENTAL_MIGRATIONS_FILENAME))).toBe(false);

    const cliRun = bootDiskFlags({ env: { [MASTER_ENV]: '1' }, profile: 'cli' });
    expect(cliRun.startupTowerEnabled).toBe(true);
    await cliRun.flags.ready;
    expect(cliRun.flags.explain(TOWER_FLAG_ID)).toMatchObject({
      enabled: true,
      source: 'config',
      configValue: true,
    });
    const cliText = readFileSync(configPath, 'utf8');
    expect(cliText).toContain('# user comment');
    expect(cliText).toContain('[experimental.cli]');
    expect(cliText).not.toContain('[experimental.desktop]');

    const desktopRun = bootDiskFlags({ env: { [MASTER_ENV]: '1' }, profile: 'desktop' });
    expect(desktopRun.startupTowerEnabled).toBe(true);
    await desktopRun.flags.ready;
    expect(readFileSync(configPath, 'utf8')).toContain('[experimental.desktop]');

    writeFileSync(configPath, '[experimental]\ntower = false\n', 'utf8');
    const afterOptOut = bootDiskFlags({ env: { [MASTER_ENV]: '1' }, profile: 'cli' });
    expect(afterOptOut.startupTowerEnabled).toBe(false);
    await afterOptOut.flags.ready;
    expect(readFileSync(configPath, 'utf8')).toContain('tower = false');
  });

  it('respects explicit tower config and TOWER env overrides without rewriting config.toml', async () => {
    const configPath = join(tempDir, 'config.toml');
    writeFileSync(configPath, 'default_model = "kimi-k2"\n', 'utf8');

    const envOn = bootDiskFlags({ env: { [MASTER_ENV]: '1', [TOWER_FLAG_ENV]: '1' } });
    expect(envOn.startupTowerEnabled).toBe(true);
    await envOn.flags.ready;
    expect(readFileSync(configPath, 'utf8')).toBe('default_model = "kimi-k2"\n');

    const nextRun = bootDiskFlags({ env: { [MASTER_ENV]: '1' } });
    expect(nextRun.startupTowerEnabled).toBe(false);
    await nextRun.flags.ready;
    expect(readFileSync(configPath, 'utf8')).toBe('default_model = "kimi-k2"\n');
  });

  it('keeps tower active in memory without stamping when config.toml is invalid or symlinked, and recovers once fixed', async () => {
    const configPath = join(tempDir, 'config.toml');
    writeFileSync(configPath, '[experimental\nbroken =', 'utf8');

    const broken = bootDiskFlags({ env: { [MASTER_ENV]: '1' } });
    expect(broken.startupTowerEnabled).toBe(true);
    await broken.flags.ready;
    expect(broken.flags.explain(TOWER_FLAG_ID)).toMatchObject({
      enabled: true,
      source: 'env',
      configValue: undefined,
    });
    expect(existsSync(join(tempDir, EXPERIMENTAL_MIGRATIONS_FILENAME))).toBe(false);

    rmSync(configPath);
    const dotfileTarget = join(tempDir, 'dotfiles-config.toml');
    writeFileSync(dotfileTarget, 'default_model = "kimi-k2"\n', 'utf8');
    symlinkSync(dotfileTarget, configPath);

    const symlinked = bootDiskFlags({ env: { [MASTER_ENV]: '1' } });
    expect(symlinked.startupTowerEnabled).toBe(true);
    await symlinked.flags.ready;
    expect(lstatSync(configPath).isSymbolicLink()).toBe(true);
    expect(readFileSync(dotfileTarget, 'utf8')).toBe('default_model = "kimi-k2"\n');

    rmSync(configPath);
    writeFileSync(configPath, 'default_model = "kimi-k2"\n', 'utf8');
    const fixed = bootDiskFlags({ env: { [MASTER_ENV]: '1' } });
    await fixed.flags.ready;
    expect(readFileSync(configPath, 'utf8')).toContain('tower = true');
  });

  it('aborts background writes cleanly if disposed before ConfigService.ready settles', async () => {
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

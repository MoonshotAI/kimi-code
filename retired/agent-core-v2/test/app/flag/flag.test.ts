import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { SyncDescriptor } from '#/_base/di/descriptors';
import { DisposableStore } from '#/_base/di/lifecycle';
import { TestInstantiationService } from '#/_base/di/test';
import { IBootstrapService } from '#/app/bootstrap/bootstrap';
import { IConfigRegistry, IConfigService } from '#/app/config/config';
import { ConfigRegistry, ConfigService } from '#/app/config/configService';
import {
  EXPERIMENTAL_SECTION,
  IFlagService,
} from '#/app/flag/flag';
import { IFlagRegistry, type FlagDefinitionInput } from '#/app/flag/flagRegistry';
import { FlagRegistryService } from '#/app/flag/flagRegistryService';
import { FlagService, MASTER_ENV } from '#/app/flag/flagService';
import { ILogService } from '#/_base/log/log';
import { IAtomicTomlDocumentStore } from '#/persistence/interface/atomicDocumentStore';
import { TomlAtomicDocumentStore } from '#/persistence/backends/node-fs/atomicDocumentStore';
import { InMemoryStorageService } from '#/persistence/backends/memory/inMemoryStorageService';
import { IFileSystemStorageService } from '#/persistence/interface/storage';

import { stubBootstrap } from '../bootstrap/stubs';
import { stubLog } from '../../_base/log/stubs';

const exampleFlag: FlagDefinitionInput = {
  id: 'example_flag',
  title: 'Example flag',
  description: 'Example experimental flag used to exercise the flag registry.',
  env: 'KIMI_CODE_EXPERIMENTAL_EXAMPLE_FLAG',
  default: true,
  surface: 'core',
};

describe('FlagRegistryService', () => {
  it('registers and resolves by id', () => {
    const reg = new FlagRegistryService();
    reg.register(exampleFlag);
    expect(reg.list().map((d) => d.id)).toEqual(['example_flag']);
    expect(reg.get('example_flag')?.env).toBe('KIMI_CODE_EXPERIMENTAL_EXAMPLE_FLAG');
  });

  it('returns undefined for an unknown id', () => {
    const reg = new FlagRegistryService();
    expect(reg.get('does_not_exist')).toBeUndefined();
  });

  it('throws on a duplicate id', () => {
    const reg = new FlagRegistryService();
    reg.register(exampleFlag);
    expect(() => reg.register(exampleFlag)).toThrow();
  });

  it('unregisters when the returned disposable is disposed', () => {
    const reg = new FlagRegistryService();
    const handle = reg.register(exampleFlag);
    handle.dispose();
    expect(reg.get('example_flag')).toBeUndefined();
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

  function makeFlags(env: Readonly<Record<string, string | undefined>> = {}) {
    const ix = disposables.add(new TestInstantiationService());
    ix.stub(IBootstrapService, stubBootstrap(homeDir, env));
    ix.stub(ILogService, stubLog());
    ix.stub(IFileSystemStorageService, new InMemoryStorageService());
    ix.set(IAtomicTomlDocumentStore, new SyncDescriptor(TomlAtomicDocumentStore));
    ix.set(IConfigRegistry, new SyncDescriptor(ConfigRegistry));
    ix.set(IConfigService, new SyncDescriptor(ConfigService));
    ix.set(IFlagRegistry, new SyncDescriptor(FlagRegistryService));
    ix.set(IFlagService, new SyncDescriptor(FlagService));
    ix.get(IFlagRegistry).register(exampleFlag);
    return {
      registry: ix.get(IConfigRegistry),
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

  it('resolves the registry default when nothing overrides it', () => {
    const { flags } = makeFlags();
    const state = flags.explain('example_flag');
    expect(state?.enabled).toBe(true);
    expect(state?.source).toBe('default');
    expect(flags.enabled('example_flag')).toBe(true);
  });

  it('returns undefined for an unregistered flag', () => {
    const { flags } = makeFlags();
    expect(flags.explain('does_not_exist')).toBeUndefined();
    expect(flags.enabled('does_not_exist')).toBe(false);
  });

  it('applies config overrides above the default', async () => {
    const { config, flags } = makeFlags();
    await config.set(EXPERIMENTAL_SECTION, { example_flag: false });
    const state = flags.explain('example_flag');
    expect(state?.enabled).toBe(false);
    expect(state?.source).toBe('config');
    expect(state?.configValue).toBe(false);
  });

  it('lets per-feature env override config', async () => {
    const { config, flags } = makeFlags({
      KIMI_CODE_EXPERIMENTAL_EXAMPLE_FLAG: 'true',
    });
    await config.set(EXPERIMENTAL_SECTION, { example_flag: false });
    const state = flags.explain('example_flag');
    expect(state?.enabled).toBe(true);
    expect(state?.source).toBe('env');
    expect(state?.configValue).toBe(false);
  });

  it('lets the master env switch force every flag on', async () => {
    const { config, flags } = makeFlags({ [MASTER_ENV]: '1' });
    await config.set(EXPERIMENTAL_SECTION, { example_flag: false });
    const state = flags.explain('example_flag');
    expect(state?.enabled).toBe(true);
    expect(state?.source).toBe('master-env');
  });

  it('refreshes overrides when the experimental config section changes', async () => {
    const { config, flags } = makeFlags();
    expect(flags.enabled('example_flag')).toBe(true);
    await config.set(EXPERIMENTAL_SECTION, { example_flag: false });
    expect(flags.enabled('example_flag')).toBe(false);
    await config.set(EXPERIMENTAL_SECTION, { example_flag: true });
    expect(flags.enabled('example_flag')).toBe(true);
  });

  it('ignores unrelated config section changes', async () => {
    const { config, flags } = makeFlags();
    await config.set('agent', { modelAlias: 'k2' });
    expect(flags.explain('example_flag')?.source).toBe('default');
  });

  it('supports imperative setConfigOverrides', () => {
    const { flags } = makeFlags();
    flags.setConfigOverrides({ example_flag: false });
    expect(flags.enabled('example_flag')).toBe(false);
    flags.setConfigOverrides(undefined);
    expect(flags.enabled('example_flag')).toBe(true);
  });

  it('exposes snapshot / enabledIds / explainAll', () => {
    const { flags } = makeFlags();
    expect(flags.snapshot()).toEqual({ example_flag: true });
    expect(flags.enabledIds()).toEqual(['example_flag']);
    expect(flags.explainAll().map((s) => s.id)).toEqual(['example_flag']);
  });

  it('treats truthy env values case-insensitively', () => {
    const { flags } = makeFlags({ KIMI_CODE_EXPERIMENTAL_EXAMPLE_FLAG: 'YES' });
    expect(flags.enabled('example_flag')).toBe(true);
  });

  it('treats falsy env values case-insensitively', () => {
    const { flags } = makeFlags({ KIMI_CODE_EXPERIMENTAL_EXAMPLE_FLAG: 'off' });
    expect(flags.enabled('example_flag')).toBe(false);
  });

  it('reads only the env name declared in the registry', () => {
    const { flags } = makeFlags({ KIMI_CODE_EXPERIMENTAL_UNKNOWN: 'false' });
    expect(flags.enabled('example_flag')).toBe(true);
  });

  it('ignores garbage env values', () => {
    const { flags } = makeFlags({ KIMI_CODE_EXPERIMENTAL_EXAMPLE_FLAG: 'maybe' });
    expect(flags.enabled('example_flag')).toBe(true);
  });

  it('ignores obsolete config ids outside the registry', async () => {
    const { config, flags } = makeFlags();
    await config.set(EXPERIMENTAL_SECTION, {
      obsolete_flag: false,
      example_flag: false,
    });

    expect(flags.snapshot()).toEqual({ example_flag: false });
    expect(flags.explain('obsolete_flag')).toBeUndefined();
  });
});

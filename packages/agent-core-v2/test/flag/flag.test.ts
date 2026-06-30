import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { SyncDescriptor } from '#/_base/di/descriptors';
import { DisposableStore } from '#/_base/di/lifecycle';
import { TestInstantiationService } from '#/_base/di/test';
import { IBootstrapService } from '#/bootstrap/bootstrapContract';
import { IConfigRegistry, IConfigService } from '#/config/config';
import { ConfigRegistry, ConfigService } from '#/config/configService';
import {
  EXPERIMENTAL_SECTION,
  IFlagService,
} from '#/flag/flag';
import { IFlagRegistry, type FlagDefinitionInput } from '#/flag/flagRegistry';
import { FlagRegistryService } from '#/flag/flagRegistryService';
import { FlagService, MASTER_ENV } from '#/flag/flagService';
import { ILogService } from '#/log/log';
import { IAtomicTomlDocumentStore, TomlAtomicDocumentStore } from '#/storage/atomicDocumentStore';
import { InMemoryStorageService } from '#/storage/inMemoryStorageService';
import { IStorageService } from '#/storage/storageService';

import { stubBootstrap } from '../bootstrap/stubs';
import { stubLog } from '../log/stubs';

const microCompactionFlag: FlagDefinitionInput = {
  id: 'micro_compaction',
  title: 'Micro compaction',
  description:
    'Trim older large tool results from context while keeping recent conversation intact.',
  env: 'KIMI_CODE_EXPERIMENTAL_MICRO_COMPACTION',
  default: true,
  surface: 'core',
};

describe('FlagRegistryService', () => {
  it('registers and resolves by id', () => {
    const reg = new FlagRegistryService();
    reg.register(microCompactionFlag);
    expect(reg.list().map((d) => d.id)).toEqual(['micro_compaction']);
    expect(reg.get('micro_compaction')?.env).toBe('KIMI_CODE_EXPERIMENTAL_MICRO_COMPACTION');
  });

  it('returns undefined for an unknown id', () => {
    const reg = new FlagRegistryService();
    expect(reg.get('does_not_exist')).toBeUndefined();
  });

  it('throws on a duplicate id', () => {
    const reg = new FlagRegistryService();
    reg.register(microCompactionFlag);
    expect(() => reg.register(microCompactionFlag)).toThrow();
  });

  it('unregisters when the returned disposable is disposed', () => {
    const reg = new FlagRegistryService();
    const handle = reg.register(microCompactionFlag);
    handle.dispose();
    expect(reg.get('micro_compaction')).toBeUndefined();
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
    ix.stub(IStorageService, new InMemoryStorageService());
    ix.set(IAtomicTomlDocumentStore, new SyncDescriptor(TomlAtomicDocumentStore));
    ix.set(IConfigRegistry, new SyncDescriptor(ConfigRegistry));
    ix.set(IConfigService, new SyncDescriptor(ConfigService));
    ix.set(IFlagRegistry, new SyncDescriptor(FlagRegistryService));
    ix.set(IFlagService, new SyncDescriptor(FlagService));
    ix.get(IFlagRegistry).register(microCompactionFlag);
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
    const state = flags.explain('micro_compaction');
    expect(state?.enabled).toBe(true);
    expect(state?.source).toBe('default');
    expect(flags.enabled('micro_compaction')).toBe(true);
  });

  it('returns undefined for an unregistered flag', () => {
    const { flags } = makeFlags();
    expect(flags.explain('does_not_exist')).toBeUndefined();
    expect(flags.enabled('does_not_exist')).toBe(false);
  });

  it('applies config overrides above the default', async () => {
    const { config, flags } = makeFlags();
    await config.set(EXPERIMENTAL_SECTION, { micro_compaction: false });
    const state = flags.explain('micro_compaction');
    expect(state?.enabled).toBe(false);
    expect(state?.source).toBe('config');
    expect(state?.configValue).toBe(false);
  });

  it('lets per-feature env override config', async () => {
    const { config, flags } = makeFlags({
      KIMI_CODE_EXPERIMENTAL_MICRO_COMPACTION: 'true',
    });
    await config.set(EXPERIMENTAL_SECTION, { micro_compaction: false });
    const state = flags.explain('micro_compaction');
    expect(state?.enabled).toBe(true);
    expect(state?.source).toBe('env');
    expect(state?.configValue).toBe(false);
  });

  it('lets the master env switch force every flag on', async () => {
    const { config, flags } = makeFlags({ [MASTER_ENV]: '1' });
    await config.set(EXPERIMENTAL_SECTION, { micro_compaction: false });
    const state = flags.explain('micro_compaction');
    expect(state?.enabled).toBe(true);
    expect(state?.source).toBe('master-env');
  });

  it('refreshes overrides when the experimental config section changes', async () => {
    const { config, flags } = makeFlags();
    expect(flags.enabled('micro_compaction')).toBe(true);
    await config.set(EXPERIMENTAL_SECTION, { micro_compaction: false });
    expect(flags.enabled('micro_compaction')).toBe(false);
    await config.set(EXPERIMENTAL_SECTION, { micro_compaction: true });
    expect(flags.enabled('micro_compaction')).toBe(true);
  });

  it('ignores unrelated config section changes', async () => {
    const { config, flags } = makeFlags();
    await config.set('agent', { modelAlias: 'k2' });
    expect(flags.explain('micro_compaction')?.source).toBe('default');
  });

  it('supports imperative setConfigOverrides', () => {
    const { flags } = makeFlags();
    flags.setConfigOverrides({ micro_compaction: false });
    expect(flags.enabled('micro_compaction')).toBe(false);
    flags.setConfigOverrides(undefined);
    expect(flags.enabled('micro_compaction')).toBe(true);
  });

  it('exposes snapshot / enabledIds / explainAll', () => {
    const { flags } = makeFlags();
    expect(flags.snapshot()).toEqual({ micro_compaction: true });
    expect(flags.enabledIds()).toEqual(['micro_compaction']);
    expect(flags.explainAll().map((s) => s.id)).toEqual(['micro_compaction']);
  });

  it('treats truthy env values case-insensitively', () => {
    const { flags } = makeFlags({ KIMI_CODE_EXPERIMENTAL_MICRO_COMPACTION: 'YES' });
    expect(flags.enabled('micro_compaction')).toBe(true);
  });

  it('treats falsy env values case-insensitively', () => {
    const { flags } = makeFlags({ KIMI_CODE_EXPERIMENTAL_MICRO_COMPACTION: 'off' });
    expect(flags.enabled('micro_compaction')).toBe(false);
  });

  it('reads only the env name declared in the registry', () => {
    const { flags } = makeFlags({ KIMI_CODE_EXPERIMENTAL_UNKNOWN: 'false' });
    expect(flags.enabled('micro_compaction')).toBe(true);
  });

  it('ignores garbage env values', () => {
    const { flags } = makeFlags({ KIMI_CODE_EXPERIMENTAL_MICRO_COMPACTION: 'maybe' });
    expect(flags.enabled('micro_compaction')).toBe(true);
  });

  it('ignores obsolete config ids outside the registry', async () => {
    const { config, flags } = makeFlags();
    await config.set(EXPERIMENTAL_SECTION, {
      obsolete_flag: false,
      micro_compaction: false,
    });

    expect(flags.snapshot()).toEqual({ micro_compaction: false });
    expect(flags.explain('obsolete_flag')).toBeUndefined();
  });
});

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { SyncDescriptor } from '#/_base/di/descriptors';
import { DisposableStore } from '#/_base/di/lifecycle';
import { TestInstantiationService } from '#/_base/di/test';
import { IConfigRegistry, IConfigService } from '#/config';
import { ConfigRegistry, ConfigService } from '#/config/configService';
import { IEnvironmentService } from '#/environment';
import { stubEnvironment } from '../environment/stubs';
import { IFlagService } from '#/flag';
import {
  EXPERIMENTAL_SECTION,
  FlagService,
  MASTER_ENV,
} from '#/flag/flagService';
import { FlagRegistry } from '#/flag/registry';
import { ILogService } from '#/log';
import { stubLog } from '../log/stubs';

describe('FlagRegistry', () => {
  it('lists registered definitions and resolves by id', () => {
    const reg = new FlagRegistry();
    expect(reg.list().map((d) => d.id)).toEqual(['micro_compaction']);
    expect(reg.get('micro_compaction')?.env).toBe('KIMI_CODE_EXPERIMENTAL_MICRO_COMPACTION');
  });

  it('returns undefined for an unknown id', () => {
    const reg = new FlagRegistry();
    // @ts-expect-error -- unknown id is not part of the FlagId union
    expect(reg.get('does_not_exist')).toBeUndefined();
  });
});

describe('FlagService', () => {
  let disposables: DisposableStore;
  let ix: TestInstantiationService;

  beforeEach(() => {
    disposables = new DisposableStore();
    ix = disposables.add(new TestInstantiationService());
    // Isolate the config file per test: ConfigService reads/writes
    // env.configPath, so a shared path leaks [experimental] overrides across
    // tests (and runs) and shadows the registry default.
    ix.stub(
      IEnvironmentService,
      stubEnvironment(
        `/tmp/kimi-code-flag-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`,
      ),
    );
    ix.stub(ILogService, stubLog());
    ix.set(IConfigRegistry, new SyncDescriptor(ConfigRegistry));
    ix.set(IConfigService, new SyncDescriptor(ConfigService));
    ix.set(IFlagService, new SyncDescriptor(FlagService));
  });
  afterEach(() => disposables.dispose());

  function makeFlags(env: Readonly<Record<string, string | undefined>> = {}) {
    return {
      registry: ix.get(IConfigRegistry),
      config: ix.get(IConfigService),
      flags: Object.keys(env).length
        ? ix.createInstance(FlagService, env, undefined as never)
        : ix.get(IFlagService),
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

  it('ignores garbage env values', () => {
    const { flags } = makeFlags({ KIMI_CODE_EXPERIMENTAL_MICRO_COMPACTION: 'maybe' });
    expect(flags.enabled('micro_compaction')).toBe(true);
  });
});

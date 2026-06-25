import { describe, expect, it } from 'vitest';

import { ConfigRegistry, ConfigService } from '#/config/configService';
import type { ILogService, ILogger } from '#/log/log';

import { FlagRegistry } from '#/flag/registry';
import {
  EXPERIMENTAL_SECTION,
  FlagService,
  MASTER_ENV,
} from '#/flag/flagService';

const noopLogger: ILogger = {
  error: () => {},
  warn: () => {},
  info: () => {},
  debug: () => {},
  child: () => noopLogger,
};
const noopLog: ILogService = {
  ...noopLogger,
  _serviceBrand: undefined,
  level: 'info',
  setLevel: () => {},
};

function makeConfigService(): { registry: ConfigRegistry; config: ConfigService } {
  const registry = new ConfigRegistry();
  const config = new ConfigService(
    registry,
    undefined as never,
    noopLog,
  );
  return { registry, config };
}

function makeFlagService(
  env: Readonly<Record<string, string | undefined>> = {},
): { registry: ConfigRegistry; config: ConfigService; flags: FlagService } {
  const { registry, config } = makeConfigService();
  const flags = new FlagService(registry, config, env);
  return { registry, config, flags };
}

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
  it('registers the experimental config section downward', () => {
    const { registry } = makeFlagService();
    expect(registry.getSection(EXPERIMENTAL_SECTION)).toMatchObject({
      domain: EXPERIMENTAL_SECTION,
    });
    expect(registry.getSection(EXPERIMENTAL_SECTION)?.schema).toBeDefined();
  });

  it('resolves the registry default when nothing overrides it', () => {
    const { flags } = makeFlagService();
    const state = flags.explain('micro_compaction');
    expect(state?.enabled).toBe(true);
    expect(state?.source).toBe('default');
    expect(flags.enabled('micro_compaction')).toBe(true);
  });

  it('applies config overrides above the default', async () => {
    const { config, flags } = makeFlagService();
    await config.set(EXPERIMENTAL_SECTION, { micro_compaction: false });
    const state = flags.explain('micro_compaction');
    expect(state?.enabled).toBe(false);
    expect(state?.source).toBe('config');
    expect(state?.configValue).toBe(false);
  });

  it('lets per-feature env override config', async () => {
    const { config, flags } = makeFlagService({
      KIMI_CODE_EXPERIMENTAL_MICRO_COMPACTION: 'true',
    });
    await config.set(EXPERIMENTAL_SECTION, { micro_compaction: false });
    const state = flags.explain('micro_compaction');
    expect(state?.enabled).toBe(true);
    expect(state?.source).toBe('env');
    expect(state?.configValue).toBe(false);
  });

  it('lets the master env switch force every flag on', async () => {
    const { config, flags } = makeFlagService({ [MASTER_ENV]: '1' });
    await config.set(EXPERIMENTAL_SECTION, { micro_compaction: false });
    const state = flags.explain('micro_compaction');
    expect(state?.enabled).toBe(true);
    expect(state?.source).toBe('master-env');
  });

  it('refreshes overrides when the experimental config section changes', async () => {
    const { config, flags } = makeFlagService();
    expect(flags.enabled('micro_compaction')).toBe(true);
    await config.set(EXPERIMENTAL_SECTION, { micro_compaction: false });
    expect(flags.enabled('micro_compaction')).toBe(false);
    await config.set(EXPERIMENTAL_SECTION, { micro_compaction: true });
    expect(flags.enabled('micro_compaction')).toBe(true);
  });

  it('ignores unrelated config section changes', async () => {
    const { config, flags } = makeFlagService();
    await config.set('agent', { modelAlias: 'k2' });
    expect(flags.explain('micro_compaction')?.source).toBe('default');
  });

  it('supports imperative setConfigOverrides', () => {
    const { flags } = makeFlagService();
    flags.setConfigOverrides({ micro_compaction: false });
    expect(flags.enabled('micro_compaction')).toBe(false);
    flags.setConfigOverrides(undefined);
    expect(flags.enabled('micro_compaction')).toBe(true);
  });

  it('exposes snapshot / enabledIds / explainAll', () => {
    const { flags } = makeFlagService();
    expect(flags.snapshot()).toEqual({ micro_compaction: true });
    expect(flags.enabledIds()).toEqual(['micro_compaction']);
    expect(flags.explainAll().map((s) => s.id)).toEqual(['micro_compaction']);
  });

  it('treats env values case-insensitively and ignores garbage', () => {
    const truthy = makeFlagService({ KIMI_CODE_EXPERIMENTAL_MICRO_COMPACTION: 'YES' }).flags;
    expect(truthy.enabled('micro_compaction')).toBe(true);
    const falsy = makeFlagService({ KIMI_CODE_EXPERIMENTAL_MICRO_COMPACTION: 'off' }).flags;
    expect(falsy.enabled('micro_compaction')).toBe(false);
    const garbage = makeFlagService({ KIMI_CODE_EXPERIMENTAL_MICRO_COMPACTION: 'maybe' }).flags;
    expect(garbage.enabled('micro_compaction')).toBe(true);
  });
});

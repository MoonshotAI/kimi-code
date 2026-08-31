import { describe, expect, it } from 'vitest';

import { ErrorCodes, Error2 } from '#/errors';
import type { IModelCatalog } from '#/kosong/model/catalog';
import type { Model } from '#/kosong/model/catalog';
import {
  resolveEffectiveSubagentModelPool,
  resolveSubagentBinding,
  SECONDARY_MODEL_SECTION,
  SUBAGENT_SECTION,
} from '#/session/subagent/configSection';
import { SECONDARY_MODEL_FLAG_ID } from '#/session/subagent/flag';

import { StubConfigService } from '../../kosong/stubs';
import { stubFlag } from '../../app/flag/stubs';

function stubCatalog(modelIds: ReadonlySet<string>): IModelCatalog {
  return {
    _serviceBrand: undefined,
    get: (id: string) => {
      if (!modelIds.has(id)) {
        throw new Error2(
          ErrorCodes.CONFIG_INVALID,
          `Model "${id}" is not configured in config.toml.`,
          { details: { model: id } },
        );
      }
      return { id } as Model;
    },
  } as unknown as IModelCatalog;
}

function resolvePool(configValues: Record<string, unknown>, flagEnabled = true) {
  return resolveEffectiveSubagentModelPool(
    new StubConfigService(configValues),
    stubFlag((id) => flagEnabled && id === SECONDARY_MODEL_FLAG_ID),
    catalog,
  );
}

let catalog: IModelCatalog;

function withModels(...ids: string[]): void {
  catalog = stubCatalog(new Set(ids));
}

describe('resolveEffectiveSubagentModelPool', () => {
  it('is a no-op when no secondary_model section is configured', () => {
    withModels();
    const { pool, issues } = resolvePool({});
    expect(pool).toBeUndefined();
    expect(issues).toEqual([]);
  });

  it('is a no-op when only the [subagent] timeout is configured', () => {
    withModels();
    const { pool, issues } = resolvePool({ [SUBAGENT_SECTION]: { timeoutMs: 5000 } });
    expect(pool).toBeUndefined();
    expect(issues).toEqual([]);
  });

  it('is a no-op for a broken pool while the secondary-model experiment is off', () => {
    withModels();
    const { pool, issues } = resolvePool(
      { [SECONDARY_MODEL_SECTION]: { defaultModel: 'provider/typo' } },
      false,
    );
    expect(pool).toBeUndefined();
    expect(issues).toEqual([]);
  });

  it('exposes an implicit single-entry pool for a resolvable lone default_model', () => {
    withModels('provider/fast');
    const { pool, issues } = resolvePool({
      [SECONDARY_MODEL_SECTION]: { defaultModel: 'provider/fast' },
    });
    expect(pool).toEqual({ defaultModel: 'provider/fast', models: { 'provider/fast': '' } });
    expect(issues).toEqual([]);
  });

  it('exposes the legacy model key as the fallback pool', () => {
    withModels('provider/fast');
    const { pool, issues } = resolvePool({
      [SECONDARY_MODEL_SECTION]: { model: 'provider/fast' },
    });
    expect(pool).toEqual({ defaultModel: 'provider/fast', models: { 'provider/fast': '' } });
    expect(issues).toEqual([]);
  });

  it('drops an unresolvable legacy model fallback with a warning instead of failing', () => {
    withModels();
    const { pool, issues } = resolvePool({
      [SECONDARY_MODEL_SECTION]: { model: 'provider/typo' },
    });
    expect(pool).toBeUndefined();
    expect(issues).toHaveLength(1);
    expect(issues[0]).toContain('[secondary_model.models] entry "provider/typo" could not be resolved');
    expect(issues[0]).toContain('"provider/typo" is not configured');
    expect(issues[0]).toContain('The entry is ignored until fixed.');
  });

  it('passes a fully valid pool through unchanged', () => {
    withModels('provider/fast', 'provider/smart');
    const { pool, issues } = resolvePool({
      [SECONDARY_MODEL_SECTION]: {
        defaultModel: 'provider/fast',
        models: { 'provider/fast': 'fast and cheap', 'provider/smart': 'hard tasks' },
      },
    });
    expect(pool).toEqual({
      defaultModel: 'provider/fast',
      models: { 'provider/fast': 'fast and cheap', 'provider/smart': 'hard tasks' },
    });
    expect(issues).toEqual([]);
  });

  it('falls back to the first resolvable entry when the pool has no default_model', () => {
    withModels('provider/fast');
    const { pool, issues } = resolvePool({
      [SECONDARY_MODEL_SECTION]: { models: { 'provider/fast': 'fast and cheap' } },
    });
    expect(pool).toEqual({ defaultModel: 'provider/fast', models: { 'provider/fast': 'fast and cheap' } });
    expect(issues).toHaveLength(1);
    expect(issues[0]).toContain(
      '[secondary_model].default_model is required when [secondary_model.models] is configured',
    );
    expect(issues[0]).toContain('falling back to "provider/fast" until fixed.');
  });

  it('falls back to the first resolvable entry when default_model is not a pool key', () => {
    withModels('provider/fast', 'provider/smart');
    const { pool, issues } = resolvePool({
      [SECONDARY_MODEL_SECTION]: {
        defaultModel: 'provider/typo',
        models: { 'provider/fast': 'fast and cheap', 'provider/smart': 'hard tasks' },
      },
    });
    expect(pool?.defaultModel).toBe('provider/fast');
    expect(issues).toHaveLength(1);
    expect(issues[0]).toContain(
      '[secondary_model].default_model "provider/typo" is not available; falling back to "provider/fast" until fixed.',
    );
  });

  it('reports an unusable default_model when the models table is empty', () => {
    withModels('provider/fast');
    const { pool, issues } = resolvePool({
      [SECONDARY_MODEL_SECTION]: { defaultModel: 'provider/fast', models: {} },
    });
    expect(pool).toBeUndefined();
    expect(issues).toHaveLength(1);
    expect(issues[0]).toContain(
      '[secondary_model].default_model "provider/fast" is not a [secondary_model.models] key',
    );
    expect(issues[0]).toContain("subagents inherit the caller's model until fixed.");
  });

  it('reports a missing default_model when the models table is empty', () => {
    withModels();
    const { pool, issues } = resolvePool({
      [SECONDARY_MODEL_SECTION]: { models: {} },
    });
    expect(pool).toBeUndefined();
    expect(issues).toHaveLength(1);
    expect(issues[0]).toContain(
      '[secondary_model].default_model is required when [secondary_model.models] is configured',
    );
    expect(issues[0]).toContain("subagents inherit the caller's model until fixed.");
  });

  it('reports both the broken entry and the missing default when nothing survives', () => {
    withModels();
    const { pool, issues } = resolvePool({
      [SECONDARY_MODEL_SECTION]: { models: { 'provider/typo': 'broken' } },
    });
    expect(pool).toBeUndefined();
    expect(issues).toHaveLength(2);
    expect(issues[0]).toContain('[secondary_model.models] entry "provider/typo" could not be resolved');
    expect(issues[1]).toContain(
      '[secondary_model].default_model is required when [secondary_model.models] is configured',
    );
  });

  it('drops the reserved "primary" alias with a warning and keeps the rest', () => {
    withModels('primary', 'provider/fast');
    const { pool, issues } = resolvePool({
      [SECONDARY_MODEL_SECTION]: {
        defaultModel: 'provider/fast',
        models: { primary: 'looks like a model', 'provider/fast': 'fast and cheap' },
      },
    });
    expect(pool).toEqual({ defaultModel: 'provider/fast', models: { 'provider/fast': 'fast and cheap' } });
    expect(issues).toHaveLength(1);
    expect(issues[0]).toContain('[secondary_model.models] key "primary" is reserved');
    expect(issues[0]).toContain('The entry is ignored until renamed.');
  });

  it('skips an unresolvable pool entry, keeping the valid default and entries', () => {
    withModels('provider/fast');
    const { pool, issues } = resolvePool({
      [SECONDARY_MODEL_SECTION]: {
        defaultModel: 'provider/fast',
        models: { 'provider/fast': 'fast and cheap', 'provider/typo': 'hard tasks' },
      },
    });
    expect(pool).toEqual({ defaultModel: 'provider/fast', models: { 'provider/fast': 'fast and cheap' } });
    expect(issues).toHaveLength(1);
    expect(issues[0]).toContain('[secondary_model.models] entry "provider/typo" could not be resolved');
    expect(issues[0]).toContain('"provider/typo" is not configured');
  });

  it('drops the whole pool when every entry fails to resolve', () => {
    withModels();
    const { pool, issues } = resolvePool({
      [SECONDARY_MODEL_SECTION]: {
        defaultModel: 'provider/typo',
        models: { 'provider/typo': 'hard tasks', 'provider/gone': 'also broken' },
      },
    });
    expect(pool).toBeUndefined();
    expect(issues).toHaveLength(2);
    expect(issues[0]).toContain('"provider/typo"');
    expect(issues[1]).toContain('"provider/gone"');
  });

  it('falls back to a remaining entry when default_model itself fails to resolve', () => {
    withModels('provider/smart');
    const { pool, issues } = resolvePool({
      [SECONDARY_MODEL_SECTION]: {
        defaultModel: 'provider/typo',
        models: { 'provider/typo': 'hard tasks', 'provider/smart': 'still here' },
      },
    });
    expect(pool).toEqual({ defaultModel: 'provider/smart', models: { 'provider/smart': 'still here' } });
    expect(issues).toHaveLength(2);
    expect(issues[0]).toContain('[secondary_model.models] entry "provider/typo" could not be resolved');
    expect(issues[1]).toContain(
      '[secondary_model].default_model "provider/typo" is not available; falling back to "provider/smart" until fixed.',
    );
  });

  it('reports no issues when force pins a resolvable default_model', () => {
    withModels('provider/fast');
    const { pool, issues } = resolvePool({
      [SECONDARY_MODEL_SECTION]: { defaultModel: 'provider/fast', force: true },
    });
    expect(pool).toBeUndefined();
    expect(issues).toEqual([]);
  });

  it('warns instead of failing when force is set without default_model', () => {
    withModels();
    const { issues } = resolvePool({ [SECONDARY_MODEL_SECTION]: { force: true } });
    expect(issues).toHaveLength(1);
    expect(issues[0]).toContain(
      '[secondary_model].default_model is required when [secondary_model].force is set',
    );
  });

  it('warns instead of failing when force is combined with a models table', () => {
    withModels('provider/fast');
    const { issues } = resolvePool({
      [SECONDARY_MODEL_SECTION]: {
        defaultModel: 'provider/fast',
        models: { 'provider/fast': 'fast and cheap' },
        force: true,
      },
    });
    expect(issues).toHaveLength(1);
    expect(issues[0]).toContain(
      '[secondary_model].force cannot be combined with [secondary_model.models]',
    );
  });

  it('warns instead of failing when the forced default_model does not resolve', () => {
    withModels();
    const { issues } = resolvePool({
      [SECONDARY_MODEL_SECTION]: { defaultModel: 'provider/typo', force: true },
    });
    expect(issues).toHaveLength(1);
    expect(issues[0]).toContain('[secondary_model] forced model "provider/typo" could not be resolved');
    expect(issues[0]).toContain('Subagent spawns will fail until this is fixed.');
  });
});

describe('resolveSubagentBinding over the effective pool', () => {
  const own = { modelAlias: 'provider/main', thinkingLevel: 'medium' };

  function bind(configValues: Record<string, unknown>, requested?: string) {
    return resolveSubagentBinding(
      new StubConfigService(configValues),
      stubFlag((id) => id === SECONDARY_MODEL_FLAG_ID),
      own,
      requested,
      catalog,
    );
  }

  it('rejects an explicit request for a skipped entry, listing only resolvable models', () => {
    withModels('provider/fast');
    const config = {
      [SECONDARY_MODEL_SECTION]: {
        defaultModel: 'provider/fast',
        models: { 'provider/fast': 'fast and cheap', 'provider/typo': 'hard tasks' },
      },
    };
    expect(() => bind(config, 'provider/typo')).toThrow(
      'Invalid model "provider/typo". Available models: provider/fast, primary.',
    );
  });

  it('inherits the caller model when every pool entry is skipped', () => {
    withModels();
    const config = {
      [SECONDARY_MODEL_SECTION]: {
        defaultModel: 'provider/typo',
        models: { 'provider/typo': 'hard tasks' },
      },
    };
    expect(bind(config)).toEqual({ model: 'provider/main', thinking: 'medium' });
    expect(() => bind(config, 'provider/typo')).toThrow(
      /no \[secondary_model\.models\] pool is configured/,
    );
  });

  it('binds the fallback default when default_model is skipped', () => {
    withModels('provider/smart');
    const config = {
      [SECONDARY_MODEL_SECTION]: {
        defaultModel: 'provider/typo',
        models: { 'provider/typo': 'hard tasks', 'provider/smart': 'still here' },
      },
    };
    expect(bind(config)).toEqual({ model: 'provider/smart', thinking: undefined });
  });

  it('binds "primary" to the caller model even when the raw pool abuses the reserved alias', () => {
    withModels('primary', 'provider/fast');
    const config = {
      [SECONDARY_MODEL_SECTION]: {
        defaultModel: 'provider/fast',
        models: { primary: 'looks like a model', 'provider/fast': 'fast and cheap' },
      },
    };
    expect(bind(config, 'primary')).toEqual({ model: 'provider/main', thinking: 'medium' });
    expect(bind(config)).toEqual({ model: 'provider/fast', thinking: undefined });
  });
});

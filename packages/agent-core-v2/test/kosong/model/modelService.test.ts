/**
 * `kosong/model` config-surface tests — the models config contract and
 * `IModelService`:
 *
 *  - the section TOML transforms round-trip snake_case ↔ camelCase (including
 *    the nested `overrides` object);
 *  - `ModelService` CRUD persists through config and diffs section changes
 *    into `onDidChangeModels` (added/changed/removed).
 */

import { describe, expect, it } from 'vitest';

import { createScopedTestHost } from '#/_base/di/test';
import { IConfigService } from '#/app/config/config';
import { modelsFromToml, modelsToToml } from '#/kosong/model/configSection';
import { IModelService, type ModelRecord } from '#/kosong/model/model';
import '#/kosong/model/modelService';

import { StubConfigService } from '../stubs';

describe('models TOML transforms', () => {
  it('converts snake_case entries to camelCase and back', () => {
    const from = modelsFromToml({
      k1: {
        provider: 'moonshot',
        model: 'kimi-k2',
        max_context_size: 262144,
        max_output_size: 8192,
        display_name: 'K2',
        reasoning_key: 'reasoning_content',
        adaptive_thinking: true,
        beta_api: true,
        support_efforts: ['low', 'high'],
        default_effort: 'high',
        overrides: { max_output_size: 4096, default_effort: 'low' },
      },
    }) as Record<string, Record<string, unknown>>;
    expect(from['k1']).toEqual({
      provider: 'moonshot',
      model: 'kimi-k2',
      maxContextSize: 262144,
      maxOutputSize: 8192,
      displayName: 'K2',
      reasoningKey: 'reasoning_content',
      adaptiveThinking: true,
      betaApi: true,
      supportEfforts: ['low', 'high'],
      defaultEffort: 'high',
      overrides: { maxOutputSize: 4096, defaultEffort: 'low' },
    });

    const back = modelsToToml(from, undefined) as Record<string, Record<string, unknown>>;
    expect(back['k1']).toEqual({
      provider: 'moonshot',
      model: 'kimi-k2',
      max_context_size: 262144,
      max_output_size: 8192,
      display_name: 'K2',
      reasoning_key: 'reasoning_content',
      adaptive_thinking: true,
      beta_api: true,
      support_efforts: ['low', 'high'],
      default_effort: 'high',
      overrides: { max_output_size: 4096, default_effort: 'low' },
    });
  });
});

describe('ModelService', () => {
  function createHost(): {
    host: ReturnType<typeof createScopedTestHost>;
    service: IModelService;
  } {
    const config = new StubConfigService();
    const host = createScopedTestHost([[IConfigService, config]]);
    const service = host.app.accessor.get(IModelService);
    return { host, service };
  }

  it('supports CRUD and diffs section changes into onDidChangeModels', async () => {
    const { host, service } = createHost();
    try {
      const events: Array<{
        added: readonly string[];
        removed: readonly string[];
        changed: readonly string[];
      }> = [];
      service.onDidChangeModels((e) => events.push(e));

      const k1: ModelRecord = { provider: 'moonshot', model: 'kimi-k2', maxContextSize: 262144 };
      await service.set('k1', k1);
      expect(service.get('k1')).toEqual(k1);
      expect(service.list()).toEqual({ k1 });
      expect(events).toEqual([{ added: ['k1'], removed: [], changed: [] }]);

      const updated: ModelRecord = { ...k1, displayName: 'K2' };
      await service.set('k1', updated);
      expect(events.at(-1)).toEqual({ added: [], removed: [], changed: ['k1'] });

      // Rewriting with an identical record still fires the config event but
      // diffs to no changed keys.
      await service.set('k1', updated);
      expect(events.at(-1)).toEqual({ added: [], removed: [], changed: [] });

      await service.delete('k1');
      expect(service.get('k1')).toBeUndefined();
      expect(events.at(-1)).toEqual({ added: [], removed: ['k1'], changed: [] });
    } finally {
      host.dispose();
    }
  });
});

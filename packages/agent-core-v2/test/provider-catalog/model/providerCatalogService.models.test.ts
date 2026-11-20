import { describe, expect, it } from 'vitest';

import { modelsFromToml, modelsToToml } from '#/app/kosongConfig/configSection';
import { type ModelRecord } from '#/provider-catalog/model/model';
import { ProviderCatalogService } from '#/provider-catalog/providerCatalogService';

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

describe('ProviderCatalogService', () => {
  function createService(models: Readonly<Record<string, ModelRecord>> = {}): ProviderCatalogService {
    const service = new ProviderCatalogService();
    service.loadModelRecords({ ...models }, undefined);
    service.loadProviderConfigs({}, undefined);
    return service;
  }

  it('resolves ready on the first loadAll and exposes the default pointer', async () => {
    const service = new ProviderCatalogService();
    let ready = false;
    void service.ready.then(() => {
      ready = true;
    });
    await Promise.resolve();
    expect(ready).toBe(false);

    service.loadModelRecords({ k1: { model: 'kimi-k2', maxContextSize: 262144 } }, 'k1');
    await Promise.resolve();
    expect(ready).toBe(false);
    service.loadProviderConfigs({}, undefined);
    await service.ready;
    expect(ready).toBe(true);
    expect(service.getDefaultModelId()).toBe('k1');
  });

  it('supports CRUD and diffs state changes into onDidChangeModels', async () => {
    const service = createService();
    const events: Array<{
      added: readonly string[];
      removed: readonly string[];
      changed: readonly string[];
    }> = [];
    service.onDidChangeModels((e) =>
      events.push({ added: e.added, removed: e.removed, changed: e.changed }),
    );

    const k1: ModelRecord = { provider: 'moonshot', model: 'kimi-k2', maxContextSize: 262144 };
    await service.setModelRecord('k1', k1);
    expect(service.getModelRecord('k1')).toEqual(k1);
    expect(service.listModelRecords()).toEqual({ k1 });
    expect(events).toEqual([{ added: ['k1'], removed: [], changed: [] }]);

    const updated: ModelRecord = { ...k1, displayName: 'K2' };
    await service.setModelRecord('k1', updated);
    expect(events.at(-1)).toEqual({ added: [], removed: [], changed: ['k1'] });

    await service.setModelRecord('k1', updated);
    expect(events).toHaveLength(2);

    await service.deleteModelRecord('k1');
    expect(service.getModelRecord('k1')).toBeUndefined();
    expect(events.at(-1)).toEqual({ added: [], removed: ['k1'], changed: [] });
  });

  it('replaceAll replaces the records and keeps the default pointer', async () => {
    const service = createService({ a: { model: 'm-a' }, b: { model: 'm-b' } });
    await service.setDefaultModelId('a');

    await service.replaceModelRecords({ c: { model: 'm-c' } });
    expect(service.listModelRecords()).toEqual({ c: { model: 'm-c' } });
    expect(service.getDefaultModelId()).toBe('a');
  });

  it('fires the pointer event only on real pointer changes', async () => {
    const service = createService({ k1: { model: 'kimi-k2' } });
    const pointerEvents: Array<string | undefined> = [];
    service.onDidChangeDefaultModel((e) => pointerEvents.push(e.id));

    await service.setDefaultModelId('k1');
    await service.setDefaultModelId('k1');
    expect(pointerEvents).toEqual(['k1']);

    await service.setDefaultModelId(undefined);
    expect(pointerEvents).toEqual(['k1', undefined]);
  });
});

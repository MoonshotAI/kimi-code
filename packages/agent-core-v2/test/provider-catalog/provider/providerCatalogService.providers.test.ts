import { describe, expect, it } from 'vitest';

import {
  ProvidersSectionSchema,
  providersFromToml,
  providersToToml,
} from '#/app/kosongConfig/configSection';
import { type ProviderConfig } from '#/provider-catalog/provider/provider';
import { ProviderCatalogService } from '#/provider-catalog/providerCatalogService';

describe('ProviderTypeSchema (free-form vendor identity)', () => {
  it('parses unregistered vendor names — resolve-time validation, not parse-time', () => {
    const parsed = ProvidersSectionSchema.parse({
      'my-vendor': { type: 'a-vendor-registered-elsewhere', baseUrl: 'https://example.com/v1' },
    });
    expect(parsed['my-vendor']?.type).toBe('a-vendor-registered-elsewhere');
  });
});

describe('providers TOML transforms', () => {
  it('converts snake_case entries to camelCase and back', () => {
    const from = providersFromToml({
      'my-provider': {
        type: 'kimi',
        base_url: 'https://api.moonshot.ai/v1',
        custom_headers: { 'x-a': 'b' },
        default_model: 'kimi-k2',
        oauth: { storage: 'file', key: 'k', oauth_host: 'example.com' },
      },
    }) as Record<string, Record<string, unknown>>;
    expect(from['my-provider']).toEqual({
      type: 'kimi',
      baseUrl: 'https://api.moonshot.ai/v1',
      customHeaders: { 'x-a': 'b' },
      defaultModel: 'kimi-k2',
      oauth: { storage: 'file', key: 'k', oauthHost: 'example.com' },
    });

    const back = providersToToml(from, undefined) as Record<string, Record<string, unknown>>;
    expect(back['my-provider']).toEqual({
      type: 'kimi',
      base_url: 'https://api.moonshot.ai/v1',
      custom_headers: { 'x-a': 'b' },
      default_model: 'kimi-k2',
      oauth: { storage: 'file', key: 'k', oauth_host: 'example.com' },
    });
  });

  it('round-trips api_key_env between TOML and camelCase', () => {
    const from = providersFromToml({
      acme: { type: 'openai', api_key_env: 'ACME_API_KEY' },
    }) as Record<string, Record<string, unknown>>;
    expect(from['acme']).toEqual({ type: 'openai', apiKeyEnv: 'ACME_API_KEY' });

    const parsed = ProvidersSectionSchema.parse(from);
    expect(parsed['acme']?.apiKeyEnv).toBe('ACME_API_KEY');

    const back = providersToToml(from, undefined) as Record<string, Record<string, unknown>>;
    expect(back['acme']).toEqual({ type: 'openai', api_key_env: 'ACME_API_KEY' });
  });

  it('drops a stale api_key_env and oauth when the provider is replaced with an inline api_key', () => {
    const raw = {
      acme: {
        type: 'openai',
        api_key_env: 'ACME_API_KEY',
        oauth: { storage: 'file', key: 'oauth/acme' },
      },
    };
    const next = providersToToml(
      { acme: { type: 'openai', apiKey: 'sk-new' } },
      raw,
    ) as Record<string, Record<string, unknown>>;
    expect(next['acme']).toEqual({ type: 'openai', api_key: 'sk-new' });
  });
});

describe('ProviderCatalogService', () => {
  function createService(providers: Readonly<Record<string, ProviderConfig>> = {}): ProviderCatalogService {
    const service = new ProviderCatalogService();
    service.loadProviderConfigs({ ...providers }, undefined);
    service.loadModelRecords({}, undefined);
    return service;
  }

  it('resolves ready on the first loadAll and gates mutations on it', async () => {
    const service = new ProviderCatalogService();
    let ready = false;
    void service.ready.then(() => {
      ready = true;
    });
    await Promise.resolve();
    expect(ready).toBe(false);

    service.loadProviderConfigs({ moonshot: { type: 'kimi' } }, 'moonshot');
    await Promise.resolve();
    expect(ready).toBe(false);
    service.loadModelRecords({}, undefined);
    await service.ready;
    expect(ready).toBe(true);
    expect(service.getProviderConfig('moonshot')).toEqual({ type: 'kimi' });
    expect(service.getDefaultProviderId()).toBe('moonshot');
  });

  it('supports CRUD and diffs state changes into onDidChangeProviders', async () => {
    const service = createService();
    const events: Array<{
      added: readonly string[];
      removed: readonly string[];
      changed: readonly string[];
    }> = [];
    service.onDidChangeProviders((e) =>
      events.push({ added: e.added, removed: e.removed, changed: e.changed }),
    );

    const moonshot: ProviderConfig = { type: 'kimi', baseUrl: 'https://api.moonshot.ai/v1' };
    await service.setProviderConfig('moonshot', moonshot);
    expect(service.getProviderConfig('moonshot')).toEqual(moonshot);
    expect(service.listProviderConfigs()).toEqual({ moonshot });
    expect(events).toEqual([{ added: ['moonshot'], removed: [], changed: [] }]);

    const updated: ProviderConfig = { ...moonshot, apiKey: 'sk-1' };
    await service.setProviderConfig('moonshot', updated);
    expect(events.at(-1)).toEqual({ added: [], removed: [], changed: ['moonshot'] });

    await service.setProviderConfig('moonshot', updated);
    expect(events).toHaveLength(2);

    await service.deleteProviderConfig('moonshot');
    expect(service.getProviderConfig('moonshot')).toBeUndefined();
    expect(events.at(-1)).toEqual({ added: [], removed: ['moonshot'], changed: [] });
  });

  it('loadAll fires only for real diffs on re-sync', async () => {
    const service = createService({ moonshot: { type: 'kimi' } });
    const events: unknown[] = [];
    service.onDidChangeProviders((e) =>
      events.push({ added: e.added, removed: e.removed, changed: e.changed }),
    );

    service.loadProviderConfigs({ moonshot: { type: 'kimi' } }, undefined);
    expect(events).toHaveLength(0);

    service.loadProviderConfigs({ moonshot: { type: 'kimi' }, other: { baseUrl: 'https://example.com' } }, undefined);
    expect(events).toEqual([{ added: ['other'], removed: [], changed: [] }]);
  });

  it('replaceAll replaces the records and keeps the default pointer', async () => {
    const service = createService({ a: { type: 'kimi' }, b: { type: 'kimi' } });
    await service.setDefaultProviderId('a');

    await service.replaceProviderConfigs({ c: { type: 'kimi' } });
    expect(service.listProviderConfigs()).toEqual({ c: { type: 'kimi' } });
    expect(service.getDefaultProviderId()).toBe('a');
  });

  it('clears the defaultProvider pointer when the default provider is deleted', async () => {
    const service = createService({ moonshot: { type: 'kimi' } });
    const pointerEvents: Array<string | undefined> = [];
    service.onDidChangeDefaultProvider((e) => pointerEvents.push(e.id));

    await service.setDefaultProviderId('moonshot');
    expect(service.getDefaultProviderId()).toBe('moonshot');

    await service.deleteProviderConfig('moonshot');
    expect(service.getDefaultProviderId()).toBeUndefined();
    expect(pointerEvents).toEqual(['moonshot', undefined]);
  });

  it('a mutation resolves only after the listeners’ waitUntil work completes', async () => {
    const service = createService();
    let persistDone = false;
    service.onDidChangeProviders((e) => {
      e.waitUntil(
        new Promise<void>((resolve) => setTimeout(resolve, 50)).then(() => {
          persistDone = true;
        }),
      );
    });

    await service.setProviderConfig('moonshot', { type: 'kimi' });
    expect(persistDone).toBe(true);
  });
});

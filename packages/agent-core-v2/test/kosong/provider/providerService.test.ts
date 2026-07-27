/**
 * `kosong/provider` config-surface tests — the providers config contract and
 * `IProviderService`:
 *
 *  - `ProviderTypeSchema` is free-form text: unregistered vendor names parse
 *    (validation happens at resolve time, not parse time);
 *  - the section TOML transforms round-trip snake_case ↔ camelCase;
 *  - `ProviderService` is an in-memory registry: `loadAll` hydrates and
 *    resolves `ready`, CRUD diffs state changes into `onDidChangeProviders`
 *    (added/changed/removed), equal writes stay silent, and deleting the
 *    default provider clears the `defaultProvider` pointer.
 */

import { describe, expect, it } from 'vitest';

import {
  ProvidersSectionSchema,
  providersFromToml,
  providersToToml,
} from '#/app/kosongConfig/configSection';
import { ProviderService } from '#/kosong/provider/providerService';
import { type ProviderConfig } from '#/kosong/provider/provider';

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
});

describe('ProviderService', () => {
  function createService(providers: Readonly<Record<string, ProviderConfig>> = {}): ProviderService {
    const service = new ProviderService();
    service.loadAll({ ...providers }, undefined);
    return service;
  }

  it('resolves ready on the first loadAll and gates mutations on it', async () => {
    const service = new ProviderService();
    let ready = false;
    void service.ready.then(() => {
      ready = true;
    });
    await Promise.resolve();
    expect(ready).toBe(false);

    service.loadAll({ moonshot: { type: 'kimi' } }, 'moonshot');
    await service.ready;
    expect(ready).toBe(true);
    expect(service.get('moonshot')).toEqual({ type: 'kimi' });
    expect(service.getDefaultProvider()).toBe('moonshot');
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
    await service.set('moonshot', moonshot);
    expect(service.get('moonshot')).toEqual(moonshot);
    expect(service.list()).toEqual({ moonshot });
    expect(events).toEqual([{ added: ['moonshot'], removed: [], changed: [] }]);

    const updated: ProviderConfig = { ...moonshot, apiKey: 'sk-1' };
    await service.set('moonshot', updated);
    expect(events.at(-1)).toEqual({ added: [], removed: [], changed: ['moonshot'] });

    // Rewriting with an identical record is silent — no event fires.
    await service.set('moonshot', updated);
    expect(events).toHaveLength(2);

    await service.delete('moonshot');
    expect(service.get('moonshot')).toBeUndefined();
    expect(events.at(-1)).toEqual({ added: [], removed: ['moonshot'], changed: [] });
  });

  it('loadAll fires only for real diffs on re-sync', async () => {
    const service = createService({ moonshot: { type: 'kimi' } });
    const events: unknown[] = [];
    service.onDidChangeProviders((e) =>
      events.push({ added: e.added, removed: e.removed, changed: e.changed }),
    );

    service.loadAll({ moonshot: { type: 'kimi' } }, undefined);
    expect(events).toHaveLength(0);

    service.loadAll({ moonshot: { type: 'kimi' }, other: { baseUrl: 'https://example.com' } }, undefined);
    expect(events).toEqual([{ added: ['other'], removed: [], changed: [] }]);
  });

  it('replaceAll replaces the records and keeps the default pointer', async () => {
    const service = createService({ a: { type: 'kimi' }, b: { type: 'kimi' } });
    await service.setDefaultProvider('a');

    await service.replaceAll({ c: { type: 'kimi' } });
    expect(service.list()).toEqual({ c: { type: 'kimi' } });
    expect(service.getDefaultProvider()).toBe('a');
  });

  it('clears the defaultProvider pointer when the default provider is deleted', async () => {
    const service = createService({ moonshot: { type: 'kimi' } });
    const pointerEvents: Array<string | undefined> = [];
    service.onDidChangeDefaultProvider((e) => pointerEvents.push(e.id));

    await service.setDefaultProvider('moonshot');
    expect(service.getDefaultProvider()).toBe('moonshot');

    await service.delete('moonshot');
    expect(service.getDefaultProvider()).toBeUndefined();
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

    await service.set('moonshot', { type: 'kimi' });
    expect(persistDone).toBe(true);
  });
});

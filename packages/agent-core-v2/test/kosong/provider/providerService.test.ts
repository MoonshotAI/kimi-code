/**
 * `kosong/provider` config-surface tests — the providers config contract and
 * `IProviderService`:
 *
 *  - `ProviderTypeSchema` is free-form text: unregistered vendor names parse
 *    (validation happens at resolve time, not parse time);
 *  - the section TOML transforms round-trip snake_case ↔ camelCase;
 *  - `ProviderService` CRUD persists through config, diffs section changes
 *    into `onDidChangeProviders` (added/changed/removed), and clears
 *    `defaultProvider` when the default provider is deleted.
 */

import { describe, expect, it } from 'vitest';

import { createScopedTestHost } from '#/_base/di/test';
import { Emitter, type Event } from '#/_base/event';
import {
  type ConfigChangedEvent,
  type ConfigDiagnostic,
  type ConfigInspectValue,
  IConfigService,
  type ResolvedConfig,
} from '#/app/config/config';
import { providersFromToml, providersToToml } from '#/kosong/provider/configSection';
import '#/kosong/provider/providerService';
import {
  DEFAULT_PROVIDER_SECTION,
  IProviderService,
  type ProviderConfig,
  ProvidersSectionSchema,
} from '#/kosong/provider/provider';

class StubConfigService implements IConfigService {
  declare readonly _serviceBrand: undefined;
  readonly ready = Promise.resolve();
  private readonly _onDidChange = new Emitter<ConfigChangedEvent>();
  readonly onDidChangeConfiguration: Event<ConfigChangedEvent> = this._onDidChange.event;
  readonly onDidSectionChange: Event<ConfigChangedEvent> = this._onDidChange.event;
  private readonly _values = new Map<string, unknown>();

  get<T = unknown>(domain: string): T {
    return this._values.get(domain) as T;
  }

  inspect<T = unknown>(domain: string): ConfigInspectValue<T> {
    return {
      value: this._values.get(domain) as T | undefined,
      defaultValue: undefined,
      userValue: undefined,
      memoryValue: undefined,
    };
  }

  getAll(): ResolvedConfig {
    return Object.fromEntries(this._values) as ResolvedConfig;
  }

  set(domain: string, patch: unknown): Promise<void> {
    const previousValue = this._values.get(domain);
    const value =
      patch !== null && typeof patch === 'object'
        ? { ...(previousValue as Record<string, unknown> | undefined), ...patch }
        : patch;
    this._values.set(domain, value);
    this._onDidChange.fire({ domain, source: 'set', value, previousValue });
    return Promise.resolve();
  }

  replace(domain: string, value: unknown): Promise<void> {
    const previousValue = this._values.get(domain);
    if (value === undefined) {
      this._values.delete(domain);
    } else {
      this._values.set(domain, value);
    }
    this._onDidChange.fire({ domain, source: 'set', value, previousValue });
    return Promise.resolve();
  }

  reload(): Promise<void> {
    return Promise.resolve();
  }

  diagnostics(): readonly ConfigDiagnostic[] {
    return [];
  }
}

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
  function createHost(): {
    host: ReturnType<typeof createScopedTestHost>;
    service: IProviderService;
    config: StubConfigService;
  } {
    const config = new StubConfigService();
    const host = createScopedTestHost([[IConfigService, config]]);
    const service = host.app.accessor.get(IProviderService);
    return { host, service, config };
  }

  it('supports CRUD and diffs section changes into onDidChangeProviders', async () => {
    const { host, service } = createHost();
    try {
      const events: Array<{
        added: readonly string[];
        removed: readonly string[];
        changed: readonly string[];
      }> = [];
      service.onDidChangeProviders((e) => events.push(e));

      const moonshot: ProviderConfig = { type: 'kimi', baseUrl: 'https://api.moonshot.ai/v1' };
      await service.set('moonshot', moonshot);
      expect(service.get('moonshot')).toEqual(moonshot);
      expect(service.list()).toEqual({ moonshot });
      expect(events).toEqual([{ added: ['moonshot'], removed: [], changed: [] }]);

      const updated: ProviderConfig = { ...moonshot, apiKey: 'sk-1' };
      await service.set('moonshot', updated);
      expect(events.at(-1)).toEqual({ added: [], removed: [], changed: ['moonshot'] });

      // Rewriting with an identical record still fires the config event but
      // diffs to no changed keys.
      await service.set('moonshot', updated);
      expect(events.at(-1)).toEqual({ added: [], removed: [], changed: [] });

      await service.delete('moonshot');
      expect(service.get('moonshot')).toBeUndefined();
      expect(events.at(-1)).toEqual({ added: [], removed: ['moonshot'], changed: [] });
    } finally {
      host.dispose();
    }
  });

  it('clears defaultProvider when the default provider is deleted', async () => {
    const { host, service, config } = createHost();
    try {
      await service.set('moonshot', { type: 'kimi' });
      await config.replace(DEFAULT_PROVIDER_SECTION, 'moonshot');
      expect(config.get<string>(DEFAULT_PROVIDER_SECTION)).toBe('moonshot');

      await service.delete('moonshot');
      expect(config.get<string>(DEFAULT_PROVIDER_SECTION)).toBeUndefined();
    } finally {
      host.dispose();
    }
  });
});

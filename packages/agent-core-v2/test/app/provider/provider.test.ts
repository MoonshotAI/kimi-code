/**
 * `provider` domain tests — covers `ProviderService` CRUD over the `providers`
 * config section, schema registration, and the delete-via-replace semantics.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { DisposableStore } from '#/_base/di/lifecycle';
import { Emitter } from '#/_base/event';
import { createServices, type TestInstantiationService } from '#/_base/di/test';
import { type ConfigChangedEvent, IConfigRegistry, IConfigService } from '#/app/config/config';
import { ConfigRegistry } from '#/app/config/configService';
import {
  providersEnvBindings,
  providersFromToml,
  providersToToml,
  stripProvidersEnv,
} from '#/kosong/provider/configSection';
import {
  ENV_MODEL_PROVIDER_KEY,
  IProviderService,
  type ProviderConfig,
  PROVIDERS_SECTION,
} from '#/kosong/provider/provider';
import { ProviderService } from '#/kosong/provider/providerService';

describe('ProviderService', () => {
  let disposables: DisposableStore;
  let ix: TestInstantiationService;
  let registry: ConfigRegistry;
  let providers: Record<string, ProviderConfig>;
  let defaultProvider: string | undefined;
  let configSet: ReturnType<typeof vi.fn>;
  let configReplace: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    disposables = new DisposableStore();
    registry = new ConfigRegistry();
    providers = {};
    defaultProvider = undefined;
    configSet = vi.fn().mockResolvedValue(undefined);
    configReplace = vi.fn().mockResolvedValue(undefined);
    ix = createServices(disposables, {
      additionalServices: (reg) => {
        reg.defineInstance(IConfigRegistry, registry);
        reg.definePartialInstance(IConfigService, {
          get: ((domain: string) => {
            if (domain === PROVIDERS_SECTION) return providers;
            if (domain === 'defaultProvider') return defaultProvider;
            return undefined;
          }) as IConfigService['get'],
          set: configSet as unknown as IConfigService['set'],
          replace: configReplace as unknown as IConfigService['replace'],
          onDidChangeConfiguration: (() => ({ dispose: () => { } })) as IConfigService['onDidChangeConfiguration'],
        });
        reg.define(IProviderService, ProviderService);
      },
    });
  });
  afterEach(() => disposables.dispose());

  it('registers the providers section schema on construction', () => {
    ix.get(IProviderService);
    expect(registry.getSection(PROVIDERS_SECTION)).toMatchObject({
      domain: PROVIDERS_SECTION,
      env: providersEnvBindings,
      stripEnv: stripProvidersEnv,
    });
  });

  it('set delegates to config.set with a single-provider patch', async () => {
    const svc = ix.get(IProviderService);
    await svc.set('p1', { type: 'openai', apiKey: 'sk' });
    expect(configSet).toHaveBeenCalledWith(PROVIDERS_SECTION, {
      p1: { type: 'openai', apiKey: 'sk' },
    });
  });

  it('get reads a single provider from config', () => {
    providers['p1'] = { type: 'openai', apiKey: 'sk' };
    const svc = ix.get(IProviderService);
    expect(svc.get('p1')).toEqual({ type: 'openai', apiKey: 'sk' });
    expect(svc.get('missing')).toBeUndefined();
  });

  it('list returns all providers', () => {
    providers['p1'] = { type: 'openai' };
    providers['p2'] = { type: 'kimi' };
    const svc = ix.get(IProviderService);
    expect(svc.list()).toEqual({
      p1: { type: 'openai' },
      p2: { type: 'kimi' },
    });
  });

  it('delete removes the provider and replaces the whole section', async () => {
    providers['p1'] = { type: 'openai' };
    providers['p2'] = { type: 'kimi' };
    const svc = ix.get(IProviderService);
    await svc.delete('p1');
    expect(configReplace).toHaveBeenCalledWith(PROVIDERS_SECTION, {
      p2: { type: 'kimi' },
    });
  });

  it('delete is a no-op when the provider is absent', async () => {
    const svc = ix.get(IProviderService);
    await svc.delete('missing');
    expect(configReplace).not.toHaveBeenCalled();
  });

  it('delete clears defaultProvider when removing the default provider', async () => {
    providers['p1'] = { type: 'openai' };
    providers['p2'] = { type: 'kimi' };
    defaultProvider = 'p1';
    const svc = ix.get(IProviderService);
    await svc.delete('p1');
    expect(configReplace).toHaveBeenCalledWith(PROVIDERS_SECTION, {
      p2: { type: 'kimi' },
    });
    expect(configSet).toHaveBeenCalledWith('defaultProvider', undefined);
  });

  it('delete leaves defaultProvider when removing a different provider', async () => {
    providers['p1'] = { type: 'openai' };
    providers['p2'] = { type: 'kimi' };
    defaultProvider = 'p2';
    const svc = ix.get(IProviderService);
    await svc.delete('p1');
    expect(configSet).not.toHaveBeenCalled();
  });

  it('forwards providers section changes as onDidChangeProviders with a diff', () => {
    const configEvents = disposables.add(new Emitter<ConfigChangedEvent>());
    const local = createServices(disposables, {
      additionalServices: (reg) => {
        reg.defineInstance(IConfigRegistry, registry);
        reg.definePartialInstance(IConfigService, {
          get: (() => undefined) as unknown as IConfigService['get'],
          onDidChangeConfiguration: configEvents.event,
        });
        reg.define(IProviderService, ProviderService);
      },
    });
    const svc = local.get(IProviderService);
    const diffs: { added: readonly string[]; removed: readonly string[]; changed: readonly string[] }[] = [];
    disposables.add(svc.onDidChangeProviders((e) => diffs.push(e)));

    configEvents.fire({
      domain: PROVIDERS_SECTION,
      source: 'set',
      value: { p1: { type: 'openai' } },
      previousValue: {},
    });
    configEvents.fire({
      domain: PROVIDERS_SECTION,
      source: 'set',
      value: { p1: { type: 'kimi' } },
      previousValue: { p1: { type: 'openai' } },
    });
    configEvents.fire({
      domain: PROVIDERS_SECTION,
      source: 'set',
      value: {},
      previousValue: { p1: { type: 'kimi' } },
    });
    configEvents.fire({ domain: 'models', source: 'set', value: {}, previousValue: {} });

    expect(diffs).toEqual([
      { added: ['p1'], removed: [], changed: [] },
      { added: [], removed: [], changed: ['p1'] },
      { added: [], removed: ['p1'], changed: [] },
    ]);
  });
});

describe('provider config section helpers', () => {
  it('declares KIMI_MODEL_* bindings for the env provider', () => {
    expect(providersEnvBindings).toEqual({
      [ENV_MODEL_PROVIDER_KEY]: {
        apiKey: 'KIMI_MODEL_API_KEY',
        type: 'KIMI_MODEL_PROVIDER_TYPE',
        baseUrl: 'KIMI_MODEL_BASE_URL',
      },
    });
  });

  it('strips only the env provider before write-back', () => {
    expect(
      stripProvidersEnv({
        user: { type: 'kimi', apiKey: 'sk-user' },
        [ENV_MODEL_PROVIDER_KEY]: { type: 'openai', apiKey: 'sk-env' },
      }),
    ).toEqual({
      user: { type: 'kimi', apiKey: 'sk-user' },
    });
  });

  it('maps provider entries from TOML snake_case to camelCase', () => {
    expect(
      providersFromToml({
        kimi: {
          type: 'kimi',
          api_key: 'sk',
          base_url: 'https://api.example.com/v1',
          custom_headers: { 'X-Test': '1' },
          oauth: { storage: 'file', key: 'token', oauth_host: 'https://auth.example.com' },
        },
      }),
    ).toEqual({
      kimi: {
        type: 'kimi',
        apiKey: 'sk',
        baseUrl: 'https://api.example.com/v1',
        customHeaders: { 'X-Test': '1' },
        oauth: { storage: 'file', key: 'token', oauthHost: 'https://auth.example.com' },
      },
    });
  });

  it('maps provider entries back to TOML snake_case', () => {
    expect(
      providersToToml(
        {
          kimi: {
            type: 'kimi',
            apiKey: 'sk',
            baseUrl: 'https://api.example.com/v1',
            customHeaders: { 'X-Test': '1' },
            oauth: { storage: 'file', key: 'token', oauthHost: 'https://auth.example.com' },
          },
        },
        {},
      ),
    ).toEqual({
      kimi: {
        type: 'kimi',
        api_key: 'sk',
        base_url: 'https://api.example.com/v1',
        custom_headers: { 'X-Test': '1' },
        oauth: { storage: 'file', key: 'token', oauth_host: 'https://auth.example.com' },
      },
    });
  });
});

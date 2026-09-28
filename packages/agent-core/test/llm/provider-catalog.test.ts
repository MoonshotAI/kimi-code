import { describe, expect, it, vi } from 'vitest';
import { parse as parseToml } from 'smol-toml';

import { mountApp } from '#/app/index';
import {
  CatalogModels,
  providerCatalog,
  ProviderCatalogRef,
  useProvider,
  useProviderProtocol,
  type CatalogModelDefinition,
  type ProviderStore,
} from '#/builtin/provider-catalog/index';
import { ConfigRef, createConfig, type ConfigPersist } from '#/builtin/config/index';
import { createFeature } from '#/feature/index';
import { openAIBase } from '#/llm/builtin/protocol/openai/index';
import type { LlmModel } from '#/llm/model';
import type { Provider } from '#/llm/provider';
import type { LlmRequester } from '#/llm/requester/requester';

const modelDef: CatalogModelDefinition = {
  provider: 'test',
  model: 'm1',
  capability: {
    image_in: false,
    video_in: false,
    audio_in: false,
    thinking: false,
    tool_use: true,
  },
  maxContextSize: 4096,
};

function failingRequester(message: string): LlmRequester {
  return {
    generate: (_config, _content, { onEvent }) => {
      onEvent?.({
        type: 'llm.failed.remote',
        error: {
          kind: 'status',
          statusCode: 500,
          message,
          requestId: null,
          retryAfterMs: null,
          headers: null,
        },
      });
      return Promise.resolve();
    },
  };
}

function stubProvider(
  id: string,
  requester: LlmRequester,
  listModels: () => Promise<readonly LlmModel[]> = () => Promise.resolve([]),
): Provider {
  return {
    id,
    requesters: { openai: requester },
    listModels,
    resolveModel: () => {
      throw new Error('unused');
    },
  };
}

async function until(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 100 && !predicate(); attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  expect(predicate()).toBe(true);
}

async function mountCatalog(extra?: ReturnType<typeof createFeature>): Promise<{
  catalog: ProviderStore;
  models: () => readonly { readonly model: { readonly model: string } }[];
  dispose: () => Promise<void>;
}> {
  const app = mountApp({
    features: extra === undefined ? [providerCatalog] : [providerCatalog, extra],
  });
  await app.ready();
  return {
    catalog: app.resolve(ProviderCatalogRef),
    models: () => app.node.fold(CatalogModels),
    dispose: () => app.disposeAsync(),
  };
}

describe('providerCatalog feature', () => {
  it('contributes a provider, pings through the store, and exposes a requester binding', async () => {
    let failing = true;
    const requester: LlmRequester = {
      generate: (_config, _content, { onEvent }) => {
        if (failing) {
          onEvent?.({
            type: 'llm.failed.remote',
            error: {
              kind: 'status',
              statusCode: 500,
              message: 'boom',
              requestId: null,
              retryAfterMs: null,
              headers: null,
            },
          });
        } else {
          onEvent?.({ type: 'llm.streaming.part', part: { type: 'text', text: 'pong' } });
          onEvent?.({ type: 'llm.done' });
        }
        return Promise.resolve();
      },
    };
    const { catalog, models, dispose } = await mountCatalog(
      createFeature('probe', {
        app() {
          useProvider({ provider: stubProvider('test', requester), models: [modelDef] });
        },
      }),
    );
    await until(() => catalog.models('test').length === 1);
    await until(() => models().some((item) => item.model.model === 'm1'));
    expect(catalog.resolve('test', 'm1')?.requester).toBe(requester);

    catalog.ping('test', 'm1');
    await until(() => catalog.models('test').at(0)?.pingError === 'boom');

    failing = false;
    catalog.ping('test', 'm1');
    await until(() => catalog.models('test').at(0)?.pingError === undefined);
    await dispose();
  });

  it('ignores pings for unknown providers and models', async () => {
    const { catalog, dispose } = await mountCatalog();
    catalog.upsert({ provider: stubProvider('test', failingRequester('boom')), models: [modelDef] });
    await until(() => catalog.models('test').length === 1);

    catalog.ping('nope', 'm1');
    catalog.ping('test', 'nope');
    await new Promise((resolve) => setTimeout(resolve, 5));

    expect(catalog.models('test').at(0)?.pingError).toBeUndefined();
    expect(catalog.resolve('nope', 'm1')).toBeUndefined();
    await dispose();
  });

  it('pings through the latest provider instance after a re-upsert', async () => {
    const { catalog, dispose } = await mountCatalog();
    catalog.upsert({ provider: stubProvider('test', failingRequester('first')), models: [modelDef] });
    catalog.upsert({
      provider: stubProvider('test', failingRequester('second')),
      models: [modelDef],
    });

    catalog.ping('test', 'm1');

    await until(() => catalog.models('test').at(0)?.pingError === 'second');
    expect(catalog.resolve('test', 'm1')?.requester).toBeDefined();
    await dispose();
  });

  it('carries the model protocol flags into ping and requester', async () => {
    const seen: LlmModel[] = [];
    const requester: LlmRequester = {
      generate: (config) => {
        seen.push(config.model);
        return Promise.resolve();
      },
    };
    const provider: Provider = {
      id: 'test',
      requesters: { anthropic: requester },
      listModels: () => Promise.resolve([]),
      resolveModel: () => {
        throw new Error('unused');
      },
    };
    const { catalog, dispose } = await mountCatalog();
    catalog.upsert({
      provider,
      models: [{ ...modelDef, protocol: 'anthropic', betaApi: true }],
    });

    catalog.ping('test', 'm1');
    await until(() => seen.length > 0);
    expect(seen[0]?.betaApi).toBe(true);
    expect(catalog.resolve('test', 'm1')?.requester).toBe(requester);
    await dispose();
  });

  it('defers a ping sent while refreshing until the refresh completes', async () => {
    let pulls = 0;
    let resolvePull: (models: readonly LlmModel[]) => void = () => {};
    const provider = stubProvider('test', failingRequester('boom'), () => {
      pulls += 1;
      return new Promise((resolve) => {
        resolvePull = resolve;
      });
    });
    const { catalog, dispose } = await mountCatalog();
    catalog.upsert({ provider, models: [modelDef] });
    await until(() => pulls === 1);

    catalog.ping('test', 'm1');
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(catalog.models('test').at(0)?.pingError).toBeUndefined();

    resolvePull([]);
    await until(() => catalog.models('test').at(0)?.pingError === 'boom');
    await dispose();
  });
});


function fakePersist(initial?: string): {
  saved: string[];
  persist: ConfigPersist;
} {
  const saved: string[] = [];
  let text = initial;
  return {
    saved,
    persist: {
      load: () => Promise.resolve(text),
      save: (value) => {
        saved.push(value);
        text = value;
        return Promise.resolve();
      },
    },
  };
}

describe('providerCatalog config integration', () => {
  it('syncs config sections into the catalog and reacts to config changes', async () => {
    const file = fakePersist(
      '[providers.ghost]\nbaseUrl = "https://api.example.com"\ndefaultModel = "g1"\n\n[models.g1]\nprovider = "ghost"\nmodel = "g1"\n',
    );
    const app = mountApp({
      features: [createConfig({ persist: file.persist }), providerCatalog],
    });
    await app.ready();
    const catalog = app.resolve(ProviderCatalogRef);
    expect(catalog.providers()).toContain('ghost');
    expect(catalog.providerInfo('ghost')?.baseUrl).toBe('https://api.example.com');
    expect(catalog.models('ghost').map((model) => model.model)).toEqual(['g1']);

    const config = app.resolve(ConfigRef);
    await config.set(
      'providers',
      { ghost: { baseUrl: 'https://v2.example.com', defaultModel: 'g1' } },
      'memory',
    );
    expect(catalog.providerInfo('ghost')?.baseUrl).toBe('https://v2.example.com');

    await config.replace({ providers: {}, models: {} }, 'memory');
    expect(catalog.providers()).not.toContain('ghost');
    expect(file.saved).toHaveLength(0);
    await app.disposeAsync();
  });

  it('writes discovered models under provider-prefixed aliases, rebuilds the generated zone on refresh, and preserves user aliases', async () => {
    const file = fakePersist('[models."my-fav"]\nprovider = "test"\nmodel = "m1"\ndisplayName = "mine"\n');
    let upstream: readonly LlmModel[] = [
      { provider: 'test', model: 'm1', capability: modelDef.capability, maxContextSize: 4096 },
      { provider: 'test', model: 'm2', capability: modelDef.capability, maxContextSize: 4096 },
    ];
    const provider = stubProvider('test', failingRequester('boom'), () => Promise.resolve(upstream));
    const app = mountApp({
      features: [
        providerCatalog,
        createConfig({ persist: file.persist }),
        createFeature('probe', {
          app() {
            useProvider({ provider, models: [modelDef] });
            useProvider({
              provider: stubProvider('test2', failingRequester('boom'), () =>
                Promise.resolve([
                  { provider: 'test2', model: 'm1', capability: modelDef.capability, maxContextSize: 8192 },
                ]),
              ),
            });
          },
        }),
      ],
    });
    await app.ready();
    const catalog = app.resolve(ProviderCatalogRef);
    const readModels = (): Record<string, Record<string, unknown>> =>
      (parseToml(file.saved.at(-1)!) as { models: Record<string, Record<string, unknown>> }).models;
    await until(() => file.saved.length > 0 && readModels()['test2/m1'] !== undefined);
    expect(readModels()['test/m1']).toMatchObject({
      provider: 'test',
      model: 'm1',
      maxContextSize: 4096,
    });
    expect(readModels()['test/m2']).toMatchObject({ provider: 'test', model: 'm2' });
    expect(readModels()['test2/m1']).toMatchObject({
      provider: 'test2',
      model: 'm1',
      maxContextSize: 8192,
    });
    expect(readModels()['my-fav']).toMatchObject({
      provider: 'test',
      model: 'm1',
      displayName: 'mine',
    });

    upstream = [{ provider: 'test', model: 'm2', capability: modelDef.capability, maxContextSize: 4096 }];
    catalog.refresh(provider);
    await until(() => readModels()['test/m1'] === undefined);
    expect(readModels()['test/m2']).toBeDefined();
    expect(readModels()['test2/m1']).toBeDefined();
    expect(readModels()['my-fav']).toBeDefined();

    const settled = file.saved.length;
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(file.saved.length).toBe(settled);
    await app.disposeAsync();
  });

  it('prefers user-zone aliases over generated aliases for the same model id', async () => {
    const file = fakePersist(
      '[models."test/m1"]\nprovider = "test"\nmodel = "m1"\nmaxContextSize = 4096\n\n[models."my-fav"]\nprovider = "test"\nmodel = "m1"\ndisplayName = "mine"\n',
    );
    const app = mountApp({
      features: [createConfig({ persist: file.persist }), providerCatalog],
    });
    await app.ready();
    const catalog = app.resolve(ProviderCatalogRef);
    const m1 = catalog.models('test').find((model) => model.model === 'm1');
    expect(m1?.displayName).toBe('mine');
    await app.disposeAsync();
  });

  it('prefers config-sourced info and models over contributed ones on conflict', async () => {
    const file = fakePersist('[providers.test]\nbaseUrl = "https://config.example.com"\n');
    const app = mountApp({
      features: [
        createConfig({ persist: file.persist }),
        providerCatalog,
        createFeature('probe', {
          app() {
            useProvider({
              provider: stubProvider('test', failingRequester('boom')),
              info: { baseUrl: 'https://contributed.example.com' },
              models: [modelDef],
            });
          },
        }),
      ],
    });
    await app.ready();
    const catalog = app.resolve(ProviderCatalogRef);
    expect(catalog.providers()).toContain('test');
    expect(catalog.providerInfo('test')?.baseUrl).toBe('https://config.example.com');
    expect(catalog.models('test')).toEqual([]);
    await app.disposeAsync();
  });
});


describe('provider-catalog materialization', () => {
  it('materializes a config-declared provider, discovers models, writes them back under the alias scope, and unbinds on removal', async () => {
    const seen: { url: string; authorization?: string }[] = [];
    let upstream: readonly string[] = ['m1', 'm2'];
    vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
      seen.push({
        url: String(input),
        authorization: (init?.headers as Record<string, string> | undefined)?.['authorization'],
      });
      return new Response(JSON.stringify({ data: upstream.map((id) => ({ id })) }), {
        status: 200,
      });
    });
    try {
      const file = fakePersist(
        '[providers.acme]\ntype = "acme"\nbaseUrl = "https://acme.example.com"\nmodelSource = "discover"\naliasScope = "shared"\n\n[providers.acme.env]\napiKey = "ACME_KEY"\n',
      );
      const app = mountApp({
        features: [
          createConfig({ persist: file.persist, env: { ACME_KEY: 'sk-resolved' } }),
          providerCatalog,
          createFeature('probe', {
            app() {
              useProviderProtocol({
                type: 'acme',
                protocols: () => ({ openai: { base: openAIBase } }),
              });
            },
          }),
        ],
      });
      await app.ready();
      const catalog = app.resolve(ProviderCatalogRef);
      await until(() => seen.length > 0);
      expect(seen[0]).toEqual({
        url: 'https://acme.example.com/models',
        authorization: 'Bearer sk-resolved',
      });
      await until(() => catalog.models('acme').length === 2);
      expect(catalog.models('acme').map((model) => model.model)).toEqual(['m1', 'm2']);
      expect(catalog.models('acme').at(0)?.apiKey).toBe('sk-resolved');
      expect(catalog.resolve('acme', 'm1')?.requester).toBeDefined();
      const readModels = (): Record<string, Record<string, unknown>> =>
        (parseToml(file.saved.at(-1)!) as { models: Record<string, Record<string, unknown>> })
          .models;
      await until(() => file.saved.length > 0 && readModels()['shared/m2'] !== undefined);
      expect(readModels()['shared/m1']).toMatchObject({ provider: 'acme', model: 'm1' });
      expect(readModels()['shared/m2']).toMatchObject({ provider: 'acme', model: 'm2' });
      expect(readModels()['shared/m1']!['apiKey']).toBeUndefined();

      upstream = ['m2'];
      catalog.refresh('acme');
      await until(() => readModels()['shared/m1'] === undefined);
      expect(readModels()['shared/m2']).toBeDefined();

      const config = app.resolve(ConfigRef);
      await config.replace({ providers: {}, models: {} }, 'memory');
      expect(catalog.providers()).not.toContain('acme');
      expect(catalog.isLive('acme')).toBe(false);
      const settled = file.saved.length;
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(file.saved.length).toBe(settled);
      await app.disposeAsync();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('does not fetch models for static providers and skips oauth-catalog and unknown types', async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    try {
      const file = fakePersist(
        '[providers.acme]\ntype = "acme"\nbaseUrl = "https://acme.example.com"\napiKey = "sk-x"\n\n[providers.managed]\ntype = "acme"\nmodelSource = "oauth-catalog"\nbaseUrl = "https://managed.example.com"\n\n[providers.ghost]\ntype = "nope"\nbaseUrl = "https://ghost.example.com"\n',
      );
      const app = mountApp({
        features: [
          createConfig({ persist: file.persist }),
          providerCatalog,
          createFeature('probe', {
            app() {
              useProviderProtocol({
                type: 'acme',
                protocols: () => ({ openai: { base: openAIBase } }),
              });
            },
          }),
        ],
      });
      await app.ready();
      const catalog = app.resolve(ProviderCatalogRef);
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(fetchSpy).not.toHaveBeenCalled();
      expect(catalog.isLive('acme')).toBe(true);
      expect(catalog.isLive('managed')).toBe(false);
      expect(catalog.isLive('ghost')).toBe(false);
      await app.disposeAsync();
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

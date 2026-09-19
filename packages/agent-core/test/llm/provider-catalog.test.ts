import { describe, expect, it } from 'vitest';

import { mountApp } from '#/app/index';
import {
  CatalogModels,
  providerCatalog,
  ProviderCatalogRef,
  useProvider,
  type CatalogModelDefinition,
  type ProviderStore,
} from '#/builtin/provider-catalog/index';
import { createFeature } from '#/feature/index';
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
    protocols: ['openai'],
    listModels,
    resolveModel: () => {
      throw new Error('unused');
    },
    createRequester: () => requester,
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
    catalog: app.node.resolve(ProviderCatalogRef),
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
    expect(catalog.resolve('test', 'm1')?.createRequester()).toBe(requester);

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
    expect(catalog.resolve('test', 'm1')?.createRequester()).toBeDefined();
    await dispose();
  });

  it('carries the model protocol flags into ping and createRequester', async () => {
    const seen: LlmModel[] = [];
    const requester: LlmRequester = {
      generate: (config) => {
        seen.push(config.model);
        return Promise.resolve();
      },
    };
    const provider: Provider = {
      id: 'test',
      protocols: ['anthropic'],
      listModels: () => Promise.resolve([]),
      resolveModel: () => {
        throw new Error('unused');
      },
      createRequester: () => requester,
    };
    const { catalog, dispose } = await mountCatalog();
    catalog.upsert({
      provider,
      models: [{ ...modelDef, protocol: 'anthropic', betaApi: true }],
    });

    catalog.ping('test', 'm1');
    await until(() => seen.length > 0);
    expect(seen[0]?.betaApi).toBe(true);
    expect(catalog.resolve('test', 'm1')?.createRequester()).toBe(requester);
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

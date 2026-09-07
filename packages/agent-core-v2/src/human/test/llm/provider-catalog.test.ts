import { describe, expect, it } from 'vitest';

import type { LlmModel } from '#/llm/model';
import type { CatalogModelDefinition } from '#/llm/provider-catalog';
import { createProviderCatalog } from '#/llm/provider-catalog';
import type { Provider } from '#/llm/provider/definition';
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

describe('providerCatalog ping', () => {
  it('marks a failing model and emits changed, then clears the mark after a successful ping', async () => {
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
          onEvent?.({ type: 'llm.delta', part: { type: 'text', text: 'pong' } });
          onEvent?.({ type: 'llm.done' });
        }
        return Promise.resolve();
      },
    };
    const catalog = await createProviderCatalog();
    const changed: string[][] = [];
    catalog.onChanged((event) => changed.push([...event.providers]));
    catalog.upsert({ provider: stubProvider('test', requester), models: [modelDef] });
    await until(() => changed.length >= 2);

    changed.length = 0;
    catalog.ping('test', 'm1');
    await until(() => catalog.models('test').at(0)?.pingError === 'boom');
    expect(changed).toEqual([['test']]);

    failing = false;
    changed.length = 0;
    catalog.ping('test', 'm1');
    await until(() => changed.length > 0);
    expect(catalog.models('test').at(0)?.pingError).toBeUndefined();
    catalog.stop();
  });

  it('ignores pings for unknown providers and models', async () => {
    const catalog = await createProviderCatalog();
    const changed: string[][] = [];
    catalog.onChanged((event) => changed.push([...event.providers]));
    catalog.upsert({ provider: stubProvider('test', failingRequester('boom')), models: [modelDef] });
    await until(() => changed.length >= 2);

    changed.length = 0;
    catalog.ping('nope', 'm1');
    catalog.ping('test', 'nope');
    await new Promise((resolve) => setTimeout(resolve, 5));

    expect(changed).toEqual([]);
    expect(catalog.models('test').at(0)?.pingError).toBeUndefined();
    catalog.stop();
  });

  it('pings through the latest provider instance after a re-upsert', async () => {
    const catalog = await createProviderCatalog();
    catalog.upsert({ provider: stubProvider('test', failingRequester('first')), models: [modelDef] });
    catalog.upsert({
      provider: stubProvider('test', failingRequester('second')),
      models: [modelDef],
    });

    catalog.ping('test', 'm1');

    await until(() => catalog.models('test').at(0)?.pingError === 'second');
    expect(catalog.models('test').at(0)?.pingError).toBe('second');
    catalog.stop();
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
    const catalog = await createProviderCatalog();
    catalog.upsert({ provider, models: [modelDef] });
    await until(() => pulls === 1);

    catalog.ping('test', 'm1');
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(catalog.models('test').at(0)?.pingError).toBeUndefined();

    resolvePull([]);
    await until(() => catalog.models('test').at(0)?.pingError === 'boom');
    catalog.stop();
  });
});

import { describe, expect, it } from 'vitest';

import type { LlmRequestPart, LlmRequester as CoreLlmRequester } from '@moonshot-ai/core/llm/requester';
import {
  createMockProviderRequester,
  providerHttpError,
  type MockProviderResponse,
} from '../harness/scripted-generate';
import type { CatalogModelDefinition, CatalogProviderHandle } from '../../src/human/provider-catalog/catalog';
import { createProviderCatalog } from '../../src/human/provider-catalog/catalog';

const modelDef: CatalogModelDefinition = {
  id: 'm1',
  spec: {
    provider: 'test',
    name: 'm1',
    capability: {
      image_in: false,
      video_in: false,
      audio_in: false,
      thinking: false,
      tool_use: true,
    },
    maxContextSize: 4096,
  },
};

function doneResponse(): MockProviderResponse {
  return { parts: [{ type: 'text', text: 'pong' }] };
}

function requesterOf(
  response: MockProviderResponse | (() => MockProviderResponse),
  onWith?: (part: LlmRequestPart) => void,
): CoreLlmRequester<'protocol'> {
  const base = createMockProviderRequester(() => typeof response === 'function' ? response() : response);
  return {
    ...base,
    with: ((part: LlmRequestPart) => {
      onWith?.(part);
      return base.with(part as never);
    }) as CoreLlmRequester<'protocol'>['with'],
  };
}

function failingRequester(message: string): CoreLlmRequester<'protocol'> {
  return requesterOf(providerHttpError(503, message));
}

function stubProvider(
  id: string,
  requester: CoreLlmRequester<'protocol'>,
  listModels: () => Promise<readonly CatalogModelDefinition[]> = () => Promise.resolve([]),
): CatalogProviderHandle {
  return { id, requester, listModels };
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
    const requester = requesterOf(() => failing ? providerHttpError(503, 'boom') : doneResponse());
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

  it('carries the model protocol flags and endpoint overrides into the ping generate config', async () => {
    const seen: LlmRequestPart[] = [];
    const provider = {
      ...stubProvider('test', requesterOf(doneResponse(), (part) => seen.push(part))),
      endpoint: {
        baseUrl: 'https://provider.example.test',
        headers: { 'x-endpoint-source': 'provider' },
      },
    };
    const catalog = await createProviderCatalog();
    catalog.upsert({
      provider,
      models: [{
        ...modelDef,
        protocol: 'anthropic',
        betaApi: true,
        endpoint: {
          baseUrl: 'https://model.example.test',
          headers: { 'x-endpoint-source': 'model' },
        },
      }],
    });

    catalog.ping('test', 'm1');

    await until(() => seen.length > 0);
    expect(seen[0]?.protocol?.options).toMatchObject({ betaApi: true });
    expect(seen[0]?.endpoint).toEqual({
      baseUrl: 'https://model.example.test',
      headers: { 'x-endpoint-source': 'model' },
    });
    catalog.stop();
  });

  it('defers a ping sent while refreshing until the refresh completes', async () => {
    let pulls = 0;
    let resolvePull: (models: readonly CatalogModelDefinition[]) => void = () => {};
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

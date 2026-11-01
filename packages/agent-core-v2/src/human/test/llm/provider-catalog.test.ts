import { describe, expect, it } from 'vitest';

import type { LlmModel } from '#/llm-requester/model';
import type { LlmRequestPart, LlmRequester as CoreLlmRequester } from '#/llm/requester';
import type { LlmOutcome } from '#/llm/response';
import type { CatalogModelDefinition, CatalogProviderHandle } from '#/provider-catalog/catalog';
import { createProviderCatalog } from '#/provider-catalog/catalog';

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

function doneOutcome(): LlmOutcome {
  return {
    type: 'done',
    message: { role: 'assistant', content: [{ type: 'text', text: 'pong' }], toolCalls: [] },
  };
}

function requesterOf(
  outcome: LlmOutcome | (() => LlmOutcome),
  onWith?: (part: LlmRequestPart) => void,
): CoreLlmRequester<'protocol'> {
  const requester = {
    with: (part: LlmRequestPart) => {
      onWith?.(part);
      return requester;
    },
    request: () => {
      throw new Error('unused');
    },
    generate: async () => (typeof outcome === 'function' ? outcome() : outcome),
  };
  return requester as unknown as CoreLlmRequester<'protocol'>;
}

function failingRequester(message: string): CoreLlmRequester<'protocol'> {
  return requesterOf({ type: 'failed', error: { kind: 'provider', message } });
}

function stubProvider(
  id: string,
  requester: CoreLlmRequester<'protocol'>,
  listModels: () => Promise<readonly LlmModel[]> = () => Promise.resolve([]),
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
    const requester = requesterOf(() => (failing ? { type: 'failed', error: { kind: 'provider', message: 'boom' } } : doneOutcome()));
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

  it('carries the model protocol flags into the ping generate config', async () => {
    const seen: LlmRequestPart[] = [];
    const provider = stubProvider('test', requesterOf(doneOutcome(), (part) => seen.push(part)));
    const catalog = await createProviderCatalog();
    catalog.upsert({
      provider,
      models: [{ ...modelDef, protocol: 'anthropic', betaApi: true }],
    });

    catalog.ping('test', 'm1');

    await until(() => seen.length > 0);
    expect(seen[0]?.protocol?.options).toMatchObject({ betaApi: true });
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

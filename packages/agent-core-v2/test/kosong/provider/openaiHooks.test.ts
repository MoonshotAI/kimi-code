/**
 * `kosong/provider` compositor probes (probe 5) — `composeOpenAIChatHooks`
 * and the construction-time aggregators in `openaiHooks.ts`:
 *
 *  - pipeline hooks chain in trait order, each stage receiving the previous
 *    stage's output; `convertMessage` returning `null` at any stage drops the
 *    message and short-circuits the rest of the chain;
 *  - single-value hooks overwrite in trait order — last declarer wins;
 *  - zero declared per-request hooks → `undefined` (even when construction
 *    declarations like `endpoint` / `defaultHeaders` are present);
 *  - `traitEndpoint` concatenates env chains in trait order with
 *    `defaultBaseUrl` last-declarer-wins, `undefined` when nothing declared;
 *  - `firstProcessEnv` / `traitProvides` follow the same ordering rules.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { Message } from '#/kosong/contract/message';
import type { ProtocolTrait, ResolvedTrait, TraitContext } from '#/kosong/protocol/protocolTrait';
import {
  compactObject,
  composeOpenAIChatHooks,
  firstProcessEnv,
  traitEndpoint,
  traitProvides,
} from '#/kosong/provider/bases/openai/openaiHooks';

const context: TraitContext = { config: { protocol: 'openai', modelName: 'm' } };

function resolved(trait: ProtocolTrait): ResolvedTrait {
  return { trait, context };
}

const userMessage: Message = {
  role: 'user',
  content: [{ type: 'text', text: 'hi' }],
  toolCalls: [],
};

describe('composeOpenAIChatHooks — pipeline hooks', () => {
  it('chains convertMessage in trait order, each receiving the previous output', () => {
    const order: string[] = [];
    const hooks = composeOpenAIChatHooks([
      resolved({
        convertMessage: (_message, converted) => {
          order.push('first');
          return { ...converted, first: true };
        },
      }),
      resolved({
        convertMessage: (_message, converted) => {
          order.push('second');
          return { ...converted, second: converted['first'] === true };
        },
      }),
    ]);

    const out = hooks?.convertMessage?.(userMessage, { role: 'user' });
    expect(order).toEqual(['first', 'second']);
    expect(out).toEqual({ role: 'user', first: true, second: true });
  });

  it('drops the message when any convertMessage stage returns null and short-circuits', () => {
    let secondCalled = false;
    const hooks = composeOpenAIChatHooks([
      resolved({ convertMessage: () => null }),
      resolved({
        convertMessage: (_message, converted) => {
          secondCalled = true;
          return converted;
        },
      }),
    ]);

    expect(hooks?.convertMessage?.(userMessage, { role: 'user' })).toBeNull();
    expect(secondCalled).toBe(false);
  });

  it('chains mergeHistory and buildParams through each stage', () => {
    const hooks = composeOpenAIChatHooks([
      resolved({
        mergeHistory: (messages) => [...messages, { marker: 'a' }],
        buildParams: (params) => ({ ...params, a: 1 }),
      }),
      resolved({
        mergeHistory: (messages) =>
          messages.some((m) => m['marker'] === 'a') ? [...messages, { marker: 'b' }] : undefined,
        buildParams: (params) => ({ ...params, b: (params['a'] as number) + 1 }),
      }),
    ]);

    expect(hooks?.mergeHistory?.([{ role: 'user' }])).toEqual([
      { role: 'user' },
      { marker: 'a' },
      { marker: 'b' },
    ]);
    expect(hooks?.buildParams?.({})).toEqual({ a: 1, b: 2 });
  });
});

describe('composeOpenAIChatHooks — single-value hooks', () => {
  it('lets the last declarer win', () => {
    const hooks = composeOpenAIChatHooks([
      resolved({
        cacheKey: (key) => ({ first_would_lose: key }),
        reasoningKey: () => 'first_key',
        withThinking: () => ({ first: true }),
      }),
      resolved({
        cacheKey: (key) => ({ prompt_cache_key: key }),
        reasoningKey: () => 'reasoning_content',
        withThinking: (_effort, _options, kwargs) => ({ ...kwargs, second: true }),
      }),
    ]);

    expect(hooks?.cacheKey?.('session-1')).toEqual({ prompt_cache_key: 'session-1' });
    expect(hooks?.reasoningKey?.()).toBe('reasoning_content');
    expect(hooks?.withThinking?.('high', {}, { seeded: 1 })).toEqual({
      seeded: 1,
      second: true,
    });
  });

  it('returns undefined when no per-request hooks are declared', () => {
    expect(composeOpenAIChatHooks([])).toBeUndefined();
    expect(
      composeOpenAIChatHooks([
        resolved({
          endpoint: () => ({ apiKeyEnv: 'SOME_KEY' }),
          defaultHeaders: () => ({ 'x-a': 'b' }),
          provides: () => ({ stream: false }),
        }),
      ]),
    ).toBeUndefined();
  });
});

describe('traitEndpoint / firstProcessEnv', () => {
  const ENV_A = 'KOSONG_TEST_ENV_A';
  const ENV_B = 'KOSONG_TEST_ENV_B';

  beforeEach(() => {
    delete process.env[ENV_A];
    delete process.env[ENV_B];
  });

  afterEach(() => {
    delete process.env[ENV_A];
    delete process.env[ENV_B];
  });

  it('concatenates env chains in trait order; defaultBaseUrl is last-declarer-wins', () => {
    const endpoint = traitEndpoint([
      resolved({
        endpoint: () => ({
          apiKeyEnv: ENV_A,
          baseUrlEnv: ENV_A,
          defaultBaseUrl: 'https://first.example.com',
        }),
      }),
      resolved({
        endpoint: () => ({
          apiKeyEnv: ENV_B,
          baseUrlEnv: ENV_B,
          defaultBaseUrl: 'https://second.example.com',
        }),
      }),
    ]);

    expect(endpoint).toEqual({
      apiKeyEnv: [ENV_A, ENV_B],
      baseUrlEnv: [ENV_A, ENV_B],
      defaultBaseUrl: 'https://second.example.com',
    });

    process.env[ENV_B] = 'sk-b';
    expect(firstProcessEnv(endpoint?.apiKeyEnv)).toBe('sk-b');
    process.env[ENV_A] = 'sk-a';
    expect(firstProcessEnv(endpoint?.apiKeyEnv)).toBe('sk-a');
  });

  it('returns undefined when no trait declares an endpoint', () => {
    expect(traitEndpoint([])).toBeUndefined();
    expect(traitEndpoint([resolved({ endpoint: () => undefined })])).toBeUndefined();
    expect(firstProcessEnv(undefined)).toBeUndefined();
  });

  it('skips empty env values in the chain', () => {
    process.env[ENV_A] = '';
    process.env[ENV_B] = 'sk-b';
    expect(firstProcessEnv([ENV_A, ENV_B])).toBe('sk-b');
  });
});

describe('traitProvides / compactObject', () => {
  it('merges provides with later declarer winning per key', () => {
    const provides = traitProvides([
      resolved({ provides: () => ({ stream: false, a: 1 }) }),
      resolved({ provides: () => ({ a: 2 }) }),
    ]);
    expect(provides).toEqual({ stream: false, a: 2 });
    expect(traitProvides([])).toBeUndefined();
  });

  it('drops undefined values so absent config never clobbers provides', () => {
    expect(compactObject({ a: undefined, b: 1 })).toEqual({ b: 1 });
    expect(compactObject({})).toEqual({});
  });
});

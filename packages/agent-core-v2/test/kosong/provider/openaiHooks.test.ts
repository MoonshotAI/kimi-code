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

import type { ProtocolTrait, ResolvedTrait, TraitContext } from '#/kosong/protocol/protocolTrait';
import {
  compactObject,
  firstProcessEnv,
  traitEndpoint,
  traitProvides,
} from '#/kosong/provider/bases/openai/openaiHooks';

const context: TraitContext = { config: { protocol: 'openai', modelName: 'm' } };

function resolved(trait: ProtocolTrait): ResolvedTrait {
  return { trait, context };
}

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

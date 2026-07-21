/**
 * `kosong/protocol` base registry — registration, lookup, and ordering.
 *
 * Locks the registry contract the L2 `*.contrib.ts` modules rely on: a base
 * registers once under its id, duplicate registration throws (never silently
 * overwrites), lookup of an unregistered id returns `undefined`, and listing
 * preserves registration order so `supportedProtocols()` can be derived.
 *
 * Note: the registry is module-level state shared across this file, so each
 * test registers a distinct base id; `openai_responses` stays unregistered
 * until the final test so the early negative lookups hold.
 */

import { describe, expect, it } from 'vitest';

import type { ChatProvider } from '#/kosong/contract/provider';
import {
  getProtocolBase,
  listProtocolBases,
  registerProtocolBase,
  type ProtocolBaseContext,
  type ProtocolBaseDefinition,
  type ProtocolBaseId,
} from '#/kosong/protocol/protocolBase';
import type { ProtocolAdapterConfig } from '#/kosong/protocol/protocol';

const config: ProtocolAdapterConfig = { protocol: 'openai', modelName: 'test-model' };

const fakeChatProvider: ChatProvider = {
  name: 'fake',
  modelName: 'test-model',
  thinkingEffort: null,
  generate: () => Promise.reject(new Error('unused')),
};

function fakeBase(id: ProtocolBaseId): ProtocolBaseDefinition {
  return { id, createChatProvider: () => fakeChatProvider };
}

describe('registerProtocolBase / getProtocolBase', () => {
  it('returns the registered definition by id', () => {
    const base = fakeBase('openai');
    registerProtocolBase(base);
    expect(getProtocolBase('openai')).toBe(base);
  });

  it('returns undefined for an unregistered id', () => {
    expect(getProtocolBase('openai_responses')).toBeUndefined();
  });
});

describe('listProtocolBases', () => {
  it('lists every registered base in registration order', () => {
    const anthropic = fakeBase('anthropic');
    const googleGenAI = fakeBase('google-genai');
    registerProtocolBase(anthropic);
    registerProtocolBase(googleGenAI);
    expect(listProtocolBases()).toEqual([
      getProtocolBase('openai'),
      anthropic,
      googleGenAI,
    ]);
    expect(listProtocolBases().map((base) => base.id)).not.toContain('openai_responses');
  });
});

describe('registerProtocolBase', () => {
  it('throws on duplicate registration of the same id', () => {
    expect(() => registerProtocolBase(fakeBase('openai'))).toThrow(
      "protocol base 'openai' is already registered",
    );
    expect(getProtocolBase('openai')).toBe(listProtocolBases()[0]);
  });
});

describe('ProtocolBaseDefinition.createChatProvider', () => {
  it('receives the base context as resolved by the adapter registry', () => {
    const seen: ProtocolBaseContext[] = [];
    const base: ProtocolBaseDefinition = {
      id: 'openai_responses',
      capability: () => undefined,
      createChatProvider: (context) => {
        seen.push(context);
        return fakeChatProvider;
      },
    };
    registerProtocolBase(base);

    const context: ProtocolBaseContext = { config, traits: [] };
    const provider = getProtocolBase('openai_responses')?.createChatProvider(context);
    expect(provider).toBe(fakeChatProvider);
    expect(seen).toEqual([context]);
  });
});

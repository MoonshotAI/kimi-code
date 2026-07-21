/**
 * `kosong/protocol` trait surface — the sixteen-hook declaration shape and
 * the `traitDefaultHeaders` aggregation helper.
 *
 * Locks the trait contract: every hook is optional and takes `TraitContext`
 * as its last parameter, and header aggregation runs in trait order with
 * later declarers winning per key (the mechanism that lets config
 * `defaultHeaders`, appended as the trailing synthetic trait, always win).
 */

import { describe, expect, it } from 'vitest';

import {
  traitDefaultHeaders,
  type ProtocolTrait,
  type ResolvedTrait,
  type TraitContext,
} from '#/kosong/protocol/protocolTrait';
import type { ProtocolAdapterConfig } from '#/kosong/protocol/protocol';

const config: ProtocolAdapterConfig = { protocol: 'openai', modelName: 'test-model' };
const context: TraitContext = { config, providerId: 'vendor-x' };

function resolved(trait: ProtocolTrait): ResolvedTrait {
  return { trait, context };
}

describe('ProtocolTrait', () => {
  it('declares exactly the sixteen optional hooks', () => {
    const fullTrait: ProtocolTrait = {
      provides: () => undefined,
      endpoint: () => undefined,
      defaultHeaders: () => undefined,
      convertTool: () => undefined,
      convertMessage: (_message, converted) => converted,
      mergeHistory: () => undefined,
      buildParams: () => undefined,
      toolCallIdPolicy: () => undefined,
      withThinking: () => undefined,
      preserveThinking: () => undefined,
      withMaxCompletionTokens: () => undefined,
      cacheKey: () => undefined,
      extractUsage: () => undefined,
      reasoningKey: () => undefined,
      capability: () => undefined,
      uploadVideo: () => Promise.reject(new Error('unused')),
    };
    expect(Object.keys(fullTrait).sort()).toEqual([
      'buildParams',
      'cacheKey',
      'capability',
      'convertMessage',
      'convertTool',
      'defaultHeaders',
      'endpoint',
      'extractUsage',
      'mergeHistory',
      'preserveThinking',
      'provides',
      'reasoningKey',
      'toolCallIdPolicy',
      'uploadVideo',
      'withMaxCompletionTokens',
      'withThinking',
    ]);
  });

  it('allows the empty trait — a vendor with zero deviations', () => {
    const empty: ProtocolTrait = {};
    expect(Object.keys(empty)).toHaveLength(0);
  });
});

describe('traitDefaultHeaders', () => {
  it('returns undefined when nothing declares headers', () => {
    expect(traitDefaultHeaders([])).toBeUndefined();
    expect(traitDefaultHeaders([resolved({})])).toBeUndefined();
    expect(traitDefaultHeaders([resolved({ defaultHeaders: () => undefined })])).toBeUndefined();
  });

  it('merges in trait order, later declarer winning per key', () => {
    const first: ProtocolTrait = {
      defaultHeaders: () => ({ 'x-a': 'first', 'x-b': 'first' }),
    };
    const second: ProtocolTrait = {
      defaultHeaders: () => ({ 'x-b': 'second', 'x-c': 'second' }),
    };
    expect(traitDefaultHeaders([resolved(first), resolved(second)])).toEqual({
      'x-a': 'first',
      'x-b': 'second',
      'x-c': 'second',
    });
  });

  it('passes the bound context through to the hook', () => {
    const seen: TraitContext[] = [];
    const trait: ProtocolTrait = {
      defaultHeaders: (ctx) => {
        seen.push(ctx);
        return { 'x-a': '1' };
      },
    };
    const entry = resolved(trait);
    expect(traitDefaultHeaders([entry])).toEqual({ 'x-a': '1' });
    expect(seen).toHaveLength(1);
    expect(seen[0]).toBe(entry.context);
    expect(seen[0]?.providerId).toBe('vendor-x');
  });
});

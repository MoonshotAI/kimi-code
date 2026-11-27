import { describe, expect, it } from 'vitest';

import { anthropicProtocol } from '#/llm/builtin/protocol/anthropic/index';

import {
  runDecodeFixtures,
  runEncodeFixtures,
  runTransportFixtures,
  TEST_MODEL,
  testModule,
} from '../harness';
import { anthropicDecodeFixtures } from './fixtures/decode';
import { anthropicEncodeFixtures } from './fixtures/encode';
import { anthropicTransportFixtures } from './fixtures/transport';

describe('Anthropic encode fixtures', () => {
  runEncodeFixtures(anthropicProtocol, anthropicEncodeFixtures);
});

describe('Anthropic decode fixtures', () => {
  runDecodeFixtures(anthropicProtocol, anthropicDecodeFixtures);
});

describe('Anthropic transport fixtures', () => {
  runTransportFixtures(anthropicProtocol, anthropicTransportFixtures, 'anthropic');
});
describe('cache TTL', () => {
  it('keeps the existing cache marker when no TTL is configured', () => {
    const request = anthropicProtocol.encode(testModule({
      profile: { systemPrompt: 'Cache this system prompt.' },
    }));

    expect(request.params.system).toMatchObject([{ cache_control: { type: 'ephemeral' } }]);
  });

  it('adds the selected TTL to system, tool, and message cache markers', () => {
    const request = anthropicProtocol.encode(testModule({
      options: { cacheTtl: '1h' },
      profile: {
        systemPrompt: 'Cache this system prompt.',
        tools: [{ name: 'example', description: 'Example tool', parameters: { type: 'object' } }],
      },
    }));

    expect(request.params.system).toMatchObject([{ cache_control: { type: 'ephemeral', ttl: '1h' } }]);
    expect(request.params.tools?.at(-1)?.cache_control).toEqual({ type: 'ephemeral', ttl: '1h' });
    expect(request.params.messages.at(-1)?.content.at(-1)).toMatchObject({
      cache_control: { type: 'ephemeral', ttl: '1h' },
    });
  });
});

describe('Anthropic output token ceilings', () => {
  it.each([
    { model: 'claude-opus-5-5' },
    { model: 'claude-haiku-5-5' },
  ])('clamps compaction-sized budgets for $model', ({ model }) => {
    const request = anthropicProtocol.encode(testModule({
      model: {
        ...TEST_MODEL,
        spec: {
          ...TEST_MODEL.spec,
          provider: 'anthropic',
          name: model,
          maxContextSize: 1_000_000,
        },
        maxOutputTokens: 131_072,
      },
      usedTokens: 869_827,
    }));

    expect(request.params.max_tokens).toBe(128_000);
  });

  it('preserves smaller explicit budgets and unknown-model behavior', () => {
    const maxTokens = (model: string, maxOutputTokens?: number) => anthropicProtocol.encode(
      testModule({
        model: {
          ...TEST_MODEL,
          spec: { ...TEST_MODEL.spec, provider: 'anthropic', name: model },
          maxOutputTokens,
        },
      }),
    ).params.max_tokens;

    expect(maxTokens('claude-opus-5-5', 64_000)).toBe(64_000);
    expect(maxTokens('claude-unknown-5-5', 130_173)).toBe(130_173);
    expect(maxTokens('claude-unknown-5-5')).toBe(64_000);
  });
});

import { describe, expect, it } from 'vitest';

import { openAIProtocol } from '#/llm/builtin/protocol/openai/index';
import { openAIPipeline } from '#/llm/builtin/protocol/openai/lower';

import {
  runDecodeFixtures,
  runEncodeFixtures,
  runTransportFixtures,
} from '../harness';
import { openAIDecodeFixtures } from './fixtures/decode';
import { openAIEncodeFixtures } from './fixtures/encode';
import { openAITransportFixtures } from './fixtures/transport';

describe('OpenAI encode fixtures', () => {
  runEncodeFixtures(openAIProtocol, openAIEncodeFixtures);
});

describe('OpenAI decode fixtures', () => {
  runDecodeFixtures(openAIProtocol, openAIDecodeFixtures);
});

describe('OpenAI transport fixtures', () => {
  runTransportFixtures(openAIProtocol, openAITransportFixtures);
});

describe('openai maximum output token parameters', () => {
  it.each([
    'gpt-5',
    'gpt-5-codex',
    'gpt-6',
    'gpt-6.1-example',
    'GPT-6',
    'gpt-10',
    'gpt-99',
    'o3',
    'o4-mini',
  ])('uses max_completion_tokens for %s', (name) => {
    expect(openAIPipeline.maxOutputTokens(1000, { provider: 'openai', name })).toEqual({
      max_completion_tokens: 1000,
    });
  });

  it.each([
    'gpt-4o',
    'gpt-35-turbo',
    'GPT-35-TURBO-0613',
    'gpt-35',
    'deepseek-reasoner',
    'gpt-6custom',
    'example-gpt-6',
    'o3custom',
  ])('keeps max_tokens for %s', (name) => {
    expect(openAIPipeline.maxOutputTokens(1000, { provider: 'openai', name })).toEqual({
      max_tokens: 1000,
    });
  });

  it.each([
    { name: 'gpt-6', key: 'max_completion_tokens' },
    { name: 'gpt-35-turbo', key: 'max_tokens' },
  ])('keeps the output-token floor and ceiling for $name', ({ name, key }) => {
    const model = { provider: 'openai', name };
    expect(openAIPipeline.maxOutputTokens(0, model)).toEqual({ [key]: 1 });
    expect(openAIPipeline.maxOutputTokens(1_000_000, model)).toEqual({ [key]: 128 * 1024 });
  });
});

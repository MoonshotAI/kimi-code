import { describe } from 'vitest';

import {
  kimiAnthropicProtocol,
  kimiOpenAIProtocol,
  kimiResponsesProtocol,
} from '#/llm/builtin/provider/kimi/protocol';

import {
  runDecodeFixtures,
  runEncodeFixtures,
  runTransportFixtures,
} from '../harness';
import { kimiOpenAIDecodeFixtures } from './fixtures/decode';
import {
  kimiAnthropicEncodeFixtures,
  kimiOpenAIEncodeFixtures,
  kimiResponsesEncodeFixtures,
} from './fixtures/encode';
import {
  kimiAnthropicTransportFixtures,
  kimiOpenAITransportFixtures,
  kimiResponsesTransportFixtures,
} from './fixtures/transport';

describe('Kimi OpenAI fixtures', () => {
  runEncodeFixtures(kimiOpenAIProtocol, kimiOpenAIEncodeFixtures);
  runDecodeFixtures(kimiOpenAIProtocol, kimiOpenAIDecodeFixtures);
  runTransportFixtures(kimiOpenAIProtocol, kimiOpenAITransportFixtures);
});

describe('Kimi Responses fixtures', () => {
  runEncodeFixtures(kimiResponsesProtocol, kimiResponsesEncodeFixtures);
  runTransportFixtures(kimiResponsesProtocol, kimiResponsesTransportFixtures);
});

describe('Kimi Anthropic fixtures', () => {
  runEncodeFixtures(kimiAnthropicProtocol, kimiAnthropicEncodeFixtures);
  runTransportFixtures(kimiAnthropicProtocol, kimiAnthropicTransportFixtures);
});

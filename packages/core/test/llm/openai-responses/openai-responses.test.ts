import { describe } from 'vitest';

import { openAIResponsesProtocol } from '#/llm/builtin/protocol/openai-responses/index';

import {
  runDecodeFixtures,
  runEncodeFixtures,
  runTransportFixtures,
} from '../harness';
import { openAIResponsesDecodeFixtures } from './fixtures/decode';
import { openAIResponsesEncodeFixtures } from './fixtures/encode';
import { openAIResponsesTransportFixtures } from './fixtures/transport';

describe('OpenAI Responses encode fixtures', () => {
  runEncodeFixtures(openAIResponsesProtocol, openAIResponsesEncodeFixtures);
});

describe('OpenAI Responses decode fixtures', () => {
  runDecodeFixtures(openAIResponsesProtocol, openAIResponsesDecodeFixtures);
});

describe('OpenAI Responses transport fixtures', () => {
  runTransportFixtures(openAIResponsesProtocol, openAIResponsesTransportFixtures);
});

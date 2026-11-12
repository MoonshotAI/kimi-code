import { describe } from 'vitest';

import { openAIProtocol } from '#/llm/builtin/protocol/openai/index';

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

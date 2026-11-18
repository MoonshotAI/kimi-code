import { describe } from 'vitest';

import { googleGenAIProtocol } from '#/llm/builtin/protocol/google-genai/index';

import {
  runDecodeFixtures,
  runEncodeFixtures,
  runTransportFixtures,
} from '../harness';
import { googleGenAIDecodeFixtures } from './fixtures/decode';
import { googleGenAIEncodeFixtures } from './fixtures/encode';
import { googleGenAITransportFixtures } from './fixtures/transport';

describe('Google GenAI encode fixtures', () => {
  runEncodeFixtures(googleGenAIProtocol, googleGenAIEncodeFixtures);
});

describe('Google GenAI decode fixtures', () => {
  runDecodeFixtures(googleGenAIProtocol, googleGenAIDecodeFixtures);
});

describe('Google GenAI transport fixtures', () => {
  runTransportFixtures(googleGenAIProtocol, googleGenAITransportFixtures);
});

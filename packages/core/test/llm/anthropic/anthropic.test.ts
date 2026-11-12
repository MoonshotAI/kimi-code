import { describe } from 'vitest';

import { anthropicProtocol } from '#/llm/builtin/protocol/anthropic/index';

import {
  runDecodeFixtures,
  runEncodeFixtures,
  runTransportFixtures,
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
  runTransportFixtures(anthropicProtocol, anthropicTransportFixtures);
});

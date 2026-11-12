import type {
  AnthropicOptions,
  AnthropicRawChunk,
  AnthropicRawResponse,
} from '#/llm/builtin/protocol/anthropic/index';
import type { DecodeFixture, EncodeFixture, TransportFixture } from '../../harness';

export type AnthropicEncodeFixture = EncodeFixture<AnthropicOptions>;
export type AnthropicDecodeFixture = DecodeFixture<AnthropicOptions, AnthropicRawResponse, AnthropicRawChunk>;
export type AnthropicTransportFixture = TransportFixture<AnthropicOptions>;

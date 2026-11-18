import type { AnthropicOptions, AnthropicRawChunk, AnthropicRawResponse } from '#/llm/builtin/protocol/anthropic/index';
import type { OpenAIOptions, OpenAIRawChunk, OpenAIRawResponse } from '#/llm/builtin/protocol/openai/index';
import type { OpenAIResponsesOptions } from '#/llm/builtin/protocol/openai-responses/index';
import type { DecodeFixture, EncodeFixture, TransportFixture } from '../../harness';

export type KimiOpenAIEncodeFixture = EncodeFixture<OpenAIOptions>;
export type KimiResponsesEncodeFixture = EncodeFixture<OpenAIResponsesOptions>;
export type KimiAnthropicEncodeFixture = EncodeFixture<AnthropicOptions>;
export type KimiOpenAIDecodeFixture = DecodeFixture<OpenAIOptions, OpenAIRawResponse, OpenAIRawChunk>;
export type KimiOpenAITransportFixture = TransportFixture<OpenAIOptions>;
export type KimiResponsesTransportFixture = TransportFixture<OpenAIResponsesOptions>;
export type KimiAnthropicTransportFixture = TransportFixture<AnthropicOptions>;

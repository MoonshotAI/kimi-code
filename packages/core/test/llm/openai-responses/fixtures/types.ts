import type {
  OpenAIResponsesOptions,
  OpenAIResponsesRawChunk,
  OpenAIResponsesRawResponse,
} from '#/llm/builtin/protocol/openai-responses/index';
import type { DecodeFixture, EncodeFixture, TransportFixture } from '../../harness';

export type OpenAIResponsesEncodeFixture = EncodeFixture<OpenAIResponsesOptions>;
export type OpenAIResponsesDecodeFixture = DecodeFixture<
  OpenAIResponsesOptions,
  OpenAIResponsesRawResponse,
  OpenAIResponsesRawChunk
>;
export type OpenAIResponsesTransportFixture = TransportFixture<OpenAIResponsesOptions>;

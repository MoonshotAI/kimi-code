import type {
  OpenAIOptions,
  OpenAIRawChunk,
  OpenAIRawResponse,
} from '#/llm/builtin/protocol/openai/index';
import type { DecodeFixture, EncodeFixture, TransportFixture } from '../../harness';

export type OpenAIEncodeFixture = EncodeFixture<OpenAIOptions>;
export type OpenAIDecodeFixture = DecodeFixture<OpenAIOptions, OpenAIRawResponse, OpenAIRawChunk>;
export type OpenAITransportFixture = TransportFixture<OpenAIOptions>;

import type { GoogleGenAIOptions } from '#/llm/builtin/protocol/google-genai/index';
import type { DecodeFixture, EncodeFixture, TransportFixture } from '../../harness';

export type GoogleGenAIEncodeFixture = EncodeFixture<GoogleGenAIOptions>;
export type GoogleGenAIDecodeFixture = DecodeFixture<GoogleGenAIOptions, unknown, unknown>;
export type GoogleGenAITransportFixture = TransportFixture<GoogleGenAIOptions>;

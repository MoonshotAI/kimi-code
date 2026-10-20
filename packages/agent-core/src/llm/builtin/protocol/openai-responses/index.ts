import OpenAI from 'openai';

import type { ResolvedEndpoint } from '#/llm/endpoint';
import { headersToRecord, requestIdFromHeader } from '#/llm/protocol/kit/http';
import { defineProtocol } from '#/llm/protocol/protocol';

import { inferOpenAIFamilyCapability } from '../openai/capability';
import { decodeError } from '../openai/decode';
import { createDecoder, replay, type RawChunk, type RawResponse } from './decode';
import { openAIResponsesPipeline } from './lower';

export { sanitizeOpenAIResponsesCallId } from './lower';
export type {
  RawChunk as OpenAIResponsesRawChunk,
  RawResponse as OpenAIResponsesRawResponse,
  RawUsage as OpenAIResponsesRawUsage,
} from './decode';
export type {
  Request as OpenAIResponsesRequest,
  NativeMessage as OpenAIResponsesNativeMessage,
  NativePart as OpenAIResponsesNativePart,
  OpenAIResponsesParams,
} from './lower';

export interface OpenAIResponsesExtraParams {
  readonly temperature?: number;
  readonly top_p?: number;
  readonly include?: readonly string[];
  readonly metadata?: Record<string, string>;
  readonly parallel_tool_calls?: boolean;
  readonly service_tier?: string;
  readonly store?: boolean;
  readonly truncation?: 'auto' | 'disabled';
  readonly user?: string;
  readonly text?: { verbosity?: 'low' | 'medium' | 'high' };
  readonly reasoning?: { effort?: string; summary?: 'auto' | 'concise' | 'detailed' };
}

export interface OpenAIResponsesOptions {
  readonly extras?: OpenAIResponsesExtraParams;
}

function createClient(endpoint: ResolvedEndpoint): OpenAI {
  return new OpenAI({
    apiKey: endpoint.apiKey ?? 'unused',
    baseURL: endpoint.baseUrl,
    defaultHeaders: endpoint.headers,
    maxRetries: 0,
    fetch: endpoint.fetch,
  });
}

export const openAIResponsesProtocol = defineProtocol({
  ...openAIResponsesPipeline,
  capability: inferOpenAIFamilyCapability,
  requestId: requestIdFromHeader('x-request-id'),
  decoder: (_module, sink) => createDecoder(sink),
  replay: (response: RawResponse) => replay(response),
  decodeError,
  client: createClient,
  send: async (client: OpenAI, request, signal) => {
    const { data, response } = await client.responses
      .create({ ...request.params, stream: false }, { signal })
      .withResponse();
    return {
      body: data as unknown as RawResponse,
      headers: headersToRecord(response.headers) ?? {},
    };
  },
  sendStream: async (client: OpenAI, request, signal) => {
    const { data, response } = await client.responses
      .create({ ...request.params, stream: true }, { signal })
      .withResponse();
    return { body: data as AsyncIterable<RawChunk>, headers: headersToRecord(response.headers) ?? {} };
  },
});

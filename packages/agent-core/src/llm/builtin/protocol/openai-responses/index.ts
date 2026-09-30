import OpenAI from 'openai';

import type { ResolvedEndpoint } from '#/llm/endpoint';
import { extractText } from '#/llm/message';
import { headersToRecord, requestIdFromHeader } from '#/llm/protocol/kit/http';
import { textOnlyToolResults } from '#/llm/protocol/kit/media';
import { defineProtocol } from '#/llm/protocol/protocol';

import { inferOpenAIFamilyCapability } from '../openai/capability';
import { decodeError } from '../openai/decode';
import { createStreamDecoder, decodeResponse, type RawChunk } from './decode';
import { openAIResponsesPipeline } from './lower';

export { sanitizeOpenAIResponsesCallId } from './lower';
export type {
  RawChunk as OpenAIResponsesRawChunk,
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
  decode: (_module, response: RawChunk, sink) => decodeResponse(response, sink),
  decodeStream: () => createStreamDecoder(),
  decodeError,
  client: createClient,
  send: async (client: OpenAI, request, signal) => {
    const { data, response } = await client.responses
      .create({ ...request.params, stream: false }, { signal })
      .withResponse();
    return {
      body: data as unknown as RawChunk,
      headers: headersToRecord(response.headers) ?? {},
    };
  },
  sendStream: async (client: OpenAI, request, signal) => {
    const { data, response } = await client.responses
      .create({ ...request.params, stream: true }, { signal })
      .withResponse();
    return { body: data as AsyncIterable<unknown>, headers: headersToRecord(response.headers) ?? {} };
  },
});

export const extractToolText: Parameters<typeof openAIResponsesProtocol.with>[0] = (base) => ({
  media: textOnlyToolResults(base.media),
  message: (message, module) =>
    message.role === 'tool'
      ? [{ call_id: message.toolCallId, output: extractText(message, '\n'), type: 'function_call_output' }]
      : base.message(message, module),
});

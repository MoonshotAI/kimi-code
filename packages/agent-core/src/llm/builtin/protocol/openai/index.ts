import OpenAI from 'openai';

import type { ResolvedEndpoint } from '#/llm/endpoint';
import { headersToRecord, requestIdFromHeader } from '#/llm/protocol/kit/http';
import { defineProtocol } from '#/llm/protocol/protocol';

import { createDecoder, decodeError, replay, type RawResponse } from './decode';
import { inferOpenAICapability } from './capability';
import { openAIPipeline } from './lower';

export { KNOWN_REASONING_KEYS as OPENAI_REASONING_KEYS } from './decode';
export { resolveReasoningEffort } from './lower';

export type {
  RawChunk as OpenAIRawChunk,
  RawResponse as OpenAIRawResponse,
  RawStreamToolCallDelta as OpenAIRawStreamToolCallDelta,
  RawUsage as OpenAIRawUsage,
} from './decode';
export type {
  Request as OpenAIRequest,
  NativeMessage as OpenAINativeMessage,
  NativePart as OpenAINativePart,
  NativeToolCall as OpenAINativeToolCall,
  OpenAIParams,
} from './lower';

export interface OpenAIExtraParams {
  readonly temperature?: number;
  readonly top_p?: number;
  readonly stop?: string | readonly string[];
  readonly n?: number;
  readonly seed?: number;
  readonly presence_penalty?: number;
  readonly frequency_penalty?: number;
  readonly logit_bias?: Record<string, number>;
  readonly logprobs?: boolean;
  readonly top_logprobs?: number;
  readonly parallel_tool_calls?: boolean;
  readonly service_tier?: string;
  readonly user?: string;
  readonly extra_body?: Record<string, unknown>;
}

export interface OpenAIOptions {
  readonly extras?: OpenAIExtraParams;
  readonly reasoningKey?: string;
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

export const openAIProtocol = defineProtocol({
  ...openAIPipeline,
  capability: inferOpenAICapability,
  requestId: requestIdFromHeader('x-request-id'),
  decoder: (module, sink) => createDecoder(sink, module.options?.reasoningKey),
  replay: (response: RawResponse) => replay(response),
  decodeError,
  client: createClient,
  send: async (client: OpenAI, request, signal) => {
    const { data, response } = await client.chat.completions
      .create({ ...request.params, stream: false }, { signal })
      .withResponse();
    return { body: data as RawResponse, headers: headersToRecord(response.headers) ?? {} };
  },
  sendStream: async (client: OpenAI, request, signal) => {
    const { data, response } = await client.chat.completions
      .create(
        { ...request.params, stream: true, stream_options: { include_usage: true } },
        { signal },
      )
      .withResponse();
    return { body: data, headers: headersToRecord(response.headers) ?? {} };
  },
});

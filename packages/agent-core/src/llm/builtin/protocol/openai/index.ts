import OpenAI from 'openai';

import type { ResolvedEndpoint } from '#/llm/endpoint';
import { extractText } from '#/llm/message';
import { headersToRecord, requestIdFromHeader } from '#/llm/protocol/kit/http';
import { textOnlyToolResults } from '#/llm/protocol/kit/media';
import { defineProtocol } from '#/llm/protocol/protocol';

import {
  createStreamDecoder,
  decodeError,
  decodeResponse,
  type RawResponse,
} from './decode';
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
  decode: (module, response: RawResponse, sink) =>
    decodeResponse(response, sink, module.options?.reasoningKey),
  decodeStream: (module) => createStreamDecoder(module.options?.reasoningKey),
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

export const extractToolText: Parameters<typeof openAIProtocol.with>[0] = (base) => ({
  media: textOnlyToolResults(base.media),
  message: (message, module) =>
    base.message(
      message.role === 'tool'
        ? {
            ...message,
            content: [
              { type: 'text', text: extractText(message, '\n') },
              ...message.content.filter((part) => part.type === 'think'),
            ],
          }
        : message,
      module,
    ),
});

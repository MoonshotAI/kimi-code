import OpenAI from 'openai';

import type { ResolvedEndpoint } from '#/llm/endpoint';
import { headersToRecord } from '#/llm/errors';
import { requestIdFromHeader } from '#/llm/protocol/kit/http';
import { defineProtocol } from '#/llm/protocol/protocol';
import type { ToolMessageConversion } from '#/llm/requester/requester';

import { getOpenAILegacyModelCapability } from './capability';
import { createDecoder, decodeError, replay, type RawChunk, type RawResponse } from './decode';
import type { OpenAIExtraParams } from './extra-params';
import {
  openAIPipeline,
  type NativeMessage,
  type NativeTool,
  type OpenAIParams,
  type Request,
} from './lower';

export { KNOWN_REASONING_KEYS as OPENAI_REASONING_KEYS } from './decode';
export type {
  RawChunk as OpenAIRawChunk,
  RawResponse as OpenAIRawResponse,
  RawStreamToolCallDelta as OpenAIRawStreamToolCallDelta,
  RawUsage as OpenAIRawUsage,
} from './decode';
export {
  lowerMessage,
  openAIPipeline,
  type NativeMessage as OpenAINativeMessage,
  type OpenAILowerContext,
  type Request as OpenAIRequest,
  type NativePart as OpenAINativePart,
  type NativeToolCall as OpenAINativeToolCall,
  type OpenAIParams,
} from './lower';
export { openAIModelLegality, resolveOpenAIReasoningKey } from './legalize';

export interface OpenAIOptions {
  readonly extras?: OpenAIExtraParams;
  readonly reasoningKey?: string;
  readonly toolMessageConversion?: ToolMessageConversion;
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

export const openAIProtocol = defineProtocol<
  OpenAIOptions,
  NativeMessage,
  NativeTool,
  OpenAIParams,
  Request,
  RawResponse,
  RawChunk,
  OpenAI
>({
  ...openAIPipeline,
  capability: getOpenAILegacyModelCapability,
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

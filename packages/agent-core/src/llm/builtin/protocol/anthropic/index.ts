import Anthropic from '@anthropic-ai/sdk';

import type { ResolvedEndpoint } from '#/llm/endpoint';
import { headersToRecord, requestIdFromHeader } from '#/llm/protocol/kit/http';
import { defineProtocol } from '#/llm/protocol/protocol';

import {
  createStreamDecoder,
  decodeError,
  decodeResponse,
  type RawChunk,
  type RawResponse,
} from './decode';
import { inferAnthropicCapability } from './capability';
import { anthropicPipeline, type Request } from './lower';


export type {
  RawBlock as AnthropicRawBlock,
  RawChunk as AnthropicRawChunk,
  RawResponse as AnthropicRawResponse,
  RawUsage as AnthropicRawUsage,
} from './decode';
export type {
  AnthropicParams,
  Request as AnthropicRequest,
  NativePart as AnthropicNativePart,
  NativeMessage as AnthropicNativeMessage,
} from './lower';
export { CONTEXT_MANAGEMENT_BETA } from './lower';

export interface AnthropicExtraParams {
  readonly temperature?: number;
  readonly top_p?: number;
  readonly top_k?: number;
  readonly stop_sequences?: readonly string[];
}

export interface AnthropicOptions {
  readonly betaApi?: boolean;
  readonly extras?: AnthropicExtraParams;
}

interface ProcessGlobal {
  readonly process?: { readonly env?: Readonly<Record<string, string | undefined>> };
}

function anthropicCustomHeaderEnvNames(): string[] {
  const customHeaders = (globalThis as ProcessGlobal).process?.env?.['ANTHROPIC_CUSTOM_HEADERS'];
  if (customHeaders === undefined || customHeaders.length === 0) return [];

  const names: string[] = [];
  for (const line of customHeaders.split('\n')) {
    const colonIndex = line.indexOf(':');
    if (colonIndex < 0) continue;

    const name = line.slice(0, colonIndex).trim().toLowerCase();
    if (name.length > 0) names.push(name);
  }
  return names;
}

function buildDefaultHeaders(
  headers: Record<string, string> | undefined,
): Record<string, string | null> {
  const defaultHeaders: Record<string, string | null> = { authorization: null };
  for (const name of anthropicCustomHeaderEnvNames()) {
    defaultHeaders[name] = null;
  }
  for (const [name, value] of Object.entries(headers ?? {})) {
    defaultHeaders[name.toLowerCase()] = value;
  }
  return defaultHeaders;
}

function createClient(endpoint: ResolvedEndpoint): Anthropic {
  return new Anthropic({
    apiKey: endpoint.apiKey ?? 'unused',
    authToken: null,
    baseURL: endpoint.baseUrl ?? null,
    defaultHeaders: buildDefaultHeaders(endpoint.headers),
    maxRetries: 0,
    fetch: endpoint.fetch,
  });
}

function requestOptionsOf(request: Request, signal: AbortSignal) {
  const headers =
    !request.useBetaApi && request.betas.length > 0
      ? { 'anthropic-beta': request.betas.join(',') }
      : undefined;
  return { signal, headers };
}

export const anthropicProtocol = defineProtocol({
  ...anthropicPipeline,
  capability: inferAnthropicCapability,
  requestId: requestIdFromHeader('request-id'),
  decode: (_module, response: RawResponse, sink) => decodeResponse(response, sink),
  decodeStream: () => createStreamDecoder(),
  decodeError,
  client: createClient,
  send: async (client: Anthropic, request: Request, signal) => {
    const params = { ...request.params, stream: false as const };
    const options = requestOptionsOf(request, signal);
    const { data, response } = request.useBetaApi
      ? await client.beta.messages.create(params, options).withResponse()
      : await client.messages.create(params, options).withResponse();
    return {
      body: data as unknown as RawResponse,
      headers: headersToRecord(response.headers) ?? {},
    };
  },
  sendStream: async (client: Anthropic, request: Request, signal) => {
    const params = { ...request.params, stream: true as const };
    const options = requestOptionsOf(request, signal);
    const { data, response } = request.useBetaApi
      ? await client.beta.messages.create(params, options).withResponse()
      : await client.messages.create(params, options).withResponse();
    return {
      body: data as AsyncIterable<RawChunk>,
      headers: headersToRecord(response.headers) ?? {},
    };
  },
});

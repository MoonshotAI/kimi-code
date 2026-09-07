import Anthropic from '@anthropic-ai/sdk';

import { headersToRecord } from '#/llm/errors';
import type { LlmModel } from '#/llm/model';
import { toLlmSyntaxErrorMessage } from '#/llm/syntax-errors';
import type { ProtocolBase } from '#/llm/protocol/base';
import { resolveModelConnection, type ProtocolTrait, type TraitContext } from '#/llm/protocol/trait';
import {
  mergeRequestHeaders,
  type LlmClientContext,
  type LlmRequestConfig,
  type LlmRequestContent,
  type LlmRequestControl,
  type LlmRequester,
  type LlmRequesterOptions,
  type LlmRequestEvent,
  type ToolCallIdPolicy,
} from '#/llm/requester/requester';

import {
  normalizeToolCallIdsForProvider,
  sanitizeToolCallId,
} from '../tool-call-id';
import { getAnthropicModelCapability } from './capability';
import {
  createAnthropicFormat,
  type AnthropicFormatOptions,
  type AnthropicRequestParams,
  convertAnthropicError,
} from './format';

const ANTHROPIC_TOOL_CALL_ID_POLICY: ToolCallIdPolicy = {
  normalize: (id) => sanitizeToolCallId(id, 64),
  maxLength: 64,
};

export type AnthropicBaseOptions = AnthropicFormatOptions & LlmRequesterOptions<Anthropic>;

function anthropicCustomHeaderEnvNames(): string[] {
  const customHeaders = process.env['ANTHROPIC_CUSTOM_HEADERS'];
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

function createClient(model: LlmModel, headers: Record<string, string> | undefined): Anthropic {
  return new Anthropic({
    apiKey: model.apiKey ?? 'unused',
    authToken: null,
    baseURL: model.baseUrl ?? null,
    defaultHeaders: buildDefaultHeaders(headers),
    maxRetries: 0,
  });
}

interface AnthropicTransport {
  readonly trait: ProtocolTrait | undefined;
  readonly ctx: TraitContext;
  readonly format: ReturnType<typeof createAnthropicFormat>;
  readonly resolveClient: (request: LlmClientContext) => Anthropic;
  readonly signal: AbortSignal;
  readonly onEvent?: (event: LlmRequestEvent) => void;
}

async function internalGenerate(
  request: AnthropicRequestParams,
  transport: AnthropicTransport,
): Promise<void> {
  const { trait, ctx, format, resolveClient, signal, onEvent } = transport;
  const client = resolveClient({
    model: ctx.model,
    headers: mergeRequestHeaders(trait?.defaultHeaders?.(ctx), ctx.model.defaultHeaders),
  });
  onEvent?.({ type: 'llm.sent' });
  const betaHeaders =
    !request.useBetaApi && request.betas.length > 0
      ? { 'anthropic-beta': request.betas.join(',') }
      : undefined;
  const requestOptions = { signal, headers: betaHeaders };
  const { data: stream, response } = request.useBetaApi
    ? await client.beta.messages.create(request.params, requestOptions).withResponse()
    : await client.messages.create(request.params, requestOptions).withResponse();
  onEvent?.({ type: 'llm.headers', headers: headersToRecord(response.headers) ?? {} });
  const parse = format.createStreamParser({ trait, ctx });
  let messageId: string | undefined;
  for await (const event of stream) {
    let failed = false;
    parse(event, {
      onDelta: (part) => onEvent?.({ type: 'llm.delta', part }),
      onFinish: (finish) => onEvent?.({ type: 'llm.finish', finish }),
      onMessageId: (id) => {
        if (id === messageId) return;
        messageId = id;
        onEvent?.({ type: 'llm.message-id', messageId: id });
      },
      onUsage: (usage) => onEvent?.({ type: 'llm.usage', usage }),
      onError: (message) => {
        failed = true;
        onEvent?.({ type: 'llm.failed.remote', error: message });
      },
    });
    if (failed) {
      return;
    }
  }
  onEvent?.({ type: 'llm.done' });
}

export function createAnthropicRequester(
  trait?: ProtocolTrait,
  options?: AnthropicBaseOptions,
): LlmRequester {
  const format = createAnthropicFormat(options);
  const resolveClient =
    options?.clientFactory ??
    ((request: LlmClientContext) => createClient(request.model, request.headers));
  return {
    async generate(
      config: LlmRequestConfig,
      content: LlmRequestContent,
      control: LlmRequestControl,
    ): Promise<void> {
      const model = resolveModelConnection(config.model, trait);
      const { systemPrompt, tools = [] } = config;
      const { messages } = content;
      const { signal, onEvent } = control;
      const ctx: TraitContext = { model };
      let request: AnthropicRequestParams;
      try {
        const policy = trait?.toolCallIdPolicy?.(ctx) ?? ANTHROPIC_TOOL_CALL_ID_POLICY;
        request = format.formatRequest({
          model,
          messages: normalizeToolCallIdsForProvider(messages, policy),
          systemPrompt,
          tools,
          trait,
          ctx,
          cacheKey: config.cacheKey,
          thinking: config.thinking,
          responseFormat: config.responseFormat,
          maxCompletionTokens: config.maxCompletionTokens,
          usedContextTokens: content.usedContextTokens,
          maxContextTokens: config.maxContextTokens,
          extraParams: config.extraParams,
        });
      } catch (error) {
        onEvent?.({ type: 'llm.failed.syntax', error: toLlmSyntaxErrorMessage(error) });
        return;
      }
      try {
        await internalGenerate(request, { trait, ctx, format, resolveClient, signal, onEvent });
      } catch (error) {
        onEvent?.({
          type: 'llm.failed.remote',
          error: convertAnthropicError(error, (e) => trait?.convertError?.(e, ctx)),
        });
      }
    },
  };
}

export function createAnthropicBase(options?: AnthropicBaseOptions): ProtocolBase {
  return {
    capability: getAnthropicModelCapability,
    createRequester: (trait?: ProtocolTrait) => createAnthropicRequester(trait, options),
  };
}

export const anthropicBase: ProtocolBase = createAnthropicBase();

export const anthropicBetaBase: ProtocolBase = createAnthropicBase({ betaApi: true });

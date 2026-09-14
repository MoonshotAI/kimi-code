import Anthropic from '@anthropic-ai/sdk';
import { assign, shake } from 'radashi';

import { headersToRecord } from '#/llm/errors';
import { providerImagePolicy } from '#/llm/media/image-formats';
import type { LlmModel } from '#/llm/model';
import { toLlmSyntaxErrorMessage } from '#/llm/syntax-errors';
import type { ProtocolBase, ProtocolRequesterOptions, TraitContext } from '#/llm/protocol/base';
import { resolveModelConnection } from '#/llm/protocol/connection';
import { applyThinking } from '#/llm/protocol/thinking';
import { resolveMaxCompletionCap, type FormatRequestInput } from '#/llm/protocol/format';
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
import type { AnthropicTrait } from './trait';
import {
  applyAnthropicResponseFormat,
  applyAnthropicThinkingKeep,
  assembleAnthropicRequest,
  createAnthropicFormat,
  defaultAnthropicMergeHistory,
  defaultAnthropicTool,
  encodeAnthropicMaxTokens,
  encodeAnthropicRequest,
  lowerAnthropicRequest,
  type AnthropicFormatOptions,
  type AnthropicRequestParams,
  convertAnthropicError,
} from './format';
import { isAnthropicWireMessageEmpty } from './lower';
import { encodeThinking, INTERLEAVED_THINKING_BETA, resolveDefaultMaxTokens } from './profile';

const ANTHROPIC_TOOL_CALL_ID_POLICY: ToolCallIdPolicy = {
  normalize: (id) => sanitizeToolCallId(id, 64),
  maxLength: 64,
};

export interface AnthropicRequesterOptions
  extends ProtocolRequesterOptions<AnthropicTrait>,
    AnthropicFormatOptions,
    LlmRequesterOptions<Anthropic> {}

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

export interface AnthropicRequestPlanOptions {
  readonly trait?: AnthropicTrait;
  readonly betaApi?: boolean;
}

export function planAnthropicRequest(
  input: FormatRequestInput,
  options?: AnthropicRequestPlanOptions,
): AnthropicRequestParams {
  const trait = options?.trait;
  const ctx: TraitContext = { model: input.model };
  let kwargs: Record<string, unknown> = { betaFeatures: [INTERLEAVED_THINKING_BETA] };
  if (input.thinking !== undefined) {
    kwargs = applyThinking(kwargs, input.thinking, trait?.thinking, ctx, (t, c) =>
      encodeThinking(t, c.model),
    ).kwargs;
  }
  if (input.responseFormat !== undefined) {
    kwargs = applyAnthropicResponseFormat(kwargs, input.responseFormat);
  }
  const cap = resolveMaxCompletionCap(input);
  if (cap !== undefined) {
    const capped = resolveDefaultMaxTokens(ctx.model.model, cap);
    kwargs = {
      ...kwargs,
      ...(trait?.maxCompletionTokens?.(capped, ctx) ?? encodeAnthropicMaxTokens(capped)),
    };
  }
  kwargs = assign(kwargs, input.extraParams?.anthropic ?? {});
  if (input.thinking?.keep !== undefined) {
    kwargs = applyAnthropicThinkingKeep(kwargs, input.thinking.keep);
  }
  kwargs = shake(kwargs);

  const acceptedMimes =
    trait?.acceptedImageMimes?.(ctx) ?? providerImagePolicy().acceptedMimes;
  const lowered = lowerAnthropicRequest(input, acceptedMimes);
  const converted = lowered
    .flatMap(({ source, message }) => {
      if (trait?.convertMessage === undefined) {
        return [message];
      }
      const hooked = trait.convertMessage(source, message, ctx);
      return hooked === null ? [] : [hooked];
    })
    .filter((message) => !isAnthropicWireMessageEmpty(message));
  const merged = trait?.mergeHistory?.(converted, ctx) ?? defaultAnthropicMergeHistory(converted);
  const tools = input.tools.map(
    (tool) => trait?.convertTool?.(tool, ctx) ?? defaultAnthropicTool(tool),
  );
  const assembly = assembleAnthropicRequest(input, {
    messages: merged,
    tools,
    kwargs,
    betaApi: options?.betaApi === true,
  });
  const finalParams = trait?.buildParams?.(assembly.params, ctx) ?? assembly.params;
  return encodeAnthropicRequest({ ...assembly, params: finalParams });
}

interface AnthropicTransport {
  readonly connection: AnthropicRequesterOptions['connection'];
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
  const { connection, ctx, format, resolveClient, signal, onEvent } = transport;
  const client = resolveClient({
    model: ctx.model,
    headers: mergeRequestHeaders(connection?.defaultHeaders?.(ctx), ctx.model.defaultHeaders),
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
  onEvent?.({ type: 'llm.streaming.headers', headers: headersToRecord(response.headers) ?? {} });
  const parse = format.createStreamParser();
  let messageId: string | undefined;
  for await (const event of stream) {
    let failed = false;
    parse(event, {
      onDelta: (part) => onEvent?.({ type: 'llm.streaming.part', part }),
      onFinish: (finish) => onEvent?.({ type: 'llm.streaming.finish', finish }),
      onMessageId: (id) => {
        if (id === messageId) return;
        messageId = id;
        onEvent?.({ type: 'llm.streaming.message_id', messageId: id });
      },
      onUsage: (usage) => onEvent?.({ type: 'llm.streaming.usage', usage }),
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

export function createAnthropicRequester(options?: AnthropicRequesterOptions): LlmRequester {
  const connection = options?.connection;
  const trait = options?.trait;
  const convertError = options?.convertError;
  const format = createAnthropicFormat();
  const resolveClient =
    options?.clientFactory ??
    ((request: LlmClientContext) => createClient(request.model, request.headers));
  return {
    async generate(
      config: LlmRequestConfig,
      content: LlmRequestContent,
      control: LlmRequestControl,
    ): Promise<void> {
      const model = resolveModelConnection(config.model, connection);
      const { tools = [] } = config;
      const { messages } = content;
      const { signal, onEvent } = control;
      const ctx: TraitContext = { model };
      let request: AnthropicRequestParams;
      try {
        const policy = trait?.toolCallIdPolicy ?? ANTHROPIC_TOOL_CALL_ID_POLICY;
        request = planAnthropicRequest(
          {
            ...config,
            model,
            messages: normalizeToolCallIdsForProvider(messages, policy),
            tools,
            usedContextTokens: content.usedContextTokens,
          },
          { trait, betaApi: options?.betaApi },
        );
      } catch (error) {
        onEvent?.({ type: 'llm.failed.syntax', error: toLlmSyntaxErrorMessage(error) });
        return;
      }
      try {
        await internalGenerate(request, {
          connection,
          ctx,
          format,
          resolveClient,
          signal,
          onEvent,
        });
      } catch (error) {
        onEvent?.({
          type: 'llm.failed.remote',
          error: convertAnthropicError(error, (e) => convertError?.(e)),
        });
      }
    },
  };
}

export function createAnthropicBase(
  options?: AnthropicFormatOptions & LlmRequesterOptions<Anthropic>,
): ProtocolBase<AnthropicTrait> {
  return {
    capability: getAnthropicModelCapability,
    createRequester: (requesterOptions) => createAnthropicRequester({ ...options, ...requesterOptions }),
  };
}

export const anthropicBase: ProtocolBase<AnthropicTrait> = createAnthropicBase();

export const anthropicBetaBase: ProtocolBase<AnthropicTrait> = createAnthropicBase({
  betaApi: true,
});

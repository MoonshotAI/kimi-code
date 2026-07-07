/**
 * `llmRequester` domain (L3) — `IAgentLLMRequesterService` implementation.
 *
 * Thin shell over the god-object `Model` (App scope). Assembles per-turn
 * `LLMRequestInput` from `profile` (system prompt), `contextMemory` +
 * `contextProjector` (history), and `toolRegistry` (tools), applies the
 * completion-token budget, then drives `model.request(input, signal)` with
 * bounded retry. Forwards streamed `part` events to the caller's `onPart`
 * handler, records `usage` through `IAgentUsageService`, resolves to an
 * `LLMRequestFinish` on the `finish` event, logs the request lifecycle
 * (config deduplicated by content, request/response/failure lines, plus
 * per-request fields) through `log`, and reports provider failures through
 * `telemetry`. Bound at Agent scope.
 */

import { createHash } from 'node:crypto';
import { InstantiationType } from '#/_base/di/extensions';
import { LifecycleScope, registerScopedService } from '#/_base/di/scope';
import { IAgentContextMemoryService } from '#/agent/contextMemory/contextMemory';
import { IAgentContextProjectorService } from '#/agent/contextProjector/contextProjector';
import { IAgentContextSizeService } from '#/agent/contextSize/contextSize';
import { IAgentProfileService } from '#/agent/profile/profile';
import { IAgentToolRegistryService } from '#/agent/toolRegistry/toolRegistry';
import { IAgentUsageService } from '#/agent/usage/usage';
import { IConfigService } from '#/app/config/config';
import {
  APIConnectionError,
  APIContextOverflowError,
  APIEmptyResponseError,
  APIStatusError,
  APITimeoutError,
  isContextOverflowStatusError,
  isRecoverableRequestStructureError,
  isRetryableGenerateError,
} from '#/app/llmProtocol/errors';
import { type Message } from '#/app/llmProtocol/message';
import { type ThinkingEffort } from '#/app/llmProtocol/thinkingEffort';
import { type Tool } from '#/app/llmProtocol/tool';
import { emptyUsage, type TokenUsage } from '#/app/llmProtocol/usage';
import { ILogService, type LogContext } from '#/_base/log/log';
import type { Model, LLMEvent as ModelRequestEvent } from '#/app/model/modelInstance';
import type { KimiModelOverrides } from '#/app/model/modelOverrides';
import { applyCompletionBudget, resolveCompletionBudget } from '#/app/model/completionBudget';
import type { Protocol } from '#/app/protocol/protocol';
import { ITelemetryService } from '#/app/telemetry/telemetry';

import type {
  LLMRequestFinish,
  LLMRequestLogFields,
  LLMRequestOverrides,
  LLMRequestPartHandler,
  LLMRequestSource,
  LLMStreamTiming,
} from './llmRequester';
import { IAgentLLMRequesterService } from './llmRequester';
import {
  DEFAULT_MAX_RETRY_ATTEMPTS,
  isAbortError,
  retryBackoffDelays,
  retryErrorFields,
  sleepForRetry,
} from './retry';

const EMPTY_TOOL_PARAMETERS: Record<string, unknown> = {
  type: 'object',
  properties: {},
};

const noopOnPart: LLMRequestPartHandler = () => {};

interface ResolvedLLMRequest {
  readonly model: Model;
  readonly modelAlias: string;
  readonly systemPrompt: string;
  readonly tools: readonly Tool[];
  readonly messages: Message[];
  readonly source: LLMRequestSource | undefined;
  readonly logFields: LLMRequestLogFields;
}

interface LLMRequestLogInput {
  readonly protocol: Protocol;
  readonly modelName: string;
  readonly modelAlias?: string;
  readonly thinkingEffort?: ThinkingEffort | null;
  readonly systemPrompt: string;
  readonly tools: readonly Tool[];
  readonly messages: readonly Message[];
  readonly fields?: LLMRequestLogFields;
}

export class AgentLLMRequesterService implements IAgentLLMRequesterService {
  declare readonly _serviceBrand: undefined;

  private lastConfigLogSignature: string | undefined;

  constructor(
    @IAgentContextMemoryService private readonly context: IAgentContextMemoryService,
    @IAgentContextProjectorService private readonly projector: IAgentContextProjectorService,
    @IAgentContextSizeService private readonly contextSize: IAgentContextSizeService,
    @IAgentToolRegistryService private readonly tools: IAgentToolRegistryService,
    @IAgentProfileService private readonly profile: IAgentProfileService,
    @IAgentUsageService private readonly usage: IAgentUsageService,
    @IConfigService private readonly config: IConfigService,
    @ILogService private readonly log: ILogService,
    @ITelemetryService private readonly telemetry: ITelemetryService,
  ) {}

  async request(
    overrides: LLMRequestOverrides = {},
    onPart: LLMRequestPartHandler = noopOnPart,
    signal?: AbortSignal,
  ): Promise<LLMRequestFinish> {
    signal?.throwIfAborted();
    return this.requestWithRetry(overrides, onPart, signal);
  }

  private async requestWithRetry(
    overrides: LLMRequestOverrides,
    onPart: LLMRequestPartHandler,
    signal: AbortSignal | undefined,
  ): Promise<LLMRequestFinish> {
    const startedAt = Date.now();
    const maxAttempts = Math.max(overrides.retry?.maxAttempts ?? DEFAULT_MAX_RETRY_ATTEMPTS, 1);

    if (maxAttempts <= 1) {
      try {
        return await this.executeRequestAttempt(overrides, onPart, signal, 1, maxAttempts);
      } catch (error) {
        this.logRequestFailure(error, overrides, signal, 1, maxAttempts);
        this.trackApiError(error, startedAt, signal);
        throw error;
      }
    }

    const delays = retryBackoffDelays(maxAttempts);
    for (let attempt = 1; ; attempt += 1) {
      try {
        return await this.executeRequestAttempt(overrides, onPart, signal, attempt, maxAttempts);
      } catch (error) {
        if (attempt >= maxAttempts || !isRetryableGenerateError(error)) {
          this.logRequestFailure(error, overrides, signal, attempt, maxAttempts);
          this.trackApiError(error, startedAt, signal);
          throw error;
        }

        signal?.throwIfAborted();
        const delayMs = delays[attempt - 1] ?? 0;
        await overrides.retry?.onRetry?.({
          failedAttempt: attempt,
          nextAttempt: attempt + 1,
          maxAttempts,
          delayMs,
          ...retryErrorFields(error),
        });
        await sleepForRetry(delayMs, signal);
      }
    }
  }

  private async executeRequestAttempt(
    overrides: LLMRequestOverrides,
    onPart: LLMRequestPartHandler,
    signal: AbortSignal | undefined,
    attempt: number,
    maxAttempts: number,
  ): Promise<LLMRequestFinish> {
    signal?.throwIfAborted();
    const request = this.resolveRequest(
      overrides,
      attempt === 1 ? undefined : { attempt: `${String(attempt)}/${String(maxAttempts)}` },
    );
    return this.runRequest(request, onPart, signal);
  }

  private logRequestFailure(
    error: unknown,
    overrides: LLMRequestOverrides,
    signal: AbortSignal | undefined,
    attempt: number,
    maxAttempts: number,
  ): void {
    if (isAbortError(error) || signal?.aborted === true) return;
    const payload: LogContext = {
      ...logFieldsForSource(overrides.source),
      attempt: `${String(attempt)}/${String(maxAttempts)}`,
      model: this.profile.data().modelAlias ?? 'unknown',
      ...retryErrorFields(error),
    };
    this.log.warn('llm request failed', payload);
  }

  private trackApiError(
    error: unknown,
    startedAt: number,
    signal: AbortSignal | undefined,
  ): void {
    if (isAbortError(error) || signal?.aborted === true) return;
    const properties: Record<string, unknown> = {
      error_type: apiErrorType(error),
      model: this.profile.data().modelAlias ?? 'unknown',
      retryable: isRetryableGenerateError(error),
      duration_ms: Math.max(0, Date.now() - startedAt),
    };
    const statusCode = apiStatusCode(error);
    if (statusCode !== undefined) properties['status_code'] = statusCode;
    this.telemetry.track('api_error', properties);
  }

  private async runRequest(
    request: ResolvedLLMRequest,
    onPart: LLMRequestPartHandler,
    signal: AbortSignal | undefined,
  ): Promise<LLMRequestFinish> {
    this.logRequest({
      protocol: request.model.protocol,
      modelName: request.model.name,
      modelAlias: request.modelAlias,
      thinkingEffort: request.model.thinkingEffort,
      systemPrompt: request.systemPrompt,
      tools: request.tools,
      messages: request.messages,
      fields: request.logFields,
    });

    const requestInput = (strict: boolean) => ({
      systemPrompt: request.systemPrompt,
      tools: request.tools,
      messages: strict
        ? this.projector.projectStrict(request.messages)
        : this.projector.project(request.messages),
    });

    const run = async (strict: boolean): Promise<LLMRequestFinish> => {
      let message: Message | undefined;
      let usage = emptyUsage();
      let timing: LLMStreamTiming | undefined;
      let finish: Extract<ModelRequestEvent, { type: 'finish' }> | undefined;

      for await (const event of request.model.request(requestInput(strict), signal)) {
        switch (event.type) {
          case 'part':
            await onPart(event.part);
            break;
          case 'usage':
            usage = event.usage;
            break;
          case 'finish':
            finish = event;
            message = event.message;
            break;
          case 'timing': {
            const { type: _type, ...streamTiming } = event;
            timing = streamTiming;
            break;
          }
        }
      }

      if (message === undefined || finish === undefined) {
        throw new Error('LLM request stream ended without a finish event.');
      }

      const usageModel = request.modelAlias;
      this.usage.record(usageModel, usage, request.source);
      this.contextSize.measured(request.messages, [message], usage);
      this.logResponse(request.logFields, usage, timing);

      return {
        message,
        usage,
        model: usageModel,
        providerFinishReason: finish.providerFinishReason,
        rawFinishReason: finish.rawFinishReason,
        providerMessageId: finish.id,
        timing,
      };
    };

    try {
      return await run(false);
    } catch (error) {
      if (signal?.aborted === true || !isRecoverableRequestStructureError(error)) throw error;
      signal?.throwIfAborted();
      this.log.warn('provider rejected request structure; resending with strict projection', {
        model: request.model.name,
        ...request.logFields,
      });
      return run(true);
    }
  }

  private resolveRequest(
    overrides: LLMRequestOverrides,
    extraLogFields?: LLMRequestLogFields,
  ): ResolvedLLMRequest {
    const resolved = this.profile.resolveModelContext();
    let model = this.profile.getProvider();
    model = applyCompletionBudget({
      model,
      budget: resolveCompletionBudget({
        maxOutputSize: overrides.maxOutputSize ?? resolved.maxOutputSize,
        reservedContextSize: resolved.reservedContextSize,
        maxCompletionTokensCap:
          this.config.get<KimiModelOverrides>('modelOverrides')?.maxCompletionTokens,
      }),
      capability: resolved.modelCapabilities,
      // The remaining-window clamp only applies to requests built from the
      // live context; overridden messages (e.g. compaction) are sized
      // independently and would be squeezed to nothing at high water marks.
      usedContextTokens:
        overrides.messages === undefined
          ? this.contextSize.get().measured
          : undefined,
    });

    const messages = overrides.messages ?? this.context.get();
    return {
      model,
      modelAlias: resolved.modelAlias,
      systemPrompt: overrides.systemPrompt ?? this.profile.getSystemPrompt(),
      tools: [...(overrides.tools ?? this.defaultTools())],
      messages: [...messages],
      source: overrides.source,
      logFields: logFieldsForSource(overrides.source, extraLogFields),
    };
  }

  private logRequest(input: LLMRequestLogInput): void {
    const logFields: LLMRequestLogFields = input.fields ?? {};
    const config = {
      provider: input.protocol,
      model: input.modelName,
      modelAlias: input.modelAlias,
      thinkingEffort: input.thinkingEffort ?? undefined,
      systemPromptChars: input.systemPrompt.length,
      toolCount: input.tools.length,
    };
    const signature = JSON.stringify({
      ...config,
      systemPromptHash: fingerprint(input.systemPrompt),
      toolsHash: fingerprint(JSON.stringify(toolSignature(input.tools))),
    });
    if (signature !== this.lastConfigLogSignature) {
      this.lastConfigLogSignature = signature;
      this.log.info('llm config', { ...logFields, ...config });
    }

    const partialMessageCount = input.messages.filter((message) => message.partial === true).length;
    const requestFields: LogContext = { ...logFields };
    if (partialMessageCount > 0) requestFields['partialMessageCount'] = partialMessageCount;
    this.log.info('llm request', requestFields);
  }

  private logResponse(
    fields: LLMRequestLogFields | undefined,
    usage: TokenUsage,
    timing: LLMStreamTiming | undefined,
  ): void {
    if (timing === undefined) return;
    const payload: LogContext = {
      ...fields,
      ttftMs: timing.firstTokenLatencyMs,
      streamDurationMs: timing.streamDurationMs,
      outputTokens: usage.output,
    };
    if (timing.requestBuildMs !== undefined) payload['requestBuildMs'] = timing.requestBuildMs;
    if (timing.serverFirstTokenMs !== undefined) {
      payload['serverFirstTokenMs'] = timing.serverFirstTokenMs;
    }
    if (timing.serverDecodeMs !== undefined) payload['serverDecodeMs'] = timing.serverDecodeMs;
    if (timing.clientConsumeMs !== undefined) payload['clientConsumeMs'] = timing.clientConsumeMs;
    this.log.info('llm response', payload);
  }

  private defaultTools(): readonly Tool[] {
    return this.tools
      .list()
      .filter((tool) => this.profile.isToolActive(tool.name, tool.source))
      .map((tool) => ({
        name: tool.name,
        description: tool.description,
        parameters: tool.parameters ?? EMPTY_TOOL_PARAMETERS,
      }));
  }
}

function logFieldsForSource(
  source: LLMRequestSource | undefined,
  extraFields?: LLMRequestLogFields,
): LLMRequestLogFields {
  switch (source?.type) {
    case 'turn':
      return {
        ...source.logFields,
        ...(source.step === undefined
          ? {}
          : { turnStep: `${String(source.turnId)}.${String(source.step)}` }),
        ...extraFields,
      };
    case 'operation':
      return {
        ...source.logFields,
        ...(source.requestKind === undefined ? {} : { requestKind: source.requestKind }),
        ...extraFields,
      };
    default:
      return extraFields ?? {};
  }
}

function toolSignature(tools: readonly Tool[]) {
  return tools.map(({ name, description, parameters }) => ({ name, description, parameters }));
}

function fingerprint(content: string): string {
  return createHash('sha256').update(content).digest('hex');
}

function apiErrorType(error: unknown): string {
  if (error instanceof APIContextOverflowError) return 'context_overflow';
  if (error instanceof APIStatusError) {
    if (isContextOverflowStatusError(error.statusCode, error.message)) return 'context_overflow';
    if (error.statusCode === 429) return 'rate_limit';
    if (error.statusCode === 401 || error.statusCode === 403) return 'auth';
    if (error.statusCode >= 500) return '5xx_server';
    if (error.statusCode >= 400) return '4xx_client';
  }
  if (error instanceof APIConnectionError) return 'network';
  if (error instanceof APITimeoutError) return 'timeout';
  if (error instanceof APIEmptyResponseError) return 'empty_response';
  return 'other';
}

function apiStatusCode(error: unknown): number | undefined {
  if (error instanceof APIStatusError) return error.statusCode;
  if (typeof error !== 'object' || error === null) return undefined;
  const statusCode = (error as Record<string, unknown>)['statusCode'];
  if (typeof statusCode === 'number') return statusCode;
  const status = (error as Record<string, unknown>)['status'];
  return typeof status === 'number' ? status : undefined;
}

registerScopedService(
  LifecycleScope.Agent,
  IAgentLLMRequesterService,
  AgentLLMRequesterService,
  InstantiationType.Delayed,
  'llmRequester',
);

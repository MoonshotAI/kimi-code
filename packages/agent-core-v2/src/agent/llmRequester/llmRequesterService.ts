/**
 * `llmRequester` domain (L3) — `IAgentLLMRequesterService` implementation.
 *
 * Thin shell over the god-object `Model` (App scope). Assembles per-turn
 * `LLMRequestInput` from `profile` (system prompt), `contextMemory` +
 * `contextProjector` (history), `toolRegistry` (tools), and `toolSelect`
 * (progressive-disclosure shaping of the tool and history views), applies the
 * completion-token budget, then drives a single `model.request(input, signal)`
 * attempt — retry policy lives in the loop's `stepRetry` plugin, not here.
 * Forwards streamed `part` events to the caller's `onPart`
 * handler, records `usage` through `IAgentUsageService`, resolves to an
 * `LLMRequestFinish` on the `finish` event, logs the request lifecycle
 * (config deduplicated by content, request/response/failure lines, plus
 * per-request fields) through `log`, records durable request-trace Ops
 * through `wire`, and reports provider failures through `telemetry`. Bound
 * at Agent scope.
 */

import { createHash } from 'node:crypto';
import { InstantiationType } from '#/_base/di/extensions';
import { LifecycleScope, registerScopedService } from '#/_base/di/scope';
import { IAgentContextMemoryService } from '#/agent/contextMemory/contextMemory';
import { IAgentContextProjectorService } from '#/agent/contextProjector/contextProjector';
import { IAgentContextSizeService } from '#/agent/contextSize/contextSize';
import {
  IFaultInjectionService,
  type FaultKind,
} from '#/agent/faultInjection/faultInjection';
import { IAgentProfileService, type ProfileModelContext } from '#/agent/profile/profile';
import { IAgentToolRegistryService } from '#/agent/toolRegistry/toolRegistry';
import { IAgentToolSelectService } from '#/agent/toolSelect/toolSelect';
import { IAgentUsageService } from '#/agent/usage/usage';
import { IConfigService } from '#/app/config/config';
import {
  APIConnectionError,
  APIContextOverflowError,
  APIEmptyResponseError,
  APIProviderOverloadedError,
  APIRequestTooLargeError,
  APIStatusError,
  APITimeoutError,
  isContextOverflowStatusError,
  isImageFormatError,
  isRecoverableRequestStructureError,
  isRetryableGenerateError,
} from '#/app/llmProtocol/errors';
import { type Message } from '#/app/llmProtocol/message';
import { type ThinkingEffort } from '#/app/llmProtocol/thinkingEffort';
import { type Tool } from '#/app/llmProtocol/tool';
import { emptyUsage, inputTotal, type TokenUsage } from '#/app/llmProtocol/usage';
import { ILogService, type LogContext } from '#/_base/log/log';
import type { Model, LLMEvent as ModelRequestEvent } from '#/app/model/modelInstance';
import type { KimiModelOverrides } from '#/app/model/modelOverrides';
import { MODELS_SECTION, type ModelsSection } from '#/app/model/model';
import { applyCompletionBudget, resolveCompletionBudget } from '#/app/model/completionBudget';
import type { Protocol } from '#/app/protocol/protocol';
import type { ApiErrorEvent } from '#/app/telemetry/events';
import { ITelemetryService } from '#/app/telemetry/telemetry';
import { IAgentWireService } from '#/wire/tokens';
import type { PayloadOf } from '#/wire/types';
import type { IWireService } from '#/wire/wireService';
import { THINKING_SECTION, type ThinkingConfig } from '#/agent/profile/configSection';
import { resolveThinkingKeep } from '#/agent/profile/thinking';

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
  LlmRequestTraceModel,
  llmRequest,
  llmToolsSnapshot,
  type LlmRequestToolSchema,
} from './llmRequestOps';
import { isAbortError } from '#/_base/utils/abort';
import { unwrapErrorCause } from '#/errors';
import { retryErrorFields } from '#/_base/utils/retry';

const EMPTY_TOOL_PARAMETERS: Record<string, unknown> = {
  type: 'object',
  properties: {},
};

const noopOnPart: LLMRequestPartHandler = () => {};

interface ResolvedLLMRequest {
  readonly model: Model;
  readonly modelAlias: string;
  readonly thinkingEffort: ThinkingEffort;
  readonly systemPrompt: string;
  readonly tools: readonly Tool[];
  readonly messages: Message[];
  readonly source: LLMRequestSource | undefined;
  readonly logFields: LLMRequestLogFields;
}

type RequestProjection = 'normal' | 'strict' | 'media-degraded' | 'media-stripped';

interface LLMRequestLogInput {
  readonly protocol: Protocol;
  readonly modelName: string;
  readonly modelAlias?: string;
  readonly thinkingEffort?: ThinkingEffort | null;
  readonly maxTokens?: number;
  readonly systemPrompt: string;
  readonly tools: readonly Tool[];
  readonly messages: readonly Message[];
  readonly fields?: LLMRequestLogFields;
}

interface TurnRequestConfig {
  readonly resolved: ProfileModelContext;
  readonly model: Model;
  readonly systemPrompt: string;
}

export class AgentLLMRequesterService implements IAgentLLMRequesterService {
  declare readonly _serviceBrand: undefined;

  private lastConfigLogSignature: string | undefined;
  private readonly turnConfigs = new Map<number, TurnRequestConfig>();
  private readonly mediaDegradedTurns = new Set<number>();
  private readonly mediaStrippedTurns = new Set<number>();

  constructor(
    @IAgentContextMemoryService private readonly context: IAgentContextMemoryService,
    @IAgentContextProjectorService private readonly projector: IAgentContextProjectorService,
    @IAgentContextSizeService private readonly contextSize: IAgentContextSizeService,
    @IAgentToolRegistryService private readonly tools: IAgentToolRegistryService,
    @IAgentToolSelectService private readonly toolSelect: IAgentToolSelectService,
    @IAgentProfileService private readonly profile: IAgentProfileService,
    @IAgentUsageService private readonly usage: IAgentUsageService,
    @IConfigService private readonly config: IConfigService,
    @ILogService private readonly log: ILogService,
    @ITelemetryService private readonly telemetry: ITelemetryService,
    @IAgentWireService private readonly wire: IWireService,
    @IFaultInjectionService private readonly faultInjection: IFaultInjectionService,
  ) {}

  async request(
    overrides: LLMRequestOverrides = {},
    onPart: LLMRequestPartHandler = noopOnPart,
    signal?: AbortSignal,
  ): Promise<LLMRequestFinish> {
    signal?.throwIfAborted();
    const startedAt = Date.now();
    try {
      return await this.runRequest(this.resolveRequest(overrides), onPart, signal);
    } catch (error) {
      this.logRequestFailure(error, overrides, signal);
      this.trackApiError(error, startedAt, signal);
      throw error;
    }
  }

  private logRequestFailure(
    error: unknown,
    overrides: LLMRequestOverrides,
    signal: AbortSignal | undefined,
  ): void {
    if (isAbortError(error) || signal?.aborted === true) return;
    const payload: LogContext = {
      ...logFieldsForSource(overrides.source),
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
    const modelAlias = this.profile.data().modelAlias;
    const model = this.tryGetProvider();
    const properties: ApiErrorEvent = {
      error_type: apiErrorType(error),
      model: model?.id ?? modelAlias ?? 'unknown',
      alias: modelAlias,
      provider_type: model?.protocol,
      protocol: model?.protocol,
      retryable: isRetryableGenerateError(error),
      duration_ms: Math.max(0, Date.now() - startedAt),
    };
    const statusCode = apiStatusCode(error);
    if (statusCode !== undefined) properties['status_code'] = statusCode;
    const currentTurn = this.usage.status().currentTurn;
    if (currentTurn !== undefined) properties['input_tokens'] = inputTotal(currentTurn);
    this.telemetry.track2('api_error', properties);
  }

  private tryGetProvider(): Model | undefined {
    try {
      return this.profile.getProvider();
    } catch {
      return undefined;
    }
  }

  private async runRequest(
    request: ResolvedLLMRequest,
    onPart: LLMRequestPartHandler,
    signal: AbortSignal | undefined,
  ): Promise<LLMRequestFinish> {
    const requestInput = (projection: RequestProjection) => {
      const shaped = this.toolSelect.shapeHistory(request.messages);
      return {
        systemPrompt: request.systemPrompt,
        tools: request.tools,
        messages:
          projection === 'strict'
            ? this.projector.projectStrict(shaped)
            : projection === 'media-degraded'
              ? this.projector.projectMediaDegraded(shaped)
              : projection === 'media-stripped'
                ? this.projector.projectMediaStripped(shaped)
                : this.projector.project(shaped),
      };
    };

    const run = async (projection: RequestProjection): Promise<LLMRequestFinish> => {
      const input = requestInput(projection);
      const fields =
        projection === 'normal'
          ? request.logFields
          : { ...request.logFields, projection };
      const logInput: LLMRequestLogInput = {
        protocol: request.model.protocol,
        modelName: request.model.name,
        modelAlias: request.modelAlias,
        thinkingEffort: request.thinkingEffort,
        maxTokens: request.model.maxCompletionTokens,
        systemPrompt: input.systemPrompt,
        tools: input.tools,
        messages: input.messages,
        fields,
      };
      this.logRequest(logInput);
      this.recordRequest(logInput);

      const fault = this.faultInjection.take();
      if (fault !== undefined) {
        throw faultToError(fault);
      }

      let message: Message | undefined;
      let usage = emptyUsage();
      let timing: LLMStreamTiming | undefined;
      let finish: Extract<ModelRequestEvent, { type: 'finish' }> | undefined;

      for await (const event of request.model.request(input, signal)) {
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

      this.usage.record(request.modelAlias, usage, request.source);
      this.contextSize.measured(request.messages, [message], usage);
      this.logResponse(request.logFields, usage, timing);

      return {
        message,
        usage,
        model: request.modelAlias,
        providerFinishReason: finish.providerFinishReason,
        rawFinishReason: finish.rawFinishReason,
        providerMessageId: finish.id,
        timing,
      };
    };

    const initialProjection: RequestProjection = this.isRecoveryTurn(
      this.mediaStrippedTurns,
      request.source,
    )
      ? 'media-stripped'
      : this.isRecoveryTurn(this.mediaDegradedTurns, request.source)
        ? 'media-degraded'
        : 'normal';
    try {
      return await run(initialProjection);
    } catch (error) {
      if (signal?.aborted === true) throw error;
      const raw = unwrapErrorCause(error);
      if (initialProjection === 'normal' && raw instanceof APIRequestTooLargeError) {
        signal?.throwIfAborted();
        this.log.warn('provider rejected request as too large; resending with degraded media', {
          model: request.model.name,
          ...request.logFields,
        });
        this.markRecoveryTurn(this.mediaDegradedTurns, request.source);
        return run('media-degraded');
      }
      if (initialProjection !== 'media-stripped' && isImageFormatError(raw)) {
        signal?.throwIfAborted();
        this.log.warn(
          'provider rejected an image in the request; resending with all media stripped',
          {
            model: request.model.name,
            ...request.logFields,
          },
        );
        this.markRecoveryTurn(this.mediaStrippedTurns, request.source);
        return run('media-stripped');
      }
      if (initialProjection === 'normal' && isRecoverableRequestStructureError(raw)) {
        signal?.throwIfAborted();
        this.log.warn('provider rejected request structure; resending with strict projection', {
          model: request.model.name,
          ...request.logFields,
        });
        return run('strict');
      }
      throw error;
    }
  }

  private isRecoveryTurn(set: ReadonlySet<number>, source: LLMRequestSource | undefined): boolean {
    if (source?.type !== 'turn') return false;
    return set.has(source.turnId);
  }

  private markRecoveryTurn(set: Set<number>, source: LLMRequestSource | undefined): void {
    if (source?.type !== 'turn') return;
    for (const id of set) {
      if (id < source.turnId) set.delete(id);
    }
    set.add(source.turnId);
  }

  private resolveRequest(overrides: LLMRequestOverrides): ResolvedLLMRequest {
    const turnConfig = this.resolveTurnConfig(overrides.source);
    const resolved = turnConfig?.resolved ?? this.profile.resolveModelContext();
    const model = applyCompletionBudget({
      model: turnConfig?.model ?? this.profile.getProvider(),
      budget: resolveCompletionBudget({
        maxOutputSize: overrides.maxOutputSize ?? resolved.maxOutputSize,
        reservedContextSize: resolved.reservedContextSize,
        maxCompletionTokensCap:
          this.config.get<KimiModelOverrides>('modelOverrides')?.maxCompletionTokens,
      }),
      capability: resolved.modelCapabilities,
      usedContextTokens:
        overrides.messages === undefined
          ? this.contextSize.get().measured
          : undefined,
    });

    const messages = overrides.messages ?? this.context.get();
    return {
      model,
      modelAlias: resolved.modelAlias,
      thinkingEffort: resolved.thinkingLevel,
      systemPrompt: overrides.systemPrompt ?? turnConfig?.systemPrompt ?? this.profile.getSystemPrompt(),
      tools: [...(overrides.tools ?? this.defaultTools())],
      messages: [...messages],
      source: overrides.source,
      logFields: logFieldsForSource(overrides.source),
    };
  }

  private resolveTurnConfig(source: LLMRequestSource | undefined): TurnRequestConfig | undefined {
    if (source?.type !== 'turn') return undefined;
    const turnId = source.turnId;
    for (const id of this.turnConfigs.keys()) {
      if (id < turnId) this.turnConfigs.delete(id);
    }
    let snapshot = this.turnConfigs.get(turnId);
    if (snapshot === undefined) {
      snapshot = {
        resolved: this.profile.resolveModelContext(),
        model: this.profile.getProvider(),
        systemPrompt: this.profile.getSystemPrompt(),
      };
      this.turnConfigs.set(turnId, snapshot);
    }
    return snapshot;
  }

  private logRequest(input: LLMRequestLogInput): void {
    const logFields: LLMRequestLogFields = input.fields ?? {};
    const wireTools = providerVisibleTools(input.tools);
    const config = {
      provider: input.protocol,
      model: input.modelName,
      modelAlias: input.modelAlias,
      thinkingEffort: input.thinkingEffort ?? undefined,
      systemPromptChars: input.systemPrompt.length,
      toolCount: wireTools.length,
    };
    const signature = JSON.stringify({
      ...config,
      systemPromptHash: fingerprint(input.systemPrompt),
      toolsHash: fingerprint(JSON.stringify(toolSignature(wireTools))),
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

  private recordRequest(input: LLMRequestLogInput): void {
    const fields = input.fields ?? {};
    const wireTools = providerVisibleTools(input.tools);
    const tools = toolSignature(wireTools);
    const toolsHash = fingerprint(JSON.stringify(tools));
    if (!this.wire.getModel(LlmRequestTraceModel).seenToolsHashes.includes(toolsHash)) {
      this.wire.dispatch(llmToolsSnapshot({ hash: toolsHash, tools }));
    }

    const systemPromptHash = fingerprint(input.systemPrompt);
    const overrides = this.config.get<KimiModelOverrides>('modelOverrides');
    const thinkingConfig = this.config.get<ThinkingConfig>(THINKING_SECTION);
    const models = this.config.get<ModelsSection>(MODELS_SECTION);
    const modelConfig =
      input.modelAlias === undefined ? undefined : models?.[input.modelAlias];
    const payload: PayloadOf<typeof llmRequest> = {
      kind: requestKindForRecord(fields),
      provider: input.protocol,
      model: input.modelName,
      modelAlias: input.modelAlias,
      thinkingEffort: input.thinkingEffort ?? undefined,
      thinkingKeep: input.protocol === 'kimi'
        ? resolveThinkingKeep(
            overrides?.thinkingKeep,
            thinkingConfig?.keep,
            input.thinkingEffort ?? 'off',
          )
        : undefined,
      temperature: input.protocol === 'kimi' ? overrides?.temperature : undefined,
      topP: input.protocol === 'kimi' ? overrides?.topP : undefined,
      maxTokens: input.maxTokens,
      betaApi: modelConfig?.betaApi,
      toolSelect: this.toolSelect.enabled(),
      systemPromptHash,
      systemPrompt:
        input.systemPrompt === this.profile.data().systemPrompt
          ? undefined
          : input.systemPrompt,
      toolsHash,
      messageCount: input.messages.length,
      turnStep: stringField(fields, 'turnStep'),
      attempt: stringField(fields, 'attempt'),
      projection: projectionField(fields),
      droppedCount: numberField(fields, 'droppedCount'),
    };
    this.wire.dispatch(llmRequest(payload));
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
    return this.toolSelect
      .shapeTools(this.tools.list())
      .map((tool) => ({
        name: tool.name,
        description: tool.description,
        parameters: tool.parameters ?? EMPTY_TOOL_PARAMETERS,
        deferred: tool.deferred,
      }));
  }
}

function logFieldsForSource(source: LLMRequestSource | undefined): LLMRequestLogFields {
  switch (source?.type) {
    case 'turn':
      return {
        ...source.logFields,
        ...(source.step === undefined
          ? {}
          : { turnStep: `${String(source.turnId)}.${String(source.step)}` }),
      };
    case 'operation':
      return {
        ...source.logFields,
        ...(source.requestKind === undefined ? {} : { requestKind: source.requestKind }),
      };
    default:
      return {};
  }
}

function providerVisibleTools(tools: readonly Tool[]): readonly Tool[] {
  if (!tools.some((tool) => tool.deferred === true)) return tools;
  return tools.filter((tool) => tool.deferred !== true);
}

function toolSignature(tools: readonly Tool[]): readonly LlmRequestToolSchema[] {
  return tools.map(({ name, description, parameters }) => ({ name, description, parameters }));
}

function requestKindForRecord(fields: LLMRequestLogFields): PayloadOf<typeof llmRequest>['kind'] {
  if (fields['kind'] === 'compaction') return 'compaction';
  if (fields['requestKind'] === 'full_compaction') return 'compaction';
  return 'loop';
}

function stringField(fields: LLMRequestLogFields, key: string): string | undefined {
  const value = fields[key];
  return typeof value === 'string' ? value : undefined;
}

function numberField(fields: LLMRequestLogFields, key: string): number | undefined {
  const value = fields[key];
  return typeof value === 'number' ? value : undefined;
}

function projectionField(
  fields: LLMRequestLogFields,
): 'strict' | 'media-degraded' | 'media-stripped' | undefined {
  const value = fields['projection'];
  return value === 'strict' || value === 'media-degraded' || value === 'media-stripped'
    ? value
    : undefined;
}

function faultToError(kind: FaultKind): Error {
  return kind === 'request-too-large'
    ? new APIRequestTooLargeError(413, 'Request Entity Too Large (fault injection)')
    : new APIStatusError(400, 'unsupported image format: image/avif (fault injection)');
}

function fingerprint(content: string): string {
  return createHash('sha256').update(content).digest('hex');
}

function apiErrorType(error: unknown): string {
  const raw = unwrapErrorCause(error);
  if (raw instanceof APIContextOverflowError) return 'context_overflow';
  if (raw instanceof APIProviderOverloadedError) return 'overloaded';
  if (raw instanceof APIStatusError) {
    if (isContextOverflowStatusError(raw.statusCode, raw.message)) return 'context_overflow';
    if (raw.statusCode === 429) return 'rate_limit';
    if (raw.statusCode === 529) return 'overloaded';
    if (raw.statusCode === 401 || raw.statusCode === 403) return 'auth';
    if (raw.statusCode >= 500) return '5xx_server';
    if (raw.statusCode >= 400) return '4xx_client';
  }
  if (raw instanceof APIConnectionError) return 'network';
  if (raw instanceof APITimeoutError) return 'timeout';
  if (raw instanceof APIEmptyResponseError) return 'empty_response';
  return 'other';
}

function apiStatusCode(error: unknown): number | undefined {
  const raw = unwrapErrorCause(error);
  if (raw instanceof APIStatusError) return raw.statusCode;
  if (typeof raw === 'object' && raw !== null) {
    const statusCode = (raw as Record<string, unknown>)['statusCode'];
    if (typeof statusCode === 'number') return statusCode;
    const status = (raw as Record<string, unknown>)['status'];
    if (typeof status === 'number') return status;
  }
  if (typeof error === 'object' && error !== null) {
    const details = (error as Record<string, unknown>)['details'];
    if (typeof details === 'object' && details !== null) {
      const statusCode = (details as Record<string, unknown>)['statusCode'];
      if (typeof statusCode === 'number') return statusCode;
    }
  }
  return undefined;
}

registerScopedService(
  LifecycleScope.Agent,
  IAgentLLMRequesterService,
  AgentLLMRequesterService,
  InstantiationType.Delayed,
  'llmRequester',
);

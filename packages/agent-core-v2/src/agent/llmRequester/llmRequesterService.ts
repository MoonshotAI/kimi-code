/**
 * `llmRequester` domain (L3) — `IAgentLLMRequesterService` implementation.
 *
 * Assembles per-turn `ModelRequestInput` from `profile` (system prompt),
 * `contextMemory` + `contextProjector` (history), `toolRegistry` (tools), and
 * `toolSelect` (progressive-disclosure shaping of the tool and history views),
 * folds the completion-token budget into the profile's dialect-free intent
 * params, then drives a bounded request chain through the `ModelRequester`
 * resolved from `IModelCatalog`: one primary `requester.request(input, signal,
 * params)` attempt plus projection rebuilds for request structure or media
 * compatibility; general retry policy remains in the loop's `stepRetry`
 * plugin. When a model is configured, `prepareTurnConfig` snapshots the
 * model, effective thinking effort, and system prompt at the turn boundary
 * so loop telemetry and every request in that turn share one configuration.
 * Forwards streamed `part` events to the caller's `onPart`
 * handler, records `usage` through `IAgentUsageService`, resolves to an
 * `AgentLLMRequestFinish` on the `finish` event, logs the request lifecycle
 * (config deduplicated by content, request/response/failure lines, plus
 * per-request fields) through `log`, publishes advisory model-capability
 * warnings through `eventBus`, records durable request-trace Ops
 * through `wire`, reports each request's `x-trace-id` to its caller, and
 * reports provider failures through `telemetry`. Bound at Agent scope.
 */

import { createHash } from 'node:crypto';
import { InstantiationType } from '#/_base/di/extensions';
import { LifecycleScope, registerScopedService } from '#/_base/di/scope';
import { IAgentContextMemoryService } from '#/agent/contextMemory/contextMemory';
import {
  IAgentContextProjectorService,
  type MediaStripSnapshot,
} from '#/agent/contextProjector/contextProjector';
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
import { IEventBus } from '#/app/event/eventBus';
import {
  APIRequestTooLargeError,
  APIStatusError,
  classifyApiError,
  isImageFormatError,
  isRecoverableRequestStructureError,
  isRetryableGenerateError,
} from '#/kosong/contract/errors';
import { type Message } from '#/kosong/contract/message';
import { type ThinkingEffort } from '#/kosong/contract/provider';
import { type Tool } from '#/kosong/contract/tool';
import { emptyUsage, inputTotal, type TokenUsage } from '#/kosong/contract/usage';
import { ILogService, type LogContext } from '#/_base/log/log';
import { IModelCatalog, type Model } from '#/kosong/model/catalog';
import {
  effectiveMaxCompletionTokens,
  type ModelRequestEvent,
  type ModelRequestParams,
  type ModelRequester,
  type ModelRequestTiming,
} from '#/kosong/model/modelRequester';
import type { ModelOverrides } from '#/kosong/model/model.types';
import { MODELS_SECTION, type ModelsSection } from '#/kosong/model/model';
import { completionBudgetParams, resolveCompletionBudget } from '#/kosong/model/completionBudget';
import { resolveThinkingKeep, THINKING_SECTION, type ThinkingConfig } from '#/kosong/model/thinking';
import type { Protocol } from '#/kosong/protocol/protocol';
import type { ApiErrorEvent } from '#/app/telemetry/events';
import { ITelemetryService } from '#/app/telemetry/telemetry';
import { IWireService } from '#/wire/wire';
import type { PayloadOf } from '#/wire/types';

import {
  IAgentLLMRequesterService,
  type AgentLLMRequestFinish,
  type AgentLLMRequestLogFields,
  type AgentLLMRequestOverrides,
  type AgentLLMRequestPartHandler,
  type AgentLLMRequestSource,
  type AgentLLMRequestTask,
  type PreparedTurnRequestConfig,
} from './llmRequester';
import type { LLMRequestTrace } from '#/kosong/contract/requestTrace';
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

const noopOnPart: AgentLLMRequestPartHandler = () => {};

interface ResolvedLLMRequest {
  readonly requester: ModelRequester;
  readonly model: Model;
  readonly params: ModelRequestParams;
  readonly modelAlias: string;
  readonly thinkingEffort: ThinkingEffort;
  readonly systemPrompt: string;
  readonly tools: readonly Tool[];
  readonly messages: Message[];
  readonly source: AgentLLMRequestSource | undefined;
  readonly logFields: AgentLLMRequestLogFields;
}

type RequestProjection = 'normal' | 'strict' | 'media-degraded' | 'media-stripped';

interface LLMRequestLogInput {
  readonly protocol: Protocol;
  readonly providerType?: string;
  readonly modelName: string;
  readonly modelAlias?: string;
  readonly thinkingEffort?: ThinkingEffort | null;
  readonly maxTokens?: number;
  readonly systemPrompt: string;
  readonly tools: readonly Tool[];
  readonly messages: readonly Message[];
  readonly fields?: AgentLLMRequestLogFields;
}

interface TurnRequestConfig {
  readonly resolved: ProfileModelContext;
  readonly params: ModelRequestParams;
  readonly systemPrompt: string;
}

export class AgentLLMRequesterService implements IAgentLLMRequesterService {
  declare readonly _serviceBrand: undefined;

  private lastConfigLogSignature: string | undefined;
  private readonly turnConfigs = new Map<number, TurnRequestConfig>();
  private readonly mediaDegradedTurns = new Set<number>();
  private readonly mediaStrippedTurns = new Map<number, MediaStripSnapshot>();
  private readonly emittedThinkingEffortWarnings = new Set<string>();

  constructor(
    @IAgentContextMemoryService private readonly context: IAgentContextMemoryService,
    @IAgentContextProjectorService private readonly projector: IAgentContextProjectorService,
    @IAgentContextSizeService private readonly contextSize: IAgentContextSizeService,
    @IAgentToolRegistryService private readonly tools: IAgentToolRegistryService,
    @IAgentToolSelectService private readonly toolSelect: IAgentToolSelectService,
    @IAgentProfileService private readonly profile: IAgentProfileService,
    @IAgentUsageService private readonly usage: IAgentUsageService,
    @IConfigService private readonly config: IConfigService,
    @IModelCatalog private readonly modelCatalog: IModelCatalog,
    @ILogService private readonly log: ILogService,
    @ITelemetryService private readonly telemetry: ITelemetryService,
    @IWireService private readonly wire: IWireService,
    @IFaultInjectionService private readonly faultInjection: IFaultInjectionService,
    @IEventBus private readonly eventBus: IEventBus,
  ) {}

  prepareTurnConfig(turnId: number): PreparedTurnRequestConfig | undefined {
    if (!this.profile.hasProvider()) return undefined;
    const config = this.getOrCreateTurnConfig(turnId);
    return { thinkingEffort: config.resolved.thinkingLevel };
  }

  async request(
    overrides: AgentLLMRequestOverrides = {},
    onPart: AgentLLMRequestPartHandler = noopOnPart,
    signal?: AbortSignal,
  ): Promise<AgentLLMRequestFinish> {
    return this.start(overrides, onPart, signal).result;
  }

  start(
    overrides: AgentLLMRequestOverrides = {},
    onPart: AgentLLMRequestPartHandler = noopOnPart,
    signal?: AbortSignal,
  ): AgentLLMRequestTask {
    const trace = new MutableLLMRequestTrace();
    return {
      trace,
      result: this.requestWithTrace(trace, overrides, onPart, signal),
    };
  }

  private async requestWithTrace(
    trace: MutableLLMRequestTrace,
    overrides: AgentLLMRequestOverrides,
    onPart: AgentLLMRequestPartHandler,
    signal: AbortSignal | undefined,
  ): Promise<AgentLLMRequestFinish> {
    signal?.throwIfAborted();
    const startedAt = Date.now();
    trace.set(undefined);
    try {
      return await this.runRequest(
        this.resolveRequest(overrides),
        onPart,
        signal,
        (traceId) => {
          trace.set(traceId);
        },
      );
    } catch (error) {
      this.logRequestFailure(error, overrides, signal);
      trace.set(this.trackApiError(error, startedAt, signal, overrides.source, trace.traceId));
      throw error;
    }
  }

  private logRequestFailure(
    error: unknown,
    overrides: AgentLLMRequestOverrides,
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
    source?: AgentLLMRequestSource,
    requestTraceId?: string,
  ): string | undefined {
    if (isAbortError(error) || signal?.aborted === true) return requestTraceId;
    const modelAlias = this.profile.data().modelAlias;
    const model = this.tryGetModel();
    const traceId = requestTraceId ?? apiTraceId(error);
    const classification = classifyApiError(unwrapErrorCause(error));
    const properties: ApiErrorEvent = {
      error_type: classification.kind,
      model: model?.id ?? modelAlias ?? 'unknown',
      alias: modelAlias,
      provider_type: model?.providerType ?? model?.protocol,
      protocol: model?.protocol,
      retryable: isRetryableGenerateError(error),
      duration_ms: Math.max(0, Date.now() - startedAt),
      trace_id: traceId,
    };
    if (source?.type === 'turn') {
      properties['turn_id'] = source.turnId;
      if (source.step !== undefined) properties['step_no'] = source.step;
    }
    const statusCode = apiStatusCode(error);
    if (statusCode !== undefined) properties['status_code'] = statusCode;
    const currentTurn = this.usage.status().currentTurn;
    if (currentTurn !== undefined) properties['input_tokens'] = inputTotal(currentTurn);
    this.telemetry.track2('api_error', properties);
    return traceId;
  }

  private tryGetModel(): Model | undefined {
    const modelAlias = this.profile.data().modelAlias;
    if (modelAlias === undefined) return undefined;
    try {
      return this.modelCatalog.get(modelAlias);
    } catch {
      return undefined;
    }
  }

  private async runRequest(
    request: ResolvedLLMRequest,
    onPart: AgentLLMRequestPartHandler,
    signal: AbortSignal | undefined,
    onRequestTrace: (traceId: string | undefined) => void,
  ): Promise<AgentLLMRequestFinish> {
    const shaped = this.toolSelect.shapeHistory(request.messages);
    let mediaStripSnapshot = this.mediaStripSnapshotForTurn(request.source);
    const requestInput = (projection: RequestProjection) => {
      return {
        systemPrompt: request.systemPrompt,
        tools: request.tools,
        messages:
          projection === 'strict'
            ? this.projector.projectStrict(shaped)
            : projection === 'media-degraded'
              ? this.projector.projectMediaDegraded(shaped)
              : projection === 'media-stripped'
                ? this.projector.projectMediaStripped(
                    shaped,
                    (mediaStripSnapshot ??=
                      this.projector.captureMediaStripSnapshot(shaped)),
                  )
                : this.projector.project(shaped),
      };
    };

    const run = async (projection: RequestProjection): Promise<AgentLLMRequestFinish> => {
      onRequestTrace(undefined);
      const input = requestInput(projection);
      const fields =
        projection === 'normal'
          ? request.logFields
          : { ...request.logFields, projection };
      this.warnAboutAnthropicThinkingEffort(request);
      const logInput: LLMRequestLogInput = {
        protocol: request.model.protocol,
        providerType: request.model.providerType,
        modelName: request.model.name,
        modelAlias: request.modelAlias,
        thinkingEffort: request.thinkingEffort,
        maxTokens: effectiveMaxCompletionTokens(request.params),
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
      let timing: ModelRequestTiming | undefined;
      let finish: Extract<ModelRequestEvent, { type: 'finish' }> | undefined;

      const setTraceId = (traceId: string | null | undefined): void => {
        const normalized = traceId ?? undefined;
        onRequestTrace(normalized);
      };

      for await (const event of request.requester.request(input, signal, {
        ...request.params,
        onTraceId: setTraceId,
      })) {
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
            setTraceId(event.traceId);
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
        traceId: finish.traceId,
      };
    };

    const initialProjection: RequestProjection = mediaStripSnapshot !== undefined
      ? 'media-stripped'
      : this.isRecoveryTurn(this.mediaDegradedTurns, request.source)
        ? 'media-degraded'
        : 'normal';
    let projection: RequestProjection = initialProjection;
    for (;;) {
      try {
        return await run(projection);
      } catch (error) {
        if (signal?.aborted === true) throw error;
        const raw = unwrapErrorCause(error);
        if (
          raw instanceof APIRequestTooLargeError &&
          (projection === 'normal' || projection === 'media-degraded')
        ) {
          signal?.throwIfAborted();
          if (projection === 'normal') {
            this.log.warn(
              'provider rejected request as too large; resending with degraded media',
              {
                model: request.model.name,
                ...request.logFields,
              },
            );
            this.markRecoveryTurn(this.mediaDegradedTurns, request.source);
            projection = 'media-degraded';
          } else {
            this.log.warn(
              'provider rejected degraded-media request as too large; resending with rejected media stripped',
              {
                model: request.model.name,
                ...request.logFields,
              },
            );
            mediaStripSnapshot = this.projector.captureMediaStripSnapshot(shaped);
            this.markMediaStrippedRecoveryTurn(mediaStripSnapshot, request.source);
            projection = 'media-stripped';
          }
          continue;
        }
        if (projection !== 'media-stripped' && isImageFormatError(raw)) {
          signal?.throwIfAborted();
          this.log.warn(
            'provider rejected an image in the request; resending with rejected media stripped',
            {
              model: request.model.name,
              ...request.logFields,
            },
          );
          mediaStripSnapshot = this.projector.captureMediaStripSnapshot(shaped);
          this.markMediaStrippedRecoveryTurn(mediaStripSnapshot, request.source);
          projection = 'media-stripped';
          continue;
        }
        if (projection === 'normal' && isRecoverableRequestStructureError(raw)) {
          signal?.throwIfAborted();
          this.log.warn('provider rejected request structure; resending with strict projection', {
            model: request.model.name,
            ...request.logFields,
          });
          projection = 'strict';
          continue;
        }
        throw error;
      }
    }
  }

  private warnAboutAnthropicThinkingEffort(request: ResolvedLLMRequest): void {
    if (request.model.protocol !== 'anthropic') return;
    const effort = request.thinkingEffort;
    if (effort === 'on') return;

    let code: string;
    let message: string;
    let knownEfforts: string | undefined;
    if (effort === 'off') {
      if (!request.model.alwaysThinking) return;
      code = 'anthropic-thinking-cannot-disable';
      message = `Model "${request.model.name}" declares always-on thinking. The configured effort "off" will be sent unchanged to the Anthropic-compatible backend.`;
    } else {
      const supportEfforts = request.model.supportEfforts?.filter((value) => value.length > 0);
      if (supportEfforts === undefined || supportEfforts.length === 0) return;
      if (supportEfforts.includes(effort)) return;
      code = 'anthropic-thinking-effort-not-listed';
      knownEfforts = supportEfforts.join(',');
      message = `Thinking effort "${effort}" is not listed for model "${request.model.name}" (known: ${supportEfforts.join(', ')}). The configured value will be sent unchanged to the Anthropic-compatible backend.`;
    }

    const key = [code, request.modelAlias, request.model.name, effort, knownEfforts].join('\u0000');
    if (this.emittedThinkingEffortWarnings.has(key)) return;
    this.emittedThinkingEffortWarnings.add(key);
    try {
      this.log.warn(message, {
        modelAlias: request.modelAlias,
        model: request.model.name,
        effort,
        knownEfforts,
      });
    } catch {
    }
    try {
      this.eventBus.publish({ type: 'warning', code, message });
    } catch {
    }
  }

  private isRecoveryTurn(set: ReadonlySet<number>, source: AgentLLMRequestSource | undefined): boolean {
    if (source?.type !== 'turn') return false;
    return set.has(source.turnId);
  }

  private mediaStripSnapshotForTurn(
    source: AgentLLMRequestSource | undefined,
  ): MediaStripSnapshot | undefined {
    if (source?.type !== 'turn') return undefined;
    return this.mediaStrippedTurns.get(source.turnId);
  }

  private markMediaStrippedRecoveryTurn(
    snapshot: MediaStripSnapshot,
    source: AgentLLMRequestSource | undefined,
  ): void {
    if (source?.type !== 'turn') return;
    for (const id of this.mediaStrippedTurns.keys()) {
      if (id < source.turnId) this.mediaStrippedTurns.delete(id);
    }
    this.mediaStrippedTurns.set(source.turnId, snapshot);
  }

  private markRecoveryTurn(set: Set<number>, source: AgentLLMRequestSource | undefined): void {
    if (source?.type !== 'turn') return;
    for (const id of set) {
      if (id < source.turnId) set.delete(id);
    }
    set.add(source.turnId);
  }

  private resolveRequest(overrides: AgentLLMRequestOverrides): ResolvedLLMRequest {
    const turnConfig = this.resolveTurnConfig(overrides.source);
    const resolved = turnConfig?.resolved ?? this.profile.resolveModelContext();
    const baseParams = turnConfig?.params ?? this.profile.resolveRequestParams();
    const budgetParams = completionBudgetParams({
      budget: resolveCompletionBudget({
        maxOutputSize: overrides.maxOutputSize ?? resolved.maxOutputSize,
        reservedContextSize: resolved.reservedContextSize,
        maxCompletionTokensCap:
          this.config.get<ModelOverrides>('modelOverrides')?.maxCompletionTokens,
      }),
      capability: resolved.modelCapabilities,
      usedContextTokens:
        overrides.messages === undefined
          ? this.contextSize.get().measured
          : undefined,
    });
    const requester = this.modelCatalog.getRequester(resolved.modelAlias);

    const messages = overrides.messages ?? this.context.get();
    return {
      requester,
      model: requester.model,
      params: { ...baseParams, ...budgetParams },
      modelAlias: resolved.modelAlias,
      thinkingEffort: resolved.thinkingLevel,
      systemPrompt: overrides.systemPrompt ?? turnConfig?.systemPrompt ?? this.profile.getSystemPrompt(),
      tools: [...(overrides.tools ?? this.defaultTools())],
      messages: [...messages],
      source: overrides.source,
      logFields: logFieldsForSource(overrides.source),
    };
  }

  private resolveTurnConfig(source: AgentLLMRequestSource | undefined): TurnRequestConfig | undefined {
    if (source?.type !== 'turn') return undefined;
    return this.getOrCreateTurnConfig(source.turnId);
  }

  private getOrCreateTurnConfig(turnId: number): TurnRequestConfig {
    for (const id of this.turnConfigs.keys()) {
      if (id < turnId) this.turnConfigs.delete(id);
    }
    let snapshot = this.turnConfigs.get(turnId);
    if (snapshot === undefined) {
      snapshot = {
        resolved: this.profile.resolveModelContext(),
        params: this.profile.resolveRequestParams(),
        systemPrompt: this.profile.getSystemPrompt(),
      };
      this.turnConfigs.set(turnId, snapshot);
    }
    return snapshot;
  }

  private logRequest(input: LLMRequestLogInput): void {
    const logFields: AgentLLMRequestLogFields = input.fields ?? {};
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
    const overrides = this.config.get<ModelOverrides>('modelOverrides');
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
      thinkingKeep: resolveThinkingKeep(
        overrides?.thinkingKeep,
        thinkingConfig?.keep,
        input.thinkingEffort ?? 'off',
      ),
      temperature: overrides?.temperature,
      topP: overrides?.topP,
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
    fields: AgentLLMRequestLogFields | undefined,
    usage: TokenUsage,
    timing: ModelRequestTiming | undefined,
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

class MutableLLMRequestTrace implements LLMRequestTrace {
  traceId: string | undefined;

  set(traceId: string | undefined): void {
    this.traceId = traceId;
  }
}

function logFieldsForSource(source: AgentLLMRequestSource | undefined): AgentLLMRequestLogFields {
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

function requestKindForRecord(fields: AgentLLMRequestLogFields): PayloadOf<typeof llmRequest>['kind'] {
  if (fields['kind'] === 'compaction') return 'compaction';
  if (fields['requestKind'] === 'full_compaction') return 'compaction';
  return 'loop';
}

function stringField(fields: AgentLLMRequestLogFields, key: string): string | undefined {
  const value = fields[key];
  return typeof value === 'string' ? value : undefined;
}

function numberField(fields: AgentLLMRequestLogFields, key: string): number | undefined {
  const value = fields[key];
  return typeof value === 'number' ? value : undefined;
}

function projectionField(
  fields: AgentLLMRequestLogFields,
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

function apiTraceId(error: unknown): string | undefined {
  const raw = unwrapErrorCause(error);
  if (raw instanceof APIStatusError && raw.traceId !== null) return raw.traceId;
  if (typeof error === 'object' && error !== null) {
    const details = (error as Record<string, unknown>)['details'];
    if (typeof details === 'object' && details !== null) {
      const traceId = (details as Record<string, unknown>)['traceId'];
      if (typeof traceId === 'string') return traceId;
    }
  }
  return undefined;
}

registerScopedService(
  LifecycleScope.Agent,
  IAgentLLMRequesterService,
  AgentLLMRequesterService,
  InstantiationType.Eager,
  'llmRequester',
);

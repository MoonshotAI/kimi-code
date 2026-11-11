import { createHash } from 'node:crypto';

import { ILogService, type LogContext } from '#/_base/log/log';
import { isAbortError } from '#/_base/utils/abort';
import { retryErrorFields } from '#/_base/utils/retry';
import { WarningIssued } from '#/agent/profile/profileOps';
import { IAgentScopeContext } from '#/agent/scopeContext/scopeContext';
import { IAgentStateService } from '#/agent/state/agentState';
import { cacheProbeUsage } from '#/agent/usage/cacheProbe';
import { ITelemetryService } from '#/app/telemetry/telemetry';
import type { ApiErrorEvent, CacheBreakDetectedEvent } from '#/app/telemetry/events';
import { unwrapErrorCause } from '#/errors';
import { countMediaParts } from '@moonshot-ai/core/llm/builtin/policy/media-degrade';
import type { Message, ToolDescription as Tool } from '@moonshot-ai/core/llm/message';
import { toRequestMessages } from '@moonshot-ai/core/llm/history';
import type { LlmProtocolRequest } from '@moonshot-ai/core/llm/request';
import type { LlmRecoveryRecord } from '@moonshot-ai/core/llm/policy/recovery';
import { llmErrorRequestId, type LlmOutcome, type LlmRunEvent, type LlmTiming } from '@moonshot-ai/core/llm/response';
import { emptyUsage, grandTotal, inputTotal, type TokenUsage } from '@moonshot-ai/core/llm/usage';
import type { ThinkingEffort } from '@moonshot-ai/core/llm/request';
import type { LLMRequestTrace } from '#/llm-adapter/contract/request-trace';
import {
  APIStatusError,
  classifyApiError,
  errorDiagnostics,
  isLlmErrorMessage,
  isRetryableGenerateError,
} from '#/llm-adapter/contract/errors';
import { IEventDispatcher } from '#/state/eventDispatcher';
import { ISessionTokenCountingService } from '#/session/tokenCounting/sessionTokenCounting';
import { ISessionUsageService } from '#/session/usage/sessionUsage';
import { ISessionRequestAttributionService } from '#/session/requestAttribution/requestAttribution';
import { defineState } from '#/state/state';
import { summarizeProjectionRepairs, type ProjectionAnomaly } from './projection';
import { hasStrictStructureRecovery } from './projectionPolicy';
import { llmRequestTraceKey, LlmToolsSnapshot, llmToolsSnapshotPayload } from './llmRequestOps';
import {
  agentLLMRequestLogFields,
  type AgentLLMRequestLogFields,
  type AgentLLMRequestSource,
  type RequestConfigSnapshot,
  type ResolvedRequestContext,
} from './requesterContract';

const CACHE_BREAK_MIN_DROP_TOKENS = 2000;
const CACHE_BREAK_DROP_RATIO = 0.95;

interface RecordedRequestSnapshot {
  readonly toolsHash: string;
  readonly systemPromptHash: string;
  readonly messageCount: number;
  readonly historyHash: string;
  readonly messages: readonly Message[];
}

interface MeasuredRequest extends Omit<RecordedRequestSnapshot, 'messages'> {
  readonly modelAlias: string;
  readonly contextRevision: number;
  readonly inputTokens: number;
  readonly startedAt: number;
  readonly finishedAt: number;
  readonly thinkingEffort: ThinkingEffort;
  readonly requestKind?: string;
  readonly turnId?: number;
  readonly step?: number;
  readonly traceId?: string;
  readonly usage: TokenUsage;
}

interface AttemptObservation {
  previousMediaCount?: number;
  previousMediaRecovery?: LlmRecoveryRecord;
}

interface RequestLogInput {
  readonly systemPrompt: string;
  readonly tools: readonly Tool[];
  readonly messages: readonly Message[];
  readonly fields?: AgentLLMRequestLogFields;
}

type RequestProjection = 'strict' | 'media-degraded' | 'media-stripped' | 'strict-media-degraded' | 'strict-media-stripped';

export const contextProjectorLastRepairSignatureKey = defineState<string | null>(
  'contextProjector.lastRepairSignature',
  () => null,
);
export const llmRequesterLastConfigLogSignatureKey = defineState<string | undefined>(
  'llmRequester.lastConfigLogSignature',
  () => undefined as string | undefined,
);
export const llmRequesterLastMeasuredRequestKey = defineState<MeasuredRequest | undefined>(
  'llmRequester.lastMeasuredRequest',
  () => undefined as MeasuredRequest | undefined,
);
export const llmRequesterEmittedThinkingEffortWarningsKey = defineState<Set<string>>(
  'llmRequester.emittedThinkingEffortWarnings',
  () => new Set(),
);

export class AgentLoopRequestObserver {
  constructor(
    @ILogService private readonly log: ILogService,
    @ITelemetryService private readonly telemetry: ITelemetryService,
    @IEventDispatcher private readonly dispatcher: IEventDispatcher,
    @ISessionUsageService private readonly usage: ISessionUsageService,
    @ISessionTokenCountingService private readonly tokenCounting: ISessionTokenCountingService,
    @IAgentScopeContext private readonly scopeContext: IAgentScopeContext,
    @IAgentStateService private readonly states: IAgentStateService,
    @ISessionRequestAttributionService private readonly attribution: ISessionRequestAttributionService,
  ) {
    if (!this.states.has(llmRequestTraceKey)) this.states.contributeState(llmRequestTraceKey);
    this.states.contributeState(contextProjectorLastRepairSignatureKey);
    this.states.contributeState(llmRequesterLastConfigLogSignatureKey);
    this.states.contributeState(llmRequesterLastMeasuredRequestKey);
    this.states.contributeState(llmRequesterEmittedThinkingEffortWarningsKey);
  }

  start(
    source: AgentLLMRequestSource,
    config: RequestConfigSnapshot,
    onTrace?: (trace: LLMRequestTrace) => void,
  ): AgentRequestObservation {
    return new AgentRequestObservation(this, source, config, onTrace);
  }

  setRequestId(source: AgentLLMRequestSource, requestId: string | undefined): void {
    if (source.type !== 'turn') return;
    this.telemetry.setContext({ request_id: requestId });
    this.attribution.noteActiveRequest(this.scopeContext.agentId, requestId);
  }

  recordAttempt(
    observation: AgentRequestObservation,
    attemptRequest: LlmProtocolRequest,
    appliedRecoveries: readonly LlmRecoveryRecord[],
  ): void {
    const request = observation.requireContext();
    observation.setRequestId(undefined);
    const attemptInput = {
      systemPrompt: attemptRequest.profile?.systemPrompt ?? request.systemPrompt,
      tools: attemptRequest.profile?.tools,
      messages: attemptRequest.content.messages,
    };
    const mediaRecovery = latestMediaRecovery(appliedRecoveries);
    const projection = projectionNameOf(appliedRecoveries, mediaRecovery);
    const fields = projection === undefined ? request.logFields : { ...request.logFields, projection };
    const media = observation.media;
    const currentMediaCount = countMediaParts(attemptInput.messages);
    const mediaPolicyChanged =
      media.previousMediaCount !== undefined && media.previousMediaRecovery !== mediaRecovery;
    const droppedMediaCount = media.previousMediaCount === undefined ? 0 : media.previousMediaCount - currentMediaCount;
    media.previousMediaCount = currentMediaCount;
    media.previousMediaRecovery = mediaRecovery;
    const mediaProjection =
      mediaRecovery === undefined
        ? undefined
        : mediaRecovery.action === 'degraded'
          ? 'media-degraded'
          : 'media-stripped';
    if (mediaPolicyChanged && droppedMediaCount > 0 && mediaProjection !== undefined) {
      try {
        void this.dispatcher.dispatch(
          new WarningIssued({
            agentId: this.scopeContext.agentId,
            code: mediaProjection,
            message:
              mediaProjection === 'media-degraded'
                ? 'Provider rejected the request as too large; older media were dropped and the request was retried.'
                : 'Provider rejected the media in the request; all media were omitted and the request was retried.',
          }),
        );
      } catch {
      }
    }
    this.warnAboutAnthropicThinkingEffort(request);
    const logInput: RequestLogInput = {
      systemPrompt: attemptInput.systemPrompt,
      tools: attemptInput.tools ?? [],
      messages: attemptInput.messages,
      fields,
    };
    const toolsSnapshot = llmToolsSnapshotPayload(logInput.tools);
    if (!this.states.get(llmRequestTraceKey).seenToolsHashes.includes(toolsSnapshot.hash)) {
      void this.dispatcher.dispatch(new LlmToolsSnapshot({
        agentId: this.scopeContext.agentId,
        hash: toolsSnapshot.hash,
        tools: toolsSnapshot.tools,
      }));
    }
    this.logRequest(request, logInput);
    observation.recorded = {
      toolsHash: toolsSnapshot.hash,
      systemPromptHash: fingerprint(logInput.systemPrompt),
      messageCount: logInput.messages.length,
      historyHash: fingerprint(JSON.stringify(logInput.messages)),
      messages: logInput.messages,
    };
  }

  reportEvent(
    observation: AgentRequestObservation,
    event: LlmRunEvent,
    infiniteRetry: boolean,
  ): void {
    const request = observation.requireContext();
    if (event.type === 'llm.streaming.request_id') {
      observation.setRequestId(event.requestId);
      return;
    }
    if (event.type === 'llm.streaming.headers') return;
    if (event.type !== 'llm.retrying') return;
    if (event.reason === 'backoff') {
      if (infiniteRetry) {
        this.log.warn('llm request failed; retrying indefinitely (KIMI_CODE_INFINITE_RETRY)', {
          model: request.model.spec.name,
          ...request.logFields,
          attempt: event.failedAttempt,
          delayMs: event.delayMs,
          ...retryErrorFields(event.error),
        });
      }
      return;
    }
    if (event.strategy === 'structure') {
      this.log.warn('provider rejected request structure; resending with strict projection', {
        model: request.model.spec.name,
        ...request.logFields,
      });
      this.telemetry.track2('llm_request_projection_fallback', {
        projection: 'strict',
        error_type: event.error.kind,
        model: request.model.id,
        turn_id: request.source.turnId,
      });
      return;
    }
    if (event.strategy !== 'media-degrade') return;
    const degraded = event.action === 'degraded';
    this.log.warn(
      degraded
        ? 'provider rejected request as too large; resending with degraded media'
        : event.error.kind === 'request_too_large'
          ? 'provider rejected request as too large; resending with rejected media stripped'
          : 'provider rejected an image in the request; resending with rejected media stripped',
      {
        model: request.model.spec.name,
        ...request.logFields,
      },
    );
    this.telemetry.track2('llm_request_projection_fallback', {
      projection: degraded ? 'media-degraded' : 'media-stripped',
      error_type: event.error.kind,
      model: request.model.id,
      turn_id: request.source.turnId,
    });
  }

  completeRequest(
    observation: AgentRequestObservation,
    outcome: Extract<LlmOutcome, { type: 'done' }>,
  ): void {
    const request = observation.requireContext();
    observation.setRequestId(outcome.requestId);
    const { entry, usage, timing } = outcome;
    if (request.promptCacheProbe === 'compaction') {
      this.telemetry.track2('prompt_cache_probe', {
        source: 'compaction',
        turn_id: request.source.turnId,
        provider_type: request.model.providerType ?? request.model.protocol,
        protocol: request.model.protocol,
        ...cacheProbeUsage(usage),
      });
    }
    const inputTokens = usage === undefined ? undefined : inputTotal(usage);
    const recorded = observation.recorded;
    if (recorded !== undefined && usage !== undefined && inputTokens !== undefined && inputTokens + usage.output > 0) {
      const measured: MeasuredRequest = {
        modelAlias: request.modelAlias,
        contextRevision: request.contextRevision,
        toolsHash: recorded.toolsHash,
        systemPromptHash: recorded.systemPromptHash,
        messageCount: recorded.messageCount,
        historyHash: recorded.historyHash,
        inputTokens,
        startedAt: observation.startedAt,
        finishedAt: Date.now(),
        thinkingEffort: request.thinkingEffort,
        requestKind: requestKindForTelemetry(request.source),
        turnId: request.source.turnId,
        step: request.source.type === 'turn' ? request.source.step : undefined,
        traceId: outcome.requestId,
        usage,
      };
      this.trackCacheBreak(measured, recorded.messages);
      this.states.set(llmRequesterLastMeasuredRequestKey, measured);
    }
    void this.usage.record(this.scopeContext.agentContext, request.modelAlias, usage, request.source);
    if (usage !== undefined) {
      this.tokenCounting.measured(
        this.scopeContext.agentContext,
        recorded?.messages ?? toRequestMessages(request.entries),
        [entry.message],
        usage,
      );
    }
    this.logResponse(request.logFields, usage ?? emptyUsage(), timing);
  }

  failRequest(observation: AgentRequestObservation, error: unknown, signal: AbortSignal, requestId?: string): void {
    if (!isAbortError(error) && !signal.aborted) {
      this.logRequestFailure(observation, error);
      this.trackApiError(observation, error, requestId);
    }
    observation.setRequestId(requestId);
  }

  reportProjectionRepairs(anomalies: readonly ProjectionAnomaly[]): void {
    const notable = anomalies.filter(
      (anomaly) => !(anomaly.kind === 'tool_result_synthesized' && anomaly.trailing),
    );
    if (notable.length === 0) {
      this.states.set(contextProjectorLastRepairSignatureKey, null);
      return;
    }
    const signature = notable
      .map((anomaly) => ('toolCallId' in anomaly ? `${anomaly.kind}:${anomaly.toolCallId}` : anomaly.kind))
      .toSorted()
      .join('|');
    if (signature === this.states.get(contextProjectorLastRepairSignatureKey)) return;
    this.states.set(contextProjectorLastRepairSignatureKey, signature);

    const {
      reordered,
      synthesized,
      droppedOrphan,
      duplicateCallsDropped,
      duplicateResultsDropped,
      leadingDropped,
      assistantsMerged,
      whitespaceDropped,
      vacuousDropped,
    } = summarizeProjectionRepairs(notable);
    const toolCallIds = [
      ...new Set(
        notable.flatMap((anomaly) => ('toolCallId' in anomaly ? [anomaly.toolCallId] : [])),
      ),
    ].slice(0, 5);
    this.log.warn('repaired the request to keep it wire-valid', {
      reordered,
      synthesized,
      droppedOrphan,
      duplicateCallsDropped,
      duplicateResultsDropped,
      leadingDropped,
      assistantsMerged,
      whitespaceDropped,
      vacuousDropped,
      toolCallIds,
    });
    this.telemetry.track2('context_projection_repaired', {
      reordered,
      synthesized,
      dropped_orphan: droppedOrphan,
      duplicate_calls_dropped: duplicateCallsDropped,
      duplicate_results_dropped: duplicateResultsDropped,
      leading_dropped: leadingDropped,
      assistants_merged: assistantsMerged,
      whitespace_dropped: whitespaceDropped,
      vacuous_dropped: vacuousDropped,
    });
  }

  private logRequest(request: ResolvedRequestContext, input: RequestLogInput): void {
    const logFields: AgentLLMRequestLogFields = input.fields ?? {};
    const snapshot = llmToolsSnapshotPayload(input.tools);
    const config = {
      provider: request.model.protocol,
      model: request.model.spec.name,
      modelAlias: request.modelAlias,
      thinkingEffort: request.thinkingEffort,
      systemPromptChars: input.systemPrompt.length,
      toolCount: snapshot.tools.length,
    };
    const signature = JSON.stringify({
      ...config,
      systemPromptHash: fingerprint(input.systemPrompt),
      toolsHash: snapshot.hash,
    });
    if (signature !== this.states.get(llmRequesterLastConfigLogSignatureKey)) {
      this.states.set(llmRequesterLastConfigLogSignatureKey, signature);
      this.log.info('llm config', { ...logFields, ...config });
    }

    const partialMessageCount = input.messages.filter(
      (message) => 'partial' in message && message.partial === true,
    ).length;
    const requestFields: LogContext = { ...logFields };
    if (partialMessageCount > 0) requestFields['partialMessageCount'] = partialMessageCount;
    this.log.info('llm request', requestFields);
  }

  private logResponse(
    fields: AgentLLMRequestLogFields | undefined,
    usage: TokenUsage,
    timing: LlmTiming | undefined,
  ): void {
    if (timing === undefined) return;
    const payload: LogContext = {
      ...fields,
      ttftMs: timing.firstTokenLatencyMs,
      streamDurationMs: timing.streamDurationMs,
      outputTokens: usage.output,
    };
    if (timing.requestBuildMs !== undefined) payload['requestBuildMs'] = timing.requestBuildMs;
    if (timing.serverFirstTokenMs !== undefined) payload['serverFirstTokenMs'] = timing.serverFirstTokenMs;
    if (timing.serverDecodeMs !== undefined) payload['serverDecodeMs'] = timing.serverDecodeMs;
    if (timing.clientConsumeMs !== undefined) payload['clientConsumeMs'] = timing.clientConsumeMs;
    if (timing.clientBlockedMs !== undefined) payload['clientBlockedMs'] = timing.clientBlockedMs;
    this.log.info('llm response', payload);
  }

  private logRequestFailure(observation: AgentRequestObservation, error: unknown): void {
    const modelAlias = observation.context?.modelAlias ?? observation.config.resolved.modelAlias;
    this.log.warn('llm request failed', {
      ...agentLLMRequestLogFields(observation.source),
      model: modelAlias,
      ...retryErrorFields(error),
      diagnostics: errorDiagnostics(error),
    });
  }

  private trackApiError(observation: AgentRequestObservation, error: unknown, requestId?: string): void {
    const model = observation.context?.model;
    const modelAlias = observation.context?.modelAlias ?? observation.config.resolved.modelAlias;
    const source = observation.source;
    const classification = classifyApiError(unwrapErrorCause(error));
    const properties: ApiErrorEvent = {
      error_type: classification.kind,
      model: model?.id ?? modelAlias,
      alias: modelAlias,
      provider_type: model?.providerType ?? model?.protocol,
      protocol: model?.protocol,
      retryable: isRetryableGenerateError(error),
      duration_ms: Math.max(0, Date.now() - observation.startedAt),
      turn_id: source.turnId,
      request_kind: requestKindForTelemetry(source),
      request_id: requestId ?? apiRequestId(error),
    };
    if (source.type === 'turn' && source.step !== undefined) properties['step_no'] = source.step;
    const statusCode = apiStatusCode(error);
    if (statusCode !== undefined) properties['status_code'] = statusCode;
    const currentTurn = this.usage.status(this.scopeContext.agentContext).currentTurn;
    if (currentTurn !== undefined) properties['input_tokens'] = inputTotal(currentTurn);
    this.telemetry.track2('api_error', properties);
  }

  private trackCacheBreak(curr: MeasuredRequest, messages: readonly Message[]): void {
    const prev = this.states.get(llmRequesterLastMeasuredRequestKey);
    if (prev === undefined || prev.contextRevision !== curr.contextRevision) return;
    const prevRead = prev.usage.inputCacheRead;
    const currRead = curr.usage.inputCacheRead;
    const prevTotal = grandTotal(prev.usage);
    if (prevRead === undefined || currRead === undefined || prevTotal === undefined) return;
    const readDrop = prevRead - currRead;
    const reusableDrop = prevTotal - currRead;
    const readBreak = currRead < prevRead * CACHE_BREAK_DROP_RATIO && readDrop > CACHE_BREAK_MIN_DROP_TOKENS;
    const reuseBreak = currRead < prevTotal * CACHE_BREAK_DROP_RATIO && reusableDrop > CACHE_BREAK_MIN_DROP_TOKENS;
    if (!readBreak && !reuseBreak) return;
    const properties: CacheBreakDetectedEvent = {
      request_kind: curr.requestKind,
      turn_id: curr.turnId,
      step_no: curr.step,
      trace_id: curr.traceId,
      prev_request_kind: prev.requestKind,
      prev_turn_id: prev.turnId,
      prev_step_no: prev.step,
      prev_trace_id: prev.traceId,
      prev_model: prev.modelAlias,
      curr_model: curr.modelAlias,
      prev_effort: prev.thinkingEffort,
      curr_effort: curr.thinkingEffort,
      prev_input_cache_read: prevRead,
      curr_input_cache_read: currRead,
      prev_input_other: prev.usage.inputOther,
      curr_input_other: curr.usage.inputOther,
      prev_output: prev.usage.output,
      curr_output: curr.usage.output,
      prev_input_cache_creation: prev.usage.inputCacheCreation,
      curr_input_cache_creation: curr.usage.inputCacheCreation,
      prev_total_tokens: prevTotal,
      cache_reuse_ratio: currRead / prevTotal,
      cache_read_drop_ratio: prevRead === 0 ? undefined : readDrop / prevRead,
      tools_match: prev.toolsHash === curr.toolsHash,
      system_prompt_match: prev.systemPromptHash === curr.systemPromptHash,
      history_prefix_match: historyPrefixMatches(prev, messages),
      gap_ms: curr.startedAt - prev.finishedAt,
      interval_ms: curr.finishedAt - prev.finishedAt,
    };
    this.telemetry.track2('cache_break_detected', properties);
  }

  private warnAboutAnthropicThinkingEffort(request: ResolvedRequestContext): void {
    if (request.model.protocol !== 'anthropic') return;
    const effort = request.thinkingEffort;
    if (effort === 'on' || effort === 'off') return;
    const supportEfforts = request.model.spec.thinking?.supportEfforts?.filter((value) => value.length > 0);
    if (supportEfforts === undefined || supportEfforts.length === 0 || supportEfforts.includes(effort)) return;
    const code = 'anthropic-thinking-effort-not-listed';
    const knownEfforts = supportEfforts.join(',');
    const message = `Thinking effort "${effort}" is not listed for model "${request.model.spec.name}" (known: ${supportEfforts.join(', ')}). The configured value will be sent unchanged to the Anthropic-compatible backend.`;
    const key = [code, request.modelAlias, request.model.spec.name, effort, knownEfforts].join('\u0000');
    const emitted = this.states.get(llmRequesterEmittedThinkingEffortWarningsKey);
    if (emitted.has(key)) return;
    emitted.add(key);
    try {
      this.log.warn(message, {
        modelAlias: request.modelAlias,
        model: request.model.spec.name,
        effort,
        knownEfforts,
      });
    } catch {
    }
    try {
      void this.dispatcher.dispatch(
        new WarningIssued({ agentId: this.scopeContext.agentId, code, message }),
      );
    } catch {
    }
  }
}

export class AgentRequestObservation {
  readonly startedAt = Date.now();
  readonly media: AttemptObservation = {};
  context: ResolvedRequestContext | undefined;
  recorded: RecordedRequestSnapshot | undefined;
  private readonly trace = new MutableLLMRequestTrace();

  constructor(
    private readonly observer: AgentLoopRequestObserver,
    readonly source: AgentLLMRequestSource,
    readonly config: RequestConfigSnapshot,
    onTrace?: (trace: LLMRequestTrace) => void,
  ) {
    onTrace?.(this.trace);
    this.setRequestId(undefined);
  }

  prepare(context: ResolvedRequestContext): void {
    this.context = context;
  }

  setRequestId(requestId: string | null | undefined): void {
    this.trace.set(requestId ?? undefined);
    this.observer.setRequestId(this.source, requestId ?? undefined);
  }

  requireContext(): ResolvedRequestContext {
    if (this.context === undefined) throw new Error('request observation has no resolved context');
    return this.context;
  }
}

class MutableLLMRequestTrace implements LLMRequestTrace {
  requestId: string | undefined;

  set(requestId: string | undefined): void {
    this.requestId = requestId;
  }
}

function requestKindForTelemetry(source: AgentLLMRequestSource): string {
  return source.type === 'turn' ? 'turn' : source.requestKind ?? 'operation';
}

function latestMediaRecovery(recoveries: readonly LlmRecoveryRecord[]): LlmRecoveryRecord | undefined {
  return recoveries.findLast((recovery) => recovery.strategy === 'media-degrade');
}

function projectionNameOf(
  recoveries: readonly LlmRecoveryRecord[],
  media: LlmRecoveryRecord | undefined,
): RequestProjection | undefined {
  if (hasStrictStructureRecovery(recoveries)) {
    if (media === undefined) return 'strict';
    return media.action === 'degraded' ? 'strict-media-degraded' : 'strict-media-stripped';
  }
  if (media === undefined) return undefined;
  return media.action === 'degraded' ? 'media-degraded' : 'media-stripped';
}

function fingerprint(content: string): string {
  return createHash('sha256').update(content).digest('hex');
}

function historyPrefixMatches(baseline: MeasuredRequest, messages: readonly Message[]): boolean {
  return (
    baseline.messageCount <= messages.length &&
    fingerprint(JSON.stringify(messages.slice(0, baseline.messageCount))) === baseline.historyHash
  );
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

function apiRequestId(error: unknown): string | undefined {
  const diagnostics = errorDiagnostics(error) ?? errorDiagnostics(unwrapErrorCause(error));
  const requestId = diagnostics?.['requestId'];
  if (typeof requestId === 'string') return requestId;
  return isLlmErrorMessage(error) ? llmErrorRequestId(error) : undefined;
}

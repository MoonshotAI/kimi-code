import { createHash } from 'node:crypto';
import { defineState } from '#/state/state';
import { IAgentContextMemoryService } from '#/agent/contextMemory/contextMemory';
import { countMediaParts } from '#human/llm/builtin/policy/media-degrade';
import {
  createRecoveryLedger,
  type LlmRecoveryLedger,
  type LlmRecoveryRecord,
} from '#human/llm/policy/recovery';
import { withProtocolCapabilities } from '#human/llm/protocol/rules/model';
import { ISessionTokenCountingService } from '#/session/tokenCounting/sessionTokenCounting';
import { IAgentProfileService, type ProfileModelContext } from '#/agent/profile/profile';
import { IAgentStateService } from '#/agent/state/agentState';
import { IAgentToolSelectService } from '#/agent/toolSelect/toolSelect';
import { ISessionUsageService } from '#/session/usage/sessionUsage';
import { cacheProbeUsage } from '#/agent/usage/cacheProbe';
import { IConfigService } from '#/app/config/config';
import {
  APIContextOverflowError,
  APIStatusError,
  classifyApiError,
  errorDiagnostics,
  isRetryableGenerateError,
} from '#/llm-adapter/contract/errors';
import { type ThinkingEffort } from '#human/llm-requester/thinking';
import type { LlmCredentialProvider } from '#human/llm-requester/requester';
import { type Message, type ToolDescription as Tool } from '#human/llm/message';
import { emptyUsage, inputTotal, type TokenUsage } from '#human/llm-requester/usage';
import { ILogService, type LogContext } from '#/_base/log/log';
import { IModelCatalog, type Model } from '#/llm-adapter/model/catalog';
import {
  effectiveMaxCompletionTokens,
  generateModel,
  type InitializedLlmRequester,
  type ModelRequestEvent,
  type ModelRequestParams,
  type ModelRequestTiming,
} from '#/llm-adapter/model/generate';
import type { ModelOverrides } from '#/llm-adapter/model/model.types';
import { IModelService } from '#/llm-adapter/model/model';
import { completionBudgetParams, resolveCompletionBudget } from '#/llm-adapter/model/completion-budget';
import { resolveThinkingKeep, type ThinkingConfig } from '#/llm-adapter/model/thinking';
import { THINKING_SECTION } from '#/app/kosongConfig/configSection';
import { IProtocolAdapterRegistry, type Protocol } from '#/llm-adapter/protocol/protocol';
import type { ApiErrorEvent } from '#/app/telemetry/events';
import { ITelemetryService } from '#/app/telemetry/telemetry';
import { IAgentScopeContext } from '#/agent/scopeContext/scopeContext';
import { IEventDispatcher } from '#/state/eventDispatcher';
import { WarningIssued } from '#/agent/profile/profileOps';

import {
  type LoopRequester,
  type AgentLLMRequestFinish,
  type AgentLLMRequestLogFields,
  type AgentLLMRequestOverrides,
  type AgentLLMRequestPartHandler,
  type AgentLLMRequestSource,
  type AgentLLMRequestTask,
  type PreparedTurnRequestConfig,
} from './requesterContract';
import type { LLMRequestTrace } from '#/llm-adapter/contract/request-trace';
import {
  LlmRequest,
  llmRequestTraceKey,
  LlmToolsSnapshot,
  type LlmRequestPayload,
  type LlmRequestToolSchema,
} from './llmRequestOps';
import { AgentLoopProjector } from './projector';
import {
  createStructureRecovery,
  createStructureResolver,
  hasStrictStructureRecovery,
} from './projectionPolicy';
import { createToolSelectResolver } from './toolSelectPolicy';
import type { AgentMediaPolicyFactory } from './mediaPolicy';
import { isAbortError } from '#/_base/utils/abort';
import { parseBooleanEnv } from '#/_base/utils/env';
import { ErrorCodes, Error2, unwrapErrorCause } from '#/errors';
import {
  readRetryAfterMs,
  retryBackoffDelay,
  retryErrorFields,
  sleepForRetry,
} from '#/_base/utils/retry';
import { IBootstrapService } from '#/app/bootstrap/bootstrap';

const noopOnPart: AgentLLMRequestPartHandler = () => {};

export const KIMI_CODE_INFINITE_RETRY_ENV = 'KIMI_CODE_INFINITE_RETRY';

interface ResolvedLLMRequest {
  readonly request: InitializedLlmRequester;
  readonly model: Model;
  readonly params: ModelRequestParams;
  readonly modelAlias: string;
  readonly thinkingEffort: ThinkingEffort;
  readonly systemPrompt: string;
  readonly tools?: readonly Tool[];
  readonly messages: Message[];
  readonly contextRevision: number;
  readonly promptCacheProbe: 'compaction' | undefined;
  readonly source: AgentLLMRequestSource | undefined;
  readonly logFields: AgentLLMRequestLogFields;
}

interface LLMRequestLogInput {
  readonly protocol: Protocol;
  readonly providerType?: string;
  readonly modelName: string;
  readonly modelAlias?: string;
  readonly thinkingEffort?: ThinkingEffort | null;
  readonly maxTokens?: number;
  readonly systemPrompt: string;
  readonly tools: readonly Tool[];
  readonly toolSelect: boolean;
  readonly messages: readonly Message[];
  readonly fields?: AgentLLMRequestLogFields;
}

interface TurnRequestConfig {
  readonly resolved: ProfileModelContext;
  readonly params: ModelRequestParams;
  readonly systemPrompt: string;
}

export const llmRequesterLastConfigLogSignatureKey = defineState<string | undefined>(
  'llmRequester.lastConfigLogSignature',
  () => undefined as string | undefined,
);
export const llmRequesterTurnConfigsKey = defineState<Map<number, TurnRequestConfig>>(
  'llmRequester.turnConfigs',
  () => new Map(),
);
interface MediaRecovery {
  readonly modelAlias: string;
  readonly contextRevision: number;
  readonly ledger: unknown;
}

export const llmRequesterMediaRecoveryKey = defineState<MediaRecovery | undefined>(
  'llmRequester.mediaRecovery',
  () => undefined as MediaRecovery | undefined,
);
export const llmRequesterEmittedThinkingEffortWarningsKey = defineState<Set<string>>(
  'llmRequester.emittedThinkingEffortWarnings',
  () => new Set(),
);
export class AgentLoopRequester implements LoopRequester {
  private readonly projector: AgentLoopProjector;
  private mediaPolicyFactory: AgentMediaPolicyFactory | undefined;

  constructor(
    @IAgentContextMemoryService private readonly context: IAgentContextMemoryService,
    @ISessionTokenCountingService private readonly tokenCounting: ISessionTokenCountingService,
    @IAgentToolSelectService private readonly toolSelect: IAgentToolSelectService,
    @IAgentProfileService private readonly profile: IAgentProfileService,
    @ISessionUsageService private readonly usage: ISessionUsageService,
    @IConfigService private readonly config: IConfigService,
    @IModelService private readonly modelService: IModelService,
    @IModelCatalog private readonly modelCatalog: IModelCatalog,
    @IProtocolAdapterRegistry private readonly protocolRegistry: IProtocolAdapterRegistry,
    @ILogService private readonly log: ILogService,
    @ITelemetryService private readonly telemetry: ITelemetryService,
    @IEventDispatcher private readonly dispatcher: IEventDispatcher,
    @IAgentScopeContext private readonly scopeContext: IAgentScopeContext,
    @IAgentStateService private readonly states: IAgentStateService,
    @IBootstrapService private readonly bootstrap: IBootstrapService,
  ) {
    this.projector = new AgentLoopProjector(log, telemetry, states);
    this.states.contributeState(llmRequestTraceKey);
    this.states.contributeState(llmRequesterLastConfigLogSignatureKey);
    this.states.contributeState(llmRequesterTurnConfigsKey);
    this.states.contributeState(llmRequesterMediaRecoveryKey);
    this.states.contributeState(llmRequesterEmittedThinkingEffortWarningsKey);
  }

  registerMediaPolicy(factory: AgentMediaPolicyFactory): void {
    this.mediaPolicyFactory = factory;
  }

  private get lastConfigLogSignature(): string | undefined {
    return this.states.get(llmRequesterLastConfigLogSignatureKey);
  }

  private set lastConfigLogSignature(value: string | undefined) {
    this.states.set(llmRequesterLastConfigLogSignatureKey, value);
  }

  private get turnConfigs(): Map<number, TurnRequestConfig> {
    return this.states.get(llmRequesterTurnConfigsKey);
  }

  private get emittedThinkingEffortWarnings(): Set<string> {
    return this.states.get(llmRequesterEmittedThinkingEffortWarningsKey);
  }

  prepareTurnConfig(turnId: number): PreparedTurnRequestConfig | undefined {
    if (!this.profile.hasProvider()) return undefined;
    const config = this.getOrCreateTurnConfig(turnId);
    return { thinkingEffort: config.resolved.thinkingLevel };
  }

  currentCredentialProvider(): LlmCredentialProvider | undefined {
    if (!this.profile.hasProvider()) return undefined;
    return this.modelCatalog.get(this.profile.resolveModelContext().modelAlias).credentialProvider;
  }

  credentialProviderForTurn(turnId: number): LlmCredentialProvider | undefined {
    if (!this.profile.hasProvider()) return undefined;
    const resolved = this.turnConfigs.get(turnId)?.resolved ?? this.profile.resolveModelContext();
    return this.modelCatalog.get(resolved.modelAlias).credentialProvider;
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
    const setRequestId = (requestId: string | undefined): void => {
      trace.set(requestId);
      if (overrides.source?.type === 'turn') {
        this.telemetry.setContext({ request_id: requestId });
      }
    };
    setRequestId(undefined);
    try {
      return await this.runRequest(
        this.resolveRequest(overrides),
        onPart,
        signal,
        setRequestId,
        overrides.onAttemptRetry,
      );
    } catch (error) {
      this.logRequestFailure(error, overrides, signal);
      this.trackApiError(error, startedAt, signal, overrides.source);
      setRequestId(undefined);
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
      diagnostics: errorDiagnostics(error),
    };
    this.log.warn('llm request failed', payload);
  }

  private trackApiError(
    error: unknown,
    startedAt: number,
    signal: AbortSignal | undefined,
    source?: AgentLLMRequestSource,
  ): void {
    if (isAbortError(error) || signal?.aborted === true) return;
    const modelAlias = this.profile.data().modelAlias;
    const model = this.tryGetModel();
    const classification = classifyApiError(unwrapErrorCause(error));
    const properties: ApiErrorEvent = {
      error_type: classification.kind,
      model: model?.id ?? modelAlias ?? 'unknown',
      alias: modelAlias,
      provider_type: model?.providerType ?? model?.protocol,
      protocol: model?.protocol,
      retryable: isRetryableGenerateError(error),
      duration_ms: Math.max(0, Date.now() - startedAt),
      turn_id: source?.turnId,
      request_kind: requestKindForTelemetry(source),
      request_id: apiRequestId(error),
    };
    if (source?.type === 'turn') {
      if (source.step !== undefined) properties['step_no'] = source.step;
    }
    const statusCode = apiStatusCode(error);
    if (statusCode !== undefined) properties['status_code'] = statusCode;
    const currentTurn = this.usage.status(this.scopeContext.agentContext).currentTurn;
    if (currentTurn !== undefined) properties['input_tokens'] = inputTotal(currentTurn);
    this.telemetry.track2('api_error', properties);
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
    onRequestId: (requestId: string | undefined) => void,
    onAttemptRetry: (() => void) | undefined,
  ): Promise<AgentLLMRequestFinish> {
    let cacheProbeReported = false;
    const mediaPolicy = this.mediaPolicyFactory?.(request.model, request.request);
    const recoveredMedia = this.recoveredMedia(request);
    const recoveryLedger =
      recoveredMedia === undefined
        ? createRecoveryLedger()
        : mediaPolicy === undefined
          ? recoveredMedia.fork()
          : await mediaPolicy.refreshRecovery(recoveredMedia, request.messages);
    const toolSelectResolver = createToolSelectResolver(this.toolSelect);
    const structureResolver = createStructureResolver(this.projector);
    const structureRecovery = createStructureRecovery(this.projector);
    let previousMediaCount: number | undefined;
    let previousMediaRecovery: LlmRecoveryRecord | undefined;
    const run = async (): Promise<AgentLLMRequestFinish> => {
      let message: Extract<ModelRequestEvent, { type: 'finish' }>['message'] | undefined;
      let usage: TokenUsage | undefined;
      let timing: ModelRequestTiming | undefined;
      let finish: Extract<ModelRequestEvent, { type: 'finish' }> | undefined;
      const setRequestId = (requestId: string | null | undefined): void => {
        const normalized = requestId ?? undefined;
        onRequestId(normalized);
      };

      for await (const event of generateModel(
        request.request,
        {
          systemPrompt: request.systemPrompt,
          tools: request.tools,
          messages: request.messages,
        },
        signal,
        {
          ...request.params,
          onRequestId: setRequestId,
        },
        {
          recoveries: [
            structureRecovery,
            ...(mediaPolicy === undefined ? [] : [mediaPolicy.recovery]),
          ],
          resolvers: [
            toolSelectResolver,
            ...(mediaPolicy === undefined ? [] : [mediaPolicy.toolResolver]),
            structureResolver,
            ...(mediaPolicy === undefined ? [] : [mediaPolicy.resolver]),
          ],
          recoveryLedger,
          onAttempt: (attemptInput, attemptRequest) => {
            onRequestId(undefined);
            const mediaRecovery = latestMediaRecovery(recoveryLedger.applied);
            const projection = projectionNameOf(recoveryLedger.applied, mediaRecovery);
            const fields =
              projection === undefined
                ? request.logFields
                : { ...request.logFields, projection };
            const currentMediaCount = countMediaParts(attemptInput.messages);
            const mediaPolicyChanged =
              previousMediaCount !== undefined && previousMediaRecovery !== mediaRecovery;
            const droppedMediaCount =
              previousMediaCount === undefined ? 0 : previousMediaCount - currentMediaCount;
            previousMediaCount = currentMediaCount;
            previousMediaRecovery = mediaRecovery;
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
            const logInput: LLMRequestLogInput = {
              protocol: request.model.protocol,
              providerType: request.model.providerType,
              modelName: request.model.name,
              modelAlias: request.modelAlias,
              thinkingEffort: request.thinkingEffort,
              maxTokens: effectiveMaxCompletionTokens(request.params),
              systemPrompt: attemptInput.systemPrompt,
              tools: attemptInput.tools ?? [],
              toolSelect: this.toolSelect.enabled(
                withProtocolCapabilities(attemptRequest.model.spec, attemptRequest.protocol.base)
                  .capability ?? {},
              ),
              messages: attemptInput.messages,
              fields,
            };
            this.logRequest(logInput);
            this.recordRequest(logInput);
          },
          onRecovery: (recovery) => {
            if (recovery.strategy === 'structure') {
              this.log.warn('provider rejected request structure; resending with strict projection', {
                model: request.model.name,
                ...request.logFields,
              });
              this.telemetry.track2('llm_request_projection_fallback', {
                projection: 'strict',
                error_type: recovery.error.kind,
                model: request.model.id,
                turn_id: request.source?.turnId,
              });
              onAttemptRetry?.();
              return;
            }
            if (recovery.strategy !== 'media-degrade') return;
            this.markMediaRecovery(request, recoveryLedger);
            const degraded = recovery.action === 'degraded';
            this.log.warn(
              degraded
                ? 'provider rejected request as too large; resending with degraded media'
                : recovery.error.kind === 'request_too_large'
                  ? 'provider rejected request as too large; resending with rejected media stripped'
                  : 'provider rejected an image in the request; resending with rejected media stripped',
              {
                model: request.model.name,
                ...request.logFields,
              },
            );
            this.telemetry.track2('llm_request_projection_fallback', {
              projection: degraded ? 'media-degraded' : 'media-stripped',
              error_type: recovery.error.kind,
              model: request.model.id,
              turn_id: request.source?.turnId,
            });
            onAttemptRetry?.();
          },
        },
      )) {
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
            setRequestId(event.requestId);
            break;
          case 'timing': {
            const { type: _type, ...streamTiming } = event;
            timing = streamTiming;
            break;
          }
        }
      }

      const completedMessage = message;
      if (completedMessage === undefined || finish === undefined) {
        throw new Error2(
          ErrorCodes.PROVIDER_API_ERROR,
          'LLM request stream ended without a finish event.',
        );
      }
      message = completedMessage;
      if (request.promptCacheProbe === 'compaction' && !cacheProbeReported) {
        cacheProbeReported = true;
        this.telemetry.track2('prompt_cache_probe', {
          source: 'compaction',
          turn_id: request.source?.turnId,
          provider_type: request.model.providerType ?? request.model.protocol,
          protocol: request.model.protocol,
          ...cacheProbeUsage(usage),
        });
      }
      void this.usage.record(
        this.scopeContext.agentContext,
        request.modelAlias,
        usage,
        request.source,
      );
      if (usage !== undefined) {
        this.tokenCounting.measured(this.scopeContext.agentContext, request.messages, [message], usage);
      }
      this.logResponse(request.logFields, usage ?? emptyUsage(), timing);

      return {
        message,
        usage: usage ?? emptyUsage(),
        model: request.modelAlias,
        providerFinishReason: finish.providerFinishReason,
        rawFinishReason: finish.rawFinishReason,
        providerMessageId: finish.id,
        timing,
        requestId: finish.requestId,
      };
    };

    let infiniteRetryAttempt = 0;
    for (;;) {
      try {
        return await run();
      } catch (error) {
        const raw = unwrapErrorCause(error);
        if (
          !this.infiniteRetryEnabled ||
          isAbortError(error) ||
          signal?.aborted === true ||
          raw instanceof APIContextOverflowError
        ) {
          throw error;
        }
        infiniteRetryAttempt += 1;
        const delayMs =
          readRetryAfterMs(raw) ??
          retryBackoffDelay(infiniteRetryAttempt - 1);
        this.log.warn('llm request failed; retrying indefinitely (KIMI_CODE_INFINITE_RETRY)', {
          model: request.model.name,
          ...request.logFields,
          attempt: infiniteRetryAttempt,
          delayMs,
          ...retryErrorFields(error),
        });
        onAttemptRetry?.();
        await sleepForRetry(delayMs, signal);
      }
    }
  }

  private get infiniteRetryEnabled(): boolean {
    return parseBooleanEnv(this.bootstrap.getEnv(KIMI_CODE_INFINITE_RETRY_ENV)) === true;
  }

  private warnAboutAnthropicThinkingEffort(request: ResolvedLLMRequest): void {
    if (request.model.protocol !== 'anthropic') return;
    const effort = request.thinkingEffort;
    if (effort === 'on' || effort === 'off') return;

    let code: string;
    let message: string;
    let knownEfforts: string | undefined;
    const supportEfforts = request.model.supportEfforts?.filter((value) => value.length > 0);
    if (supportEfforts === undefined || supportEfforts.length === 0) return;
    if (supportEfforts.includes(effort)) return;
    code = 'anthropic-thinking-effort-not-listed';
    knownEfforts = supportEfforts.join(',');
    message = `Thinking effort "${effort}" is not listed for model "${request.model.name}" (known: ${supportEfforts.join(', ')}). The configured value will be sent unchanged to the Anthropic-compatible backend.`;

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
      void this.dispatcher.dispatch(
        new WarningIssued({ agentId: this.scopeContext.agentId, code, message }),
      );
    } catch {
    }
  }

  private recoveredMedia(request: ResolvedLLMRequest): LlmRecoveryLedger | undefined {
    const recovery = this.states.get(llmRequesterMediaRecoveryKey);
    if (
      recovery === undefined ||
      recovery.modelAlias !== request.modelAlias ||
      recovery.contextRevision !== request.contextRevision
    ) {
      return undefined;
    }
    return recovery.ledger as LlmRecoveryLedger;
  }

  private markMediaRecovery(request: ResolvedLLMRequest, ledger: LlmRecoveryLedger): void {
    if (request.source?.type !== 'turn') return;
    this.states.set(llmRequesterMediaRecoveryKey, {
      modelAlias: request.modelAlias,
      contextRevision: request.contextRevision,
      ledger: ledger.fork((entry) => entry.strategy === 'media-degrade'),
    });
  }

  private resolveRequest(overrides: AgentLLMRequestOverrides): ResolvedLLMRequest {
    const turnConfig = this.resolveTurnConfig(overrides.source);
    const resolved = turnConfig?.resolved ?? this.profile.resolveModelContext();
    const baseParams = turnConfig?.params ?? this.profile.resolveRequestParams();
    const model = this.modelCatalog.get(resolved.modelAlias);
    const maxCompletionTokensCap =
      this.config.get<ModelOverrides>('modelOverrides')?.maxCompletionTokens;
    const usedContextTokens =
      overrides.usedContextTokens ??
      (overrides.messages === undefined
        ? this.tokenCounting.get(this.scopeContext.agentContext).size
        : undefined);
    const budgetParams = completionBudgetParams({
      budget: resolveCompletionBudget({
        maxOutputSize: overrides.maxOutputSize ?? resolved.maxOutputSize,
        maxCompletionTokensCap,
      }),
      capability: resolved.modelCapabilities,
      usedContextTokens,
    });
    const optedOut = maxCompletionTokensCap !== undefined && maxCompletionTokensCap <= 0;
    const params: ModelRequestParams = {
      ...baseParams,
      ...budgetParams,
      ...(usedContextTokens === undefined ? {} : { usedContextTokens }),
      ...(optedOut ? { maxCompletionTokens: maxCompletionTokensCap } : {}),
    };

    const messages = overrides.messages ?? this.context.get();
    return {
      request: this.protocolRegistry.request(model, params),
      model,
      params,
      modelAlias: resolved.modelAlias,
      thinkingEffort: resolved.thinkingLevel,
      systemPrompt: overrides.systemPrompt ?? turnConfig?.systemPrompt ?? this.profile.getSystemPrompt(),
      tools: overrides.tools === undefined ? undefined : [...overrides.tools],
      messages: [...messages],
      contextRevision: this.context.prefixRevision(),
      promptCacheProbe: overrides.promptCacheProbe,
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

    const partialMessageCount = input.messages.filter(
      (message) => 'partial' in message && message.partial === true,
    ).length;
    const requestFields: LogContext = { ...logFields };
    if (partialMessageCount > 0) requestFields['partialMessageCount'] = partialMessageCount;
    this.log.info('llm request', requestFields);
  }

  private recordRequest(input: LLMRequestLogInput): void {
    const fields = input.fields ?? {};
    const wireTools = providerVisibleTools(input.tools);
    const tools = toolSignature(wireTools);
    const toolsHash = fingerprint(JSON.stringify(tools));
    if (!this.states.get(llmRequestTraceKey).seenToolsHashes.includes(toolsHash)) {
      void this.dispatcher.dispatch(
        new LlmToolsSnapshot({ agentId: this.scopeContext.agentId, hash: toolsHash, tools }),
      );
    }

    const systemPromptHash = fingerprint(input.systemPrompt);
    const overrides = this.config.get<ModelOverrides>('modelOverrides');
    const thinkingConfig = this.config.get<ThinkingConfig>(THINKING_SECTION);
    const modelConfig =
      input.modelAlias === undefined ? undefined : this.modelService.get(input.modelAlias);
    const payload: LlmRequestPayload = {
      agentId: this.scopeContext.agentId,
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
      toolSelect: input.toolSelect,
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
    void this.dispatcher.dispatch(new LlmRequest(payload));
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
    if (timing.clientBlockedMs !== undefined) payload['clientBlockedMs'] = timing.clientBlockedMs;
    this.log.info('llm response', payload);
  }
}

class MutableLLMRequestTrace implements LLMRequestTrace {
  requestId: string | undefined;

  set(requestId: string | undefined): void {
    this.requestId = requestId;
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

function requestKindForTelemetry(source: AgentLLMRequestSource | undefined): string | undefined {
  if (source?.type === 'turn') return 'turn';
  if (source?.type === 'operation') return source.requestKind ?? 'operation';
  return undefined;
}

function providerVisibleTools(tools: readonly Tool[]): readonly Tool[] {
  if (!tools.some((tool) => tool.deferred === true)) return tools;
  return tools.filter((tool) => tool.deferred !== true);
}

function toolSignature(tools: readonly Tool[]): readonly LlmRequestToolSchema[] {
  return tools.map(({ name, description, parameters }) => ({ name, description, parameters }));
}

function requestKindForRecord(fields: AgentLLMRequestLogFields): LlmRequestPayload['kind'] {
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

type LlmRequestProjection = NonNullable<LlmRequestPayload['projection']>;

function latestMediaRecovery(
  recoveries: readonly LlmRecoveryRecord[],
): LlmRecoveryRecord | undefined {
  return recoveries.findLast((recovery) => recovery.strategy === 'media-degrade');
}

function projectionNameOf(
  recoveries: readonly LlmRecoveryRecord[],
  media: LlmRecoveryRecord | undefined,
): LlmRequestProjection | undefined {
  if (hasStrictStructureRecovery(recoveries)) {
    if (media === undefined) return 'strict';
    return media.action === 'degraded' ? 'strict-media-degraded' : 'strict-media-stripped';
  }
  if (media === undefined) return undefined;
  return media.action === 'degraded' ? 'media-degraded' : 'media-stripped';
}

function projectionField(fields: AgentLLMRequestLogFields): LlmRequestProjection | undefined {
  const value = fields['projection'];
  switch (value) {
    case 'strict':
    case 'media-degraded':
    case 'media-stripped':
    case 'strict-media-degraded':
    case 'strict-media-stripped':
      return value;
    default:
      return undefined;
  }
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

function apiRequestId(error: unknown): string | undefined {
  const diagnostics = errorDiagnostics(error) ?? errorDiagnostics(unwrapErrorCause(error));
  const requestId = diagnostics?.['requestId'];
  return typeof requestId === 'string' ? requestId : undefined;
}

import { createRecoveryLedger, type LlmRecoveryLedger } from '@moonshot-ai/core/llm/policy/recovery';
import { credentialRecovery } from '@moonshot-ai/core/llm/policy/credentials';
import { ISessionTokenCountingService } from '#/session/tokenCounting/sessionTokenCounting';
import { IInstantiationService } from '#/_base/di/instantiation';
import type { EffectiveProfileReader } from '#/agent/profile/profile';
import { READ_MEDIA_FILE_TOOL_NAME } from '#/agent/tools/read-media-file/read-media-file';
import { IAgentToolSelectService } from '#/agent/toolSelect/toolSelect';
import { IConfigService } from '#/app/config/config';
import { type Message, type ToolDescription as Tool } from '@moonshot-ai/core/llm/message';
import { IModelCatalog } from '#/llm-adapter/model/catalog';
import type { ModelOverrides } from '#/llm-adapter/model/model.types';
import { resolveCompletionBudget } from '#/llm-adapter/model/completion-budget';
import { IProtocolAdapterRegistry } from '#/llm-adapter/protocol/protocol';
import { getProviderDefinition } from '#/llm-adapter/provider/provider-definition';
import { IAgentScopeContext } from '#/agent/scopeContext/scopeContext';
import { ISessionRequestAttributionService } from '#/session/requestAttribution/requestAttribution';
import { IEventDispatcher } from '#/state/eventDispatcher';
import { parseBooleanEnv } from '#/_base/utils/env';
import { IBootstrapService } from '#/app/bootstrap/bootstrap';
import { RequestMetadataTracker, requestMetadataHeaders } from './requestMetadata';

import {
  agentLLMRequestLogFields,
  type CoreLoopRequester,
  type CoreLoopRequesterOptions,
  type RequestConfigSnapshot,
  type ResolvedRequestContext,
} from './requesterContract';
import { AgentLoopProjector } from './projector';
import { AgentLoopRequestObserver } from './requestObservation';
import { createStructureRecovery, createStructureResolver } from './projectionPolicy';
import { createToolSelectResolver } from './toolSelectPolicy';
import type { AgentMediaPolicy, AgentMediaPolicyFactory } from './mediaPolicy';
import {
  contentsOf,
  mergeFields,
  requesterContents,
  type LlmDimension,
  type LlmRequestPart,
  type LlmRequestRest,
  type InitializedLlmRequestPart,
} from '@moonshot-ai/core/llm/requester';
import type { LlmRequest as CoreLlmRequest, LlmRequestModel, ModelCapability } from '@moonshot-ai/core/llm/request';
import type { LlmPolicy, LlmRunControl } from '@moonshot-ai/core/llm/policy/policy';
import type { LlmOutcome } from '@moonshot-ai/core/llm/response';
import { LOOP_CONTROL_SECTION, type LoopControl } from './configSection';

interface RequestOverrides {
  readonly messages?: readonly Message[];
  readonly tools?: readonly Tool[];
  readonly systemPrompt?: string;
  readonly source: ResolvedRequestContext['source'];
  readonly dynamicTools?: boolean;
  readonly maxOutputSize?: number;
  readonly usedContextTokens?: number;
  readonly promptCacheProbe?: 'compaction';
  readonly config: RequestConfigSnapshot;
  readonly runtime: ResolvedRequestContext['runtime'];
}

export const KIMI_CODE_INFINITE_RETRY_ENV = 'KIMI_CODE_INFINITE_RETRY';

type CoreRequestRest = LlmRequestRest<LlmDimension>;
type Fields = Readonly<Record<string, unknown>>;

interface PreparedCoreRequest {
  readonly resolved: ResolvedRequestContext;
  readonly mediaPolicy?: AgentMediaPolicy;
  readonly request: CoreLlmRequest;
}

export class AgentLoopRequestFactory {
  private readonly projector: AgentLoopProjector;
  private readonly requestMetadata: RequestMetadataTracker;
  private mediaPolicyFactory: AgentMediaPolicyFactory | undefined;
  private contextMessages: () => readonly Message[] = () => [];

  constructor(
    private readonly observer: AgentLoopRequestObserver,
    private readonly profile: () => EffectiveProfileReader,
    @ISessionTokenCountingService private readonly tokenCounting: ISessionTokenCountingService,
    @IInstantiationService private readonly instantiation: IInstantiationService,
    @IConfigService private readonly config: IConfigService,
    @IModelCatalog private readonly modelCatalog: IModelCatalog,
    @IProtocolAdapterRegistry private readonly protocolRegistry: IProtocolAdapterRegistry,
    @IAgentScopeContext private readonly scopeContext: IAgentScopeContext,
    @IBootstrapService private readonly bootstrap: IBootstrapService,
    @IEventDispatcher dispatcher: IEventDispatcher,
    @ISessionRequestAttributionService attribution: ISessionRequestAttributionService,
  ) {
    this.projector = new AgentLoopProjector((anomalies) => observer.reportProjectionRepairs(anomalies));
    this.requestMetadata = new RequestMetadataTracker(scopeContext, dispatcher, attribution);
  }

  private get toolSelect(): IAgentToolSelectService {
    return this.instantiation.invokeFunction((accessor) => accessor.get(IAgentToolSelectService));
  }

  registerMediaPolicy(factory: AgentMediaPolicyFactory): void {
    this.mediaPolicyFactory = factory;
  }

  bindHistory(messages: () => readonly Message[]): void {
    this.contextMessages = messages;
  }

  requestConfigSnapshot(): RequestConfigSnapshot {
    const profile = this.profile();
    return {
      resolved: profile.resolveModelContext(),
      params: profile.resolveRequestParams(),
      systemPrompt: profile.getSystemPrompt(),
      maxCompletionTokensCap: this.config.get<ModelOverrides>('modelOverrides')?.maxCompletionTokens,
    };
  }

  baselineTools(): readonly Tool[] {
    return this.toolSelect.initialTools();
  }

  operationTools(baseline: readonly Tool[], capabilities: ModelCapability | undefined): readonly Tool[] {
    const disclosure = this.toolSelect.enabled(capabilities);
    const active = new Set(this.toolSelect.defaultTools(disclosure).map((tool) => tool.name));
    return baseline.filter((tool) => active.has(tool.name));
  }

  async prepareTools(
    signal: AbortSignal,
    capabilities: ModelCapability | undefined,
    base?: readonly Tool[],
  ): Promise<readonly Tool[]> {
    await this.toolSelect.prepareForRequest(signal);
    return this.toolsForCapabilities(capabilities, base);
  }

  private toolsForCapabilities(
    capabilities: ModelCapability | undefined,
    base?: readonly Tool[],
  ): readonly Tool[] {
    const disclosure = this.toolSelect.enabled(capabilities);
    const tools = base ?? this.toolSelect.defaultTools(disclosure);
    if (capabilities?.image_in === true || capabilities?.video_in === true) return tools;
    return tools.filter((tool) => tool.name !== READ_MEDIA_FILE_TOOL_NAME);
  }

  coreRequester(options: CoreLoopRequesterOptions): CoreLoopRequester {
    const accumulate = (part: LlmRequestPart): CoreLoopRequester => ({
      [requesterContents]: part,
      with: ((next: LlmRequestPart | CoreLoopRequester) =>
        accumulate(mergeFields(part as Fields, contentsOf(next) as Fields) as LlmRequestPart)) as CoreLoopRequester['with'],
      request: (rest) => this.prepareCoreRequest(
        options,
        part,
        rest,
        options.source(),
        options.config ?? this.requestConfigSnapshot(),
      ).request,
      generate: (rest, control) => this.generateCoreRequest(options, part, rest, control),
      snapshot: () => {
        const config = options.config ?? this.requestConfigSnapshot();
        options.onSnapshot?.(config);
        return this.coreRequester({ ...options, config }).with(part);
      },
    });
    return accumulate({});
  }

  private prepareCoreRequest(
    options: CoreLoopRequesterOptions,
    part: LlmRequestPart,
    rest: CoreRequestRest,
    source: ResolvedRequestContext['source'],
    config: RequestConfigSnapshot,
  ): PreparedCoreRequest {
    const resolved = this.resolveRequest({
      source,
      messages: rest.content?.messages,
      systemPrompt: rest.profile?.systemPrompt,
      tools: rest.profile?.tools ?? options.tools,
      maxOutputSize: options.maxOutputSize,
      usedContextTokens: rest.content?.usedTokens,
      promptCacheProbe: options.promptCacheProbe,
      config,
      dynamicTools: options.dynamicTools ?? false,
      runtime: options.runtime,
    });
    const mediaPolicy = this.mediaPolicyFactory?.(resolved.model, resolved.request);
    const hostPolicy = this.corePolicy(resolved, mediaPolicy);
    const extraPolicy = mergeFields(part.policy as Fields | undefined, rest.policy as Fields | undefined) as
      | LlmPolicy
      | undefined;
    const base = mergeFields(contentsOf(resolved.request) as Fields, {
      profile: { systemPrompt: resolved.systemPrompt, tools: resolved.tools },
      content: { messages: resolved.messages, usedTokens: resolved.usedContextTokens },
    } as Fields);
    const request = mergeFields(mergeFields(base, part as Fields), rest as Fields) as unknown as CoreLlmRequest;
    return {
      resolved,
      mediaPolicy,
      request: {
        ...request,
        profile: { ...request.profile, tools: resolved.tools },
        policy: mergeCorePolicies(hostPolicy, extraPolicy),
      },
    };
  }

  private corePolicy(request: ResolvedRequestContext, mediaPolicy: AgentMediaPolicy | undefined): LlmPolicy {
    return {
      retry: {
        maxAttemptsPerStep:
          request.source.type === 'operation'
            ? 1
            : this.config.get<LoopControl>(LOOP_CONTROL_SECTION)?.maxAttemptsPerStep,
        infiniteRetry: this.infiniteRetryEnabled,
      },
      recoveries: [
        credentialRecovery,
        createStructureRecovery(this.projector),
        ...(mediaPolicy === undefined ? [] : [mediaPolicy.recovery]),
      ],
      resolvers: [
        createToolSelectResolver(this.toolSelect, request.dynamicTools),
        ...(mediaPolicy === undefined ? [] : [mediaPolicy.toolResolver]),
        createStructureResolver(this.projector),
        ...(mediaPolicy === undefined ? [] : [mediaPolicy.resolver]),
      ],
    };
  }

  private async generateCoreRequest(
    options: CoreLoopRequesterOptions,
    part: LlmRequestPart,
    rest: CoreRequestRest,
    control: LlmRunControl,
  ): Promise<LlmOutcome> {
    const source = options.source();
    const config = options.config ?? this.requestConfigSnapshot();
    const observation = this.observer.start(source, config, options.onTrace);
    try {
      const prepared = this.prepareCoreRequest(options, part, rest, source, config);
      const { resolved, mediaPolicy, request } = prepared;
      observation.prepare(resolved, request);
      const recoveredMedia = this.recoveredMedia(resolved);
      const recoveryLedger =
        control.recoveries ??
        (recoveredMedia === undefined
          ? createRecoveryLedger()
          : mediaPolicy === undefined
            ? recoveredMedia.fork()
            : await mediaPolicy.refreshRecovery(recoveredMedia, resolved.messages));
      const outcome = await resolved.request.with({
        protocol: request.protocol,
        endpoint: request.endpoint,
        model: request.model,
        content: request.content,
        profile: request.profile,
        policy: request.policy,
      }).generate(
        {},
        {
          signal: control.signal,
          recoveries: recoveryLedger,
          onAttempt: (attemptRequest) => {
            this.observer.recordAttempt(observation, attemptRequest, recoveryLedger);
          },
          onEvent: (event) => {
            if (event.type === 'llm.retrying' && event.reason === 'recovery' && event.strategy === 'media-degrade') {
              this.markMediaRecovery(resolved, recoveryLedger);
            }
            this.observer.reportEvent(observation, event, recoveryLedger, this.infiniteRetryEnabled);
            if (event.type === 'llm.ended' && event.outcome.type === 'done') {
              options.onOutcome?.(event.outcome, source);
            }
            control.onEvent?.(event);
          },
        },
      );
      if (outcome.type === 'done') this.observer.completeRequest(observation, outcome);
      else if (outcome.type === 'failed') this.observer.failRequest(observation, outcome.error, control.signal, outcome.requestId);
      else observation.setRequestId(undefined);
      return outcome;
    } catch (error) {
      this.observer.failRequest(observation, error, control.signal);
      throw error;
    }
  }

  private recoveredMedia(request: ResolvedRequestContext): LlmRecoveryLedger | undefined {
    return request.runtime.mediaRecovery.read(request.modelAlias, request.contextRevision);
  }

  private markMediaRecovery(request: ResolvedRequestContext, ledger: LlmRecoveryLedger): void {
    request.runtime.mediaRecovery.write(request.modelAlias, request.contextRevision, ledger);
  }

  private resolveRequest(overrides: RequestOverrides): ResolvedRequestContext {
    const snapshot = overrides.config;
    const resolved = snapshot.resolved;
    const model = this.modelCatalog.get(resolved.modelAlias);
    const usedContextTokens =
      overrides.usedContextTokens ??
      (overrides.messages === undefined
        ? this.tokenCounting.get(this.scopeContext.agentContext).size
        : undefined);
    const budget = resolveCompletionBudget({
      maxOutputSize: overrides.maxOutputSize ?? resolved.maxOutputSize,
      maxCompletionTokensCap: snapshot.maxCompletionTokensCap,
    });
    const maxCompletionTokensCap = snapshot.maxCompletionTokensCap;
    const optedOut = maxCompletionTokensCap !== undefined && maxCompletionTokensCap <= 0;
    const maxOutputTokens: LlmRequestModel['maxOutputTokens'] = optedOut
      ? 'none'
      : budget === undefined
        ? undefined
        : Math.max(1, budget);
    const params: InitializedLlmRequestPart = {
      ...snapshot.params,
      model: {
        ...snapshot.params.model,
        spec: {
          ...model.spec,
          maxContextSize: resolved.model.maxContextSize,
          maxInputSize: resolved.model.maxInputSize,
        },
        maxOutputTokens,
      },
    };

    const messages = overrides.messages ?? this.contextMessages();
    const request = this.protocolRegistry.request(model, params);
    const provider = model.providerType === undefined
      ? undefined
      : getProviderDefinition(model.providerType, model.protocol);
    return {
      request: provider?.requestMetadata === true
        ? request.with({
            endpoint: { headers: requestMetadataHeaders(this.requestMetadata.resolve(overrides.source)) },
          })
        : request,
      model,
      params,
      modelAlias: resolved.modelAlias,
      thinkingEffort: resolved.thinkingLevel,
      systemPrompt: overrides.systemPrompt ?? snapshot.systemPrompt,
      tools: overrides.tools === undefined ? undefined : [...overrides.tools],
      messages: [...messages],
      usedContextTokens,
      contextRevision: overrides.runtime.historyRevision(),
      promptCacheProbe: overrides.promptCacheProbe,
      source: overrides.source,
      logFields: agentLLMRequestLogFields(overrides.source),
      dynamicTools: overrides.dynamicTools ?? false,
      runtime: overrides.runtime,
    };
  }

  private get infiniteRetryEnabled(): boolean {
    return parseBooleanEnv(this.bootstrap.getEnv(KIMI_CODE_INFINITE_RETRY_ENV)) === true;
  }
}

type PolicyList<T> = readonly T[] | (() => readonly T[]) | undefined;

function policyList<T>(value: PolicyList<T>): readonly T[] {
  return typeof value === 'function' ? value() : (value ?? []);
}

function mergePolicyLists<T>(host: PolicyList<T>, extra: PolicyList<T>): () => readonly T[] {
  return () => [...policyList(host), ...policyList(extra)];
}

function mergeCorePolicies(host: LlmPolicy, extra: LlmPolicy | undefined): LlmPolicy {
  if (extra === undefined) return host;
  return {
    retry: extra.retry === undefined ? host.retry : { ...host.retry, ...extra.retry },
    recoveries: mergePolicyLists(host.recoveries, extra.recoveries),
    resolvers: mergePolicyLists(host.resolvers, extra.resolvers),
    retryables: mergePolicyLists(host.retryables, extra.retryables),
  };
}


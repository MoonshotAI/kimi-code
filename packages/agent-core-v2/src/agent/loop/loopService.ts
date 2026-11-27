import { randomUUID } from 'node:crypto';

import { Disposable, toDisposable, type IDisposable } from '#/_base/di/lifecycle';
import { IInstantiationService } from '#/_base/di/instantiation';
import { ILogService } from '#/_base/log/log';
import { LifecycleScope } from '#/app/scopes';
import { ScopeActivation, registerScopedService } from '#/_base/di/scope';
import { defineState } from '#/state/state';
import { abortError, isUserCancellation, userCancellationReason } from '#/_base/utils/abort';
import { toErrorMessage } from '#/_base/errors/errorMessage';
import { parseBooleanEnv } from '#/_base/utils/env';
import { timeoutOutcome } from '#/_base/utils/promise';
import { AgentLoopRequestObserver } from './requestObservation';
import { registerAgentMediaPolicy, registerAgentMediaTools } from './mediaPolicy';
import type { RequestConfigSnapshot } from './requesterContract';
import { AgentLoopProjector } from './projector';
import { createStructureRecovery, createStructureResolver } from './projectionPolicy';
import { createToolSelectResolver } from './toolSelectPolicy';
import { RequestMetadataTracker, createRequestMetadataResolver } from './requestMetadata';
import { IAgentMediaResolverService } from '#/agent/media/mediaResolver';
import { ISessionTokenCountingService } from '#/session/tokenCounting/sessionTokenCounting';
import { IAgentToolSelectService } from '#/agent/toolSelect/toolSelect';

import { ISessionRequestAttributionService } from '#/session/requestAttribution/requestAttribution';
import { IBootstrapService } from '#/app/bootstrap/bootstrap';
import { credentialRecovery } from '@moonshot-ai/core/llm/policy/credentials';
import { IAgentToolExecutorService } from '#/agent/toolExecutor/toolExecutor';
import { agentTaskInfo } from '#/agent/task/handler';
import { IAgentTaskHistoryService } from '#/agent/task/taskService';
import { IAgentToolRegistryService } from '#/agent/toolRegistry/toolRegistry';
import { TaskStarted, TaskTerminated } from '#/agent/task/taskOps';
import { TERMINAL_STATUSES } from '#/agent/task/types';
import { IAgentTaskOutputService, taskNotificationId } from '#/agent/task/taskOutput';
import { restoreTaskCompletions } from '#/agent/task/completionRestore';
import { completionMessage as coreCompletionMessage, type ToolCompletionInput } from '@moonshot-ai/core/loop/tool/outcome';
import { IConfigService } from '#/app/config/config';
import { DEFAULT_MCP_STARTUP_WAIT_MS, MCP_SECTION, type McpSection } from '#/app/mcpConfig/configSection';
import {
  createUserMessage,
  type ContentPart,
  type Message,
  type SystemMessage,
  type ToolDescription as Tool,
  type UserMessage,
} from '@moonshot-ai/core/llm/message';
import { BugIndicatingError, ErrorCodes, Error2, isError2 } from '#/errors';
import { OrderedHookSlot } from '#/hooks';
import { ContextSpliced } from '#/agent/contextMemory/contextEvents';
import { newMessageId } from '#/agent/contextMemory/messageId';
import { type ContextMessage, type PromptOrigin } from '#/agent/contextMemory/types';
import { gateImageFormatParts } from '#/agent/media/image-compress';
import { daemonFileRefFromPart } from '#/agent/media/mediaRef';
import { materializePromptDaemonRefs } from '#/agent/media/promptMediaIntake';
import { ISessionMediaStore } from '#/agent/media/sessionMediaStore';
import {
  IAgentProfileService,
  type ApplyProfileOptions,
  type BindAgentInput,
  type ProfileBindingSnapshot,
  type ProfileData,
  type ProfileModelContext,
  type ProfileSetModelResult,
  type ProfileUpdateData,
  type ResolvedAgentProfile,
  type SystemPromptContext,
} from '#/agent/profile/profile';
import type {
  LlmRequest,
  LlmRequestModel,
  ThinkingEffort,
} from '@moonshot-ai/core/llm/request';
import type { ModelCapability } from '#/provider-catalog/capability';
import {
  requesterContents,
  type InitializedLlmRequester,
  type InitializedLlmRequestPart,
} from '@moonshot-ai/core/llm/requester';
import { createLlmRequesterExecution } from '@moonshot-ai/core/llm/policy/policy';
import { resolveMaxOutputTokens } from '#/provider-catalog/model/completion-budget';
import type { ModelOverrides } from '#/provider-catalog/model/model.types';
import { getProviderDefinition } from '#/provider-catalog/provider/provider-definition';
import { THINKING_SECTION } from '#/app/kosongConfig/configSection';
import { IProviderDiscoveryService } from '#/app/kosongConfig/discovery';
import { ISessionAgentProfileCatalog } from '#/session/sessionAgentProfileCatalog/sessionAgentProfileCatalog';
import { IAgentInterruptionReminderService } from '#/agent/interruptionReminder/interruptionReminder';
import { AgentSpaceImpl } from '#/agent/agentContext/agentSpace';
import { IAgentScopeContext } from '#/agent/scopeContext/scopeContext';
import { IAgentStateService } from '#/agent/state/agentState';
import { IFileService } from '#/app/file/fileService';
import { IEventService } from '#/app/event/event';
import { IPluginService } from '#/app/plugin/plugin';
import { MAIN_AGENT_ID } from '#/session/agentLifecycle/agentLifecycle';
import { ISessionRunGate } from '#/session/sessionActivity/sessionRunGate';
import { ISessionMcpHandle } from '#/session/mcp/sessionMcpHandle';
import { ISessionContext } from '#/session/sessionContext/sessionContext';
import { ISessionMetadata } from '#/session/sessionMetadata/sessionMetadata';
import { applyPromptMetadataUpdate } from '#/session/sessionMetadata/promptMetadata';
import { promptMetadataTextFromContentParts } from '#/agent/prompt/promptMetadataText';
import { ITelemetryService } from '#/app/telemetry/telemetry';
import { IEventDispatcher } from '#/state/eventDispatcher';
import { IEventBus } from '#/app/event/eventBus';
import { IWireService } from '#/wire/wire';
import { LOOP_CONTROL_SECTION, type LoopControl } from './configSection';
import {
  IAgentLoopService,
  type LoopCancelTarget,
  type LoopDetachedTask,
  type LoopErrorHandler,
  type LoopErrorHandlerRegistrationOptions,
  type LoopNotify,
  type LoopNotifyMessage,
  type LoopNotifyHandle,
  type LoopRequestContent,
  type LoopSnapshot,
  type LoopSubmitResult,
  type PromptHandle,
  type PromptLaunchResult,
  type PromptPayload,
  type PromptSubmitContext,
  type SteerResult,
  type TurnResult,
} from './loop';
import { TurnCancel, turnKey } from './turnOps';
import { EMPTY_LOOP_PROMPT, historyEntryFromContext } from './history';
import {
  createLoop,
  createMaxStepsHook,
  type Loop,
  type LoopEmitted,
  type FullLoopLlmRequester,
  type LoopHooks,
  type MessageAppendingEvent,
  type TurnStartingEvent,
} from '@moonshot-ai/core/loop/index';
import { createLoopHookRegistry } from '@moonshot-ai/core/hook/loop/registry';
import { LoopJournal, type LoopJournalSnapshot } from './journal';
import { AgentPromptProjection } from './promptProjection';
import { AgentTurnProjection, loopLastRequestIdKey } from './turnProjection';
import { AgentNotificationProjection } from './notificationProjection';
import { AgentLoopProfileAdapter } from './profileAdapter';
import { IProviderCatalogService } from '#/provider-catalog/providerCatalogService';
import { requestModelOf } from '#/provider-catalog/requester';

export type LoopInterruptReason = 'aborted' | 'max_steps' | 'error' | 'steered';

const KIMI_CODE_INFINITE_RETRY_ENV = 'KIMI_CODE_INFINITE_RETRY';
const REQUEST_CONFIG_SECTIONS: ReadonlySet<string> = new Set([
  LOOP_CONTROL_SECTION,
  THINKING_SECTION,
  'modelOverrides',
]);

export { loopLastRequestIdKey } from './turnProjection';
export const loopDisposingKey = defineState<boolean>('loop.disposing', () => false);

export class AgentLoopService extends Disposable implements IAgentLoopService {
  declare readonly _serviceBrand: undefined;

  private readonly requesterExecution = createLlmRequesterExecution();
  private readonly observer: AgentLoopRequestObserver;
  private readonly projector: AgentLoopProjector;
  private readonly requestMetadata: RequestMetadataTracker;
  readonly hooks: IAgentLoopService['hooks'] = {
    onWillBeginStep: new OrderedHookSlot(),
    onDidFinishStep: new OrderedHookSlot(),
    onBeforeSubmitPrompt: new OrderedHookSlot(),
  };

  private readonly errorHandlers: LoopErrorHandler[] = [];
  private readonly pendingSubmissions: UserMessage[] = [];
  private readonly pendingReminders: Message[] = [];
  private readonly pendingNotifications: UserMessage[] = [];
  private readonly pendingSendNowNotifications = new Set<string>();
  private readonly suppressedTaskNotifications = new Set<string>();
  private readonly settleWaiters: Array<() => void> = [];
  private quiescenceDepth = 0;
  private historySnapshotDepth = 0;
  private taskReconciliation: Promise<void> | undefined;
  private loop: Loop | undefined;
  private initialized = false;
  private startPromise: Promise<void> | undefined;
  private closePromise: Promise<void> | undefined;
  private readonly loopHooks = createLoopHookRegistry();
  private readonly journal: LoopJournal;
  private readonly prompts: AgentPromptProjection;
  private readonly turns: AgentTurnProjection;
  private readonly notifications = new AgentNotificationProjection();
  private readonly profileAdapter: AgentLoopProfileAdapter;

  constructor(
    @IAgentToolExecutorService private readonly toolExecutor: IAgentToolExecutorService,
    @IAgentToolRegistryService _toolRegistry: IAgentToolRegistryService,
    @IConfigService private readonly config: IConfigService,
    @IEventDispatcher private readonly dispatcher: IEventDispatcher,
    @IEventBus events: IEventBus,
    @IAgentScopeContext private readonly scopeContext: IAgentScopeContext,
    @ITelemetryService private readonly telemetry: ITelemetryService,
    @ISessionMetadata private readonly metadata: ISessionMetadata,
    @IEventService private readonly eventService: IEventService,
    @ISessionContext private readonly sessionContext: ISessionContext,
    @IAgentStateService private readonly states: IAgentStateService,
    @IWireService private readonly wire: IWireService,
    @IInstantiationService private readonly instantiation: IInstantiationService,
    @ISessionTokenCountingService private readonly tokenCounting: ISessionTokenCountingService,
    @IProviderCatalogService private readonly providerCatalog: IProviderCatalogService,
    @IBootstrapService private readonly bootstrap: IBootstrapService,
    @ISessionRequestAttributionService attribution: ISessionRequestAttributionService,
    @IAgentProfileService private readonly profile: IAgentProfileService,
    @ISessionAgentProfileCatalog private readonly catalog: ISessionAgentProfileCatalog,
    @IProviderDiscoveryService private readonly discovery: IProviderDiscoveryService,
    @IPluginService private readonly plugins: IPluginService,
    @ISessionRunGate private readonly runGate: ISessionRunGate,
    @ILogService private readonly logger: ILogService,
    @IAgentMediaResolverService private readonly mediaResolver: IAgentMediaResolverService,
    @IAgentTaskOutputService private readonly taskOutputs: IAgentTaskOutputService,
  ) {
    super();
    const space = this.scopeContext.agentContext.space;
    if (space instanceof AgentSpaceImpl) this._register(space._setHistoryProvider(() => this.history()));
    this.observer = instantiation.createInstance(AgentLoopRequestObserver);
    this.observer.bindLoop(() => ({
      historyRevision: this.loop?.historyRevision ?? 0,
      infiniteRetry: this.infiniteRetryEnabled,
    }));
    this.projector = new AgentLoopProjector((anomalies) => this.observer.reportProjectionRepairs(anomalies));
    this.requestMetadata = new RequestMetadataTracker(scopeContext, dispatcher, attribution);
    this._register(this.config.onDidSectionChange(({ domain }) => {
      if (REQUEST_CONFIG_SECTIONS.has(domain)) this.syncRequester();
    }));
    this._register(this.providerCatalog.onChanged(() => this.syncRequester()));
    this.journal = new LoopJournal(wire, scopeContext.agentId, dispatcher);
    this.prompts = new AgentPromptProjection(
      dispatcher,
      scopeContext.agentId,
      (includeCurrent) => this.snapshot().queue.length + (includeCurrent ? 1 : 0),
    );
    this.turns = new AgentTurnProjection({
      attribution,
      dispatcher,
      events,
      scopeContext,
      telemetry,
      plugins,
      states,
      logger,
      prompts: this.prompts,
      hooks: this.hooks,
      errorHandlers: this.errorHandlers,
      maxSteps: () => this.config.get<LoopControl>(LOOP_CONTROL_SECTION)?.maxStepsPerTurn,
      cancel: (turnId, reason) => this.cancelActiveTurn(turnId, reason),
      recordStreamPart: (turnId, step, block) => this.journal.recordStreamPart(turnId, step, block),
    });
    this.loopHooks.addLoopHook(createMaxStepsHook(
      () => this.config.get<LoopControl>(LOOP_CONTROL_SECTION)?.maxStepsPerTurn,
      (event) => this.loop?.state.turn?.bypassMaxSteps === true && event.step === 1,
    ));
    this.loopHooks.addLoopHook({
      point: 'turn.starting',
      hook: (event, signal) => this.turnStarting(event, signal),
    });
    this.loopHooks.addLoopHook({
      point: 'message.appending',
      hook: (event, signal) => this.messageAppending(event, signal),
    });
    this.loopHooks.addLoopHook({
      point: 'step.starting',
      hook: (event) => this.turns.stepStarting(event),
    });
    this.loopHooks.addLoopHook({
      point: 'step.stopping',
      hook: (event) => this.turns.stepStopping(event),
    });
    this.profileAdapter = new AgentLoopProfileAdapter(
      profile,
      dispatcher,
      scopeContext,
      discovery,
      catalog,
      telemetry,
      (value) => this.loop?.setSystemPrompt(value),
      () => this.syncRequester(),
    );
    this.states.contributeState(turnKey);
    this.states.contributeState(loopLastRequestIdKey);
    this.states.contributeState(loopDisposingKey);
    this._register(this.dispatcher.hooks.onDidRestore.register('loop.profile', async (_ctx, next) => {
      this.profileAdapter.restore(this.journal.snapshot());
      await this.profileAdapter.afterRestore();
      await next();
    }));
    this._register(this.catalog.onDidChange(() => {
      void this.profileAdapter.refreshBoundSubagentAllowlist().catch(() => {});
    }));
    this._register(this.discovery.onDidRetireModel(({ from, to }) => {
      if (this.profileAdapter.snapshot().modelAlias === from) void this.profileAdapter.setModel(to).catch(() => {});
    }));
    this._register(toDisposable(() => this.turns.close(abortError('Agent loop disposed'))));
  }

  get requester(): FullLoopLlmRequester {
    const loop = this.loop;
    if (loop === undefined) throw new BugIndicatingError('Agent loop is not started');
    return loop.requester;
  }

  private get disposing(): boolean {
    return this.states.get(loopDisposingKey);
  }

  private set disposing(value: boolean) {
    this.states.set(loopDisposingKey, value);
  }

  get started(): boolean {
    return this.loop !== undefined || this.startPromise !== undefined;
  }

  get hasPersistedState(): boolean {
    const snapshot = this.journal.snapshot();
    const inbox = snapshot.input.inbox;
    return (
      snapshot.profileBound ||
      (snapshot.input.messages?.length ?? 0) > 0 ||
      (inbox?.normal?.length ?? 0) > 0 ||
      (inbox?.notify?.length ?? 0) > 0 ||
      (inbox?.remind?.length ?? 0) > 0 ||
      (snapshot.input.nextTurnId ?? 0) > 0 ||
      snapshot.input.unfinished !== undefined
    );
  }

  async start(tools?: readonly Tool[]): Promise<void> {
    if (this.loop !== undefined) return;
    this.startPromise ??= this.initializeLoop(undefined, tools).finally(() => {
      this.startPromise = undefined;
    });
    return this.startPromise;
  }

  baselineTools(): readonly Tool[] {
    const live = this.loop?.state.profile.tools;
    if (live !== undefined) return live;
    const restored = this.journal.snapshot().input.profile?.tools;
    return restored === undefined ? this.toolSelect.initialTools() : restored;
  }

  private get toolSelect(): IAgentToolSelectService {
    return this.instantiation.invokeFunction((accessor) => accessor.get(IAgentToolSelectService));
  }

  data(): ProfileData {
    return this.profileAdapter.data();
  }

  getSystemPrompt(): string {
    return this.profileAdapter.getSystemPrompt();
  }

  getAgentsMdWarning(): string | undefined {
    return this.profileAdapter.getAgentsMdWarning();
  }

  getModel(): string {
    return this.profileAdapter.getModel();
  }

  getEffectiveThinkingLevel(): ThinkingEffort {
    return this.profileAdapter.getEffectiveThinkingLevel();
  }

  resolveModelContext(): ProfileModelContext {
    return this.profileAdapter.resolveModelContext();
  }

  resolveRequestParams(): InitializedLlmRequestPart {
    return this.profileAdapter.resolveRequestParams();
  }

  getModelCapabilities(): ModelCapability {
    return this.profileAdapter.getModelCapabilities();
  }

  getModelProviderType(alias?: string): string | undefined {
    return this.profileAdapter.getModelProviderType(alias);
  }

  getMaxOutputSize(): number | undefined {
    return this.profileAdapter.getMaxOutputSize();
  }

  resolveMaxOutputTokens(maxOutputSize?: number): LlmRequestModel['maxOutputTokens'] {
    return resolveMaxOutputTokens({
      maxOutputSize: maxOutputSize ?? this.getMaxOutputSize(),
      maxCompletionTokensCap: this.config.get<ModelOverrides>('modelOverrides')?.maxCompletionTokens,
    });
  }

  requestConfigSnapshot(profile = this.profileAdapter.snapshot()): RequestConfigSnapshot {
    return {
      resolved: this.profile.resolveModelContext(profile),
      params: this.profile.resolveRequestParams(profile),
      systemPrompt: this.profile.getSystemPrompt(profile),
      maxCompletionTokensCap: this.config.get<ModelOverrides>('modelOverrides')?.maxCompletionTokens,
    };
  }

  private bindRequester(config: RequestConfigSnapshot): InitializedLlmRequester {
    const resolved = config.resolved;
    const model = this.providerCatalog.get(resolved.modelAlias);
    const maxOutputTokens = this.resolveMaxOutputTokens(resolved.maxOutputSize);
    const spec = {
      ...model.spec,
      maxContextSize: resolved.model.maxContextSize,
      maxInputSize: resolved.model.maxInputSize,
    };
    const params: InitializedLlmRequestPart = {
      ...config.params,
      model: {
        ...config.params.model,
        spec,
        ...(maxOutputTokens === undefined ? {} : { maxOutputTokens }),
      },
    };
    return this.providerCatalog.createRequester(
      model,
      params,
      this.requesterExecution,
    ).with({
      profile: { systemPrompt: config.systemPrompt },
      attributes: { modelAlias: resolved.modelAlias, providerType: model.providerType },
      policy: {
        retry: {
          maxAttemptsPerStep: this.config.get<LoopControl>(LOOP_CONTROL_SECTION)?.maxAttemptsPerStep,
          infiniteRetry: this.infiniteRetryEnabled,
        },
      },
    });
  }

  private wantsRequestMetadata(request: LlmRequest): boolean {
    const providerType = request.attributes?.providerType;
    if (providerType === undefined) return false;
    return getProviderDefinition(providerType, requestModelOf(request).protocol)?.requestMetadata === true;
  }

  private syncRequester(): void {
    const loop = this.loop;
    if (loop === undefined) return;
    try {
      const config = this.requestConfigSnapshot();
      const requester = this.bindRequester(config);
      this.turns.thinkingEffort = config.resolved.thinkingLevel;
      loop.setRequester(requester as FullLoopLlmRequester);
    } catch (error) {
      const requester: FullLoopLlmRequester = {
        [requesterContents]: {},
        with: (() => requester) as FullLoopLlmRequester['with'],
        request: () => {
          throw error;
        },
        generate: async () => {
          throw error;
        },
      };
      loop.setRequester(requester);
    }
  }

  hasModel(): boolean {
    return this.profileAdapter.hasModel();
  }

  isRunnable(): boolean {
    return this.profileAdapter.isRunnable();
  }

  hasProvider(): boolean {
    return this.profileAdapter.hasProvider();
  }

  getActiveToolNames(): readonly string[] | undefined {
    return this.profileAdapter.getActiveToolNames();
  }

  bindingSnapshot(): ProfileBindingSnapshot {
    return this.profileAdapter.snapshot();
  }

  setProfile(profile: ProfileBindingSnapshot): Promise<void> {
    return this.profileAdapter.setProfile(profile);
  }

  bindProfile(input: BindAgentInput): Promise<void> {
    return this.profileAdapter.bindProfile(input);
  }

  applyBindingSnapshot(profile: ProfileBindingSnapshot): Promise<void> {
    return this.profileAdapter.applyBindingSnapshot(profile);
  }

  useProfile(profile: ResolvedAgentProfile, context: SystemPromptContext): void {
    this.profileAdapter.useProfile(profile, context);
  }

  applyProfile(profile: ResolvedAgentProfile, options?: ApplyProfileOptions): Promise<void> {
    return this.profileAdapter.applyProfile(profile, options);
  }

  update(changed: ProfileUpdateData): void {
    this.profileAdapter.update(changed);
  }

  setModel(alias: string): Promise<ProfileSetModelResult> {
    return this.profileAdapter.setModel(alias);
  }

  setThinking(level: string): void {
    this.profileAdapter.setThinking(level);
  }

  republishStatus(): void {
    this.profileAdapter.republishStatus();
  }

  addActiveTool(name: string): void {
    this.profileAdapter.addActiveTool(name);
  }

  removeActiveTool(name: string): void {
    this.profileAdapter.removeActiveTool(name);
  }

  history(): readonly ContextMessage[] {
    return this.turns.history(this.rawHistory());
  }

  rawHistory(): readonly Message[] {
    return this.loop?.state.messages ?? this.journal.snapshot().input.messages ?? [];
  }

  previewRequestContent(): LoopRequestContent {
    return {
      systemPrompt: this.loop?.state.profile.systemPrompt || this.getSystemPrompt(),
      tools: this.baselineTools(),
      messages: this.rawHistory(),
    };
  }

  historyRevision(): number {
    return this.loop?.historyRevision ?? 0;
  }

  replaceHistory(messages: readonly Message[], reason?: string, onAccepted?: () => void): boolean {
    const previous = this.history();
    const ack = this.loop?.setContext([...messages], reason);
    if (ack?.type !== 'context.settled') return false;
    onAccepted?.();
    void this.dispatcher.dispatch(new ContextSpliced({
      agentId: this.scopeContext.agentId,
      start: 0,
      deleteCount: previous.length,
      messages: this.history(),
    }));
    return true;
  }

  private async initializeLoop(
    seededMessages?: readonly Message[],
    initialTools?: readonly Tool[],
  ): Promise<void> {
    if (this.initialized) return;
    let lease = this.runGate.tryAcquire();
    try {
      await this.wire.drainPersisted().catch(() => undefined);
      const snapshot = this.journal.snapshot();
      this.profileAdapter.restore(snapshot);
      const waitMs =
        this.config.get<McpSection | undefined>(MCP_SECTION)?.startupWaitMs ?? DEFAULT_MCP_STARTUP_WAIT_MS;
      if (waitMs > 0) {
        const ready = this.instantiation.invokeFunction((accessor) => accessor.get(ISessionMcpHandle).ready);
        const deadline = timeoutOutcome(waitMs, undefined);
        try {
          await Promise.race([ready, deadline]);
        } finally {
          deadline.clear();
        }
      }
      let tools: readonly Tool[];
      const restoredTools = snapshot.input.profile?.tools;
      if (initialTools !== undefined) {
        tools = [...initialTools];
      } else if (restoredTools !== undefined) {
        tools = [...restoredTools];
      } else {
        // Non-negotiable product decision: a new loop freezes its top-level tool baseline once,
        // after waiting at most startup_wait_ms for initial MCP discovery. Tools of servers that
        // are still connecting at the deadline stay out of the baseline (without cancelling the
        // connection); they are only announced later and are never appended to top-level tools.
        tools = this.toolSelect.initialTools();
      }
      const taskHistory = this.instantiation.invokeFunction((accessor) => accessor.get(IAgentTaskHistoryService));
      await taskHistory.reconcile();
      const completions = await restoreTaskCompletions({
        wire: this.wire,
        agentId: this.scopeContext.agentId,
        taskOutputs: this.taskOutputs,
        messages: seededMessages ?? snapshot.input.messages ?? [],
        pending: [
          ...(snapshot.input.inbox?.notify ?? []),
          ...(snapshot.input.inbox?.remind ?? []),
        ],
        isLive: (taskId) => this.toolExecutor.handler(taskId)?.snapshot().status === 'running',
      });
      const pendingWork = (snapshot.input.inbox?.normal?.length ?? 0) + (snapshot.input.inbox?.notify?.length ?? 0);
      if (lease === undefined && (completions.length > 0 || pendingWork > 0)) lease = this.runGate.acquire();
      this.createLoopFromSnapshot(snapshot, tools, completions, seededMessages);
      if (initialTools !== undefined) this.journal.settleTools(tools);
      await this.taskReconciliation;
    } finally {
      lease?.release();
    }
  }

  private createLoopFromSnapshot(
    snapshot: LoopJournalSnapshot,
    tools: readonly Tool[],
    completions: readonly UserMessage[],
    seededMessages?: readonly Message[],
    minimumNextTurnId = 0,
    historyRevision?: number,
  ): void {
    this.initialized = true;
    const loop = createLoop({
      llmObserver: this.observer,
      shouldQueueTaskNotification: (taskId) => !this.suppressedTaskNotifications.has(taskId),
      completionMessage: (input: ToolCompletionInput) => {
        const handler = this.toolExecutor.handlerForCall(input.toolCall.id);
        if (handler?.snapshot().fields.task === undefined) {
          return coreCompletionMessage(input.toolCall, input.outcome, input.result);
        }
        return this.taskOutputs.createCompletion(agentTaskInfo(handler), input.toolCall.id);
      },
      executor: this.toolExecutor.executor,
      toolContext: () => {
        const context = {
          steerSignal: this.turns.steerSignal,
          requestId: this.turns.requestTrace?.requestId,
          trace: this.turns.requestTrace,
          remind: (message: SystemMessage | UserMessage) => this.remind(historyEntryFromContext(message)),
        };
        return context;
      },
      input: {
        ...snapshot.input,
        profile: {
          ...snapshot.input.profile,
          systemPrompt: this.getSystemPrompt(),
          tools,
        },
        messages: seededMessages === undefined ? snapshot.input.messages : [...seededMessages],
        nextTurnId: Math.max(snapshot.input.nextTurnId ?? 0, minimumNextTurnId),
        historyRevision,
      },
      hook: this.loopHooks.hook,
    });
    this.loop = loop;
    loop.policy.addRecovery(credentialRecovery);
    loop.policy.addRecovery(createStructureRecovery(this.projector));
    loop.policy.addResolver(createToolSelectResolver(this.toolSelect));
    registerAgentMediaTools(loop.policy);
    loop.policy.addResolver(createStructureResolver(this.projector));
    registerAgentMediaPolicy(loop.policy, this.mediaResolver);
    loop.policy.addResolver(createRequestMetadataResolver(
      this.requestMetadata,
      (request) => this.wantsRequestMetadata(request),
    ));
    this.syncRequester();
    loop.subscribe((event) => {
      const enriched = this.turns.enrich(event, this.toolExecutor);
      this.notifications.project(event);
      if (event.type === 'llm.retry') this.journal.append(enriched);
      this.turns.project(enriched, loop);
      this.projectTaskEvent(enriched);
      if (event.type !== 'llm.retry') this.journal.append(enriched);
      if ((event.type === 'tool.async_ended' || (event.type === 'tool.ended' && !event.detached)) && event.taskId !== undefined) {
        this.toolExecutor.release(event.taskId);
      }
      this.maybeSettle();
    });
    for (const completion of completions) loop.recordNotification(completion);
    this.drainPendingToLoop();
    this.maybeSettle();
  }

  private scheduleTaskReconciliation(seededMessages?: readonly Message[]): void {
    const previous = this.taskReconciliation?.catch(() => undefined) ?? Promise.resolve();
    const current = previous.then(() => this.reconcileTasks(seededMessages));
    this.taskReconciliation = current;
    void current.catch((error) => {
      this.logger.error('background task reconciliation failed', { error });
    });
  }

  private async reconcileTasks(seededMessages?: readonly Message[]): Promise<void> {
    const loop = this.loop;
    if (loop === undefined) return;
    let completions: readonly UserMessage[] = [];
    for (let attempt = 0; ; attempt += 1) {
      try {
        const snapshot = this.journal.snapshot();
        this.profileAdapter.restore(snapshot);
        const taskHistory = this.instantiation.invokeFunction((accessor) => accessor.get(IAgentTaskHistoryService));
        await taskHistory.reconcile();
        completions = await restoreTaskCompletions({
          wire: this.wire,
          agentId: this.scopeContext.agentId,
          taskOutputs: this.taskOutputs,
          messages: seededMessages ?? snapshot.input.messages ?? [],
          pending: [
            ...(snapshot.input.inbox?.notify ?? []),
            ...(snapshot.input.inbox?.remind ?? []),
            ...loop.state.inbox.notify,
            ...loop.state.inbox.remind,
            ...this.pendingNotifications,
            ...this.pendingReminders,
          ],
          isLive: (taskId) => this.toolExecutor.handler(taskId)?.snapshot().status === 'running',
        });
        break;
      } catch (error) {
        if (!isError2(error) || error.code !== ErrorCodes.RECORDS_WRITE_FAILED || attempt >= 2) throw error;
        await this.wire.settled();
      }
    }
    for (const completion of completions) loop.recordNotification(completion);
    this.drainPendingToLoop();
    this.maybeSettle();
  }

  private get infiniteRetryEnabled(): boolean {
    return parseBooleanEnv(this.bootstrap.getEnv(KIMI_CODE_INFINITE_RETRY_ENV)) === true;
  }

  private projectTaskEvent(event: LoopEmitted): void {
    if (event.type === 'tool.ended' && event.detached && event.taskId !== undefined) {
      const handler = this.toolExecutor.handler(event.taskId);
      if (handler?.snapshot().fields.task !== undefined) {
        const info = agentTaskInfo(handler);
        void this.dispatcher.dispatch(new TaskStarted({
          agentId: this.scopeContext.agentId,
          info: { ...info, status: 'running', endedAt: null },
        }));
      }
      return;
    }
    if (event.type !== 'tool.async_ended' || event.taskId === undefined) return;
    const handler = this.toolExecutor.handler(event.taskId);
    if (handler?.snapshot().fields.task === undefined) return;
    const current = agentTaskInfo(handler);
    const info = event.outcome.type === 'aborted'
      ? { ...current, status: 'killed' as const }
      : event.outcome.type === 'failed' && current.status !== 'timed_out'
        ? { ...current, status: 'failed' as const }
        : current;
    void this.dispatcher.dispatch(new TaskTerminated({ agentId: this.scopeContext.agentId, info }));
    if (this.suppressedTaskNotifications.delete(info.taskId)) this.dropTaskNotification(info.taskId);
  }

  private dropTaskNotification(taskId: string): void {
    for (const status of TERMINAL_STATUSES) this.dropNotification(taskNotificationId(taskId, status));
  }

  async initializeHistory(messages: readonly Message[]): Promise<void> {
    if (this.history().length > 0 || this.hasPendingRequests()) {
      throw new BugIndicatingError('Loop history initialization requires an empty quiescent loop');
    }
    await this.resetLoop(messages);
    if (!this.replaceHistory(messages, 'fork')) {
      throw new BugIndicatingError('Loop history initialization was rejected');
    }
  }

  async resetLoop(seededMessages?: readonly Message[]): Promise<void> {
    if (this.disposing) return;
    const loop = this.loop;
    if (loop === undefined) {
      this.initialized = false;
      this.startPromise ??= this.initializeLoop(seededMessages).finally(() => {
        this.startPromise = undefined;
      });
      await this.startPromise;
      this.requesterExecution.recoveries.clear();
      return;
    }
    if (loop.state.turn !== undefined || loop.state.resetting) {
      throw new BugIndicatingError('Loop reset requires a quiescent loop');
    }
    const minimumNextTurnId = loop.state.nextTurnId;
    const historyRevision = loop.historyRevision + 1;
    const baselineTools = loop.state.profile.tools ?? [];
    await this.taskReconciliation;
    const lease = this.runGate.acquire();
    try {
      await loop.reset(async () => {
        this.drainPendingToLoop();
        await this.wire.drainPersisted().catch(() => undefined);
        const snapshot = this.journal.snapshot();
        this.profileAdapter.restore(snapshot);
        return {
          ...snapshot.input,
          profile: { systemPrompt: this.getSystemPrompt(), tools: baselineTools },
          messages: seededMessages === undefined ? snapshot.input.messages : [...seededMessages],
          nextTurnId: Math.max(snapshot.input.nextTurnId ?? 0, minimumNextTurnId),
          historyRevision,
        };
      });
      this.requesterExecution.recoveries.clear();
      this.syncRequester();
      this.turns.invalidateHistory();
      this.scheduleTaskReconciliation(seededMessages);
      this.maybeSettle();
      await this.taskReconciliation;
    } finally {
      lease.release();
    }
  }

  close(): Promise<void> {
    if (this.closePromise !== undefined) return this.closePromise;
    this.disposing = true;
    const reason = abortError('Agent loop disposed');
    this.prompts.close();
    this.notifications.close();
    this.pendingSubmissions.length = 0;
    this.pendingNotifications.length = 0;
    this.turns.close(reason);
    this.closePromise = (async () => {
      try {
        await this.taskReconciliation;
      } finally {
        this.loop?.flushReminders();
        await this.loop?.close();
        await this.turns.drain();
        await this.journal.settled();
        await this.wire.drainPersisted();
        await this.wire.flush();
        this.maybeSettle();
      }
    })();
    return this.closePromise;
  }

  override dispose(): void {
    void this.close();
    super.dispose();
  }

  submit(payload: PromptPayload): Promise<PromptLaunchResult | undefined>;
  submit(input: UserMessage): LoopSubmitResult;
  submit(input: UserMessage | PromptPayload): LoopSubmitResult | Promise<PromptLaunchResult | undefined> {
    if ('input' in input) return this.submitClient(input);
    const { id, entry } = this.admit(input);
    if (this.loop !== undefined && this.quiescenceDepth === 0) this.loop.submit(entry);
    else this.pendingSubmissions.push(entry);
    this.maybeSettle();
    return { id };
  }

  private async submitClient(payload: PromptPayload): Promise<PromptLaunchResult | undefined> {
    const text = promptMetadataTextFromContentParts(payload.input);
    const rejectIfBusy = payload.rejectIfBusy === true;
    if (!rejectIfBusy) await this.updatePromptMetadata(text);
    const status = this.snapshot();
    const wouldQueue = status.state === 'running' || status.paused || status.queue.length > 0;
    if (rejectIfBusy && wouldQueue) {
      throw new Error2(ErrorCodes.TURN_AGENT_BUSY, 'another turn is already in progress');
    }
    const { id } = this.submit({
      role: 'user',
      content: [...payload.input],
      attributes: { promptId: payload.promptId, origin: { kind: 'user' } },
    });
    if (rejectIfBusy) {
      await this.updatePromptMetadata(text).catch((error: unknown) => {
        this.logger.warn('failed to update metadata for an accepted prompt', { error });
      });
    }
    if (wouldQueue) return undefined;
    return this.launchResult(id);
  }

  async notifyClient(input: LoopNotifyMessage): Promise<SteerResult> {
    this.telemetry.track2('input_steer', { parts: input.content.length });
    await this.updatePromptMetadata(promptMetadataTextFromContentParts(input.content));
    const status = this.snapshot();
    const steerable = status.state === 'running';
    const queued = status.state === 'running' || status.paused || status.queue.length > 0;
    const { id } = steerable ? this.sendNow(input) : this.submit(input);
    const handle = this.promptHandle(id)!;
    if (!steerable && queued) {
      return { prompt_id: id, created_at: handle.createdAt, state: 'queued', steered: false };
    }
    await Promise.race([handle.launched, handle.completion]);
    const turn = await handle.launched;
    if (turn === undefined) {
      if (handle.state === 'blocked') {
        return { prompt_id: id, created_at: handle.createdAt, state: 'blocked', steered: false };
      }
      throw new Error2(ErrorCodes.INTERNAL, 'Steer failed to launch a turn');
    }
    await turn.ready.catch(() => undefined);
    return {
      turn_id: turn.id,
      prompt_id: id,
      created_at: handle.createdAt,
      state: 'running',
      steered: steerable,
    };
  }

  private async updatePromptMetadata(text: string | undefined): Promise<void> {
    if (this.scopeContext.agentId !== MAIN_AGENT_ID) return;
    await applyPromptMetadataUpdate({
      metadata: this.metadata,
      eventService: this.eventService,
      sessionId: this.sessionContext.sessionId,
    }, text);
  }

  private async launchResult(id: string): Promise<PromptLaunchResult | undefined> {
    const turn = await this.promptHandle(id)?.launched;
    if (turn === undefined) return undefined;
    await turn.ready.catch(() => undefined);
    return turn.id === undefined ? undefined : { turn_id: turn.id };
  }

  private admit(input: UserMessage): { readonly id: string; readonly entry: UserMessage } {
    if (this.disposing) throw abortError('Agent loop disposed');
    if (this.dispatcher.restorePhase === 'ready') {
      void this.start().catch(() => this.close().catch(() => undefined));
    }
    this.runGate.begin();
    const snapshot = this.snapshot();
    return this.prompts.admit(input, snapshot.state === 'running' || snapshot.paused || snapshot.queue.length > 0);
  }

  async steer(promptIds: readonly string[]): Promise<void> {
    if (this.disposing) throw abortError('Agent loop disposed');
    if (promptIds.length === 0) throw new Error2(ErrorCodes.REQUEST_INVALID, 'prompt_ids must not be empty');
    const loop = this.loop;
    if (loop?.state.turn === undefined) throw new Error2(ErrorCodes.PROMPT_NOT_FOUND, 'no active prompt to steer into');
    const activeTurnId = loop.state.turn.id;
    const queued = new Map(loop.state.inbox.normal.map((entry) => [entry.attributes?.promptId, entry] as const));
    const ids = new Set(promptIds);
    if (ids.size !== promptIds.length || ![...ids].every((id) => queued.has(id))) {
      throw new Error2(ErrorCodes.PROMPT_NOT_FOUND, 'one or more prompts are not pending');
    }
    for (const id of ids) {
      const entry = queued.get(id);
      if (entry !== undefined) await this.materializeDaemonRefs(entry);
    }
    const pending = new Set(loop.state.inbox.normal.map((entry) => entry.attributes?.promptId));
    if (loop.state.turn?.id !== activeTurnId || ![...ids].every((id) => pending.has(id))) {
      throw new Error2(ErrorCodes.PROMPT_NOT_FOUND, 'one or more prompts are no longer pending');
    }
    loop.steer(promptIds);
  }

  promptHandle(id: string): PromptHandle | undefined {
    return this.prompts.handle(id);
  }

  notify(input: LoopNotifyMessage): LoopSubmitResult;
  notify(note?: LoopNotify): LoopNotifyHandle;
  notify(note: LoopNotify | LoopNotifyMessage = {}): LoopSubmitResult | LoopNotifyHandle {
    if ('role' in note) {
      const { id, entry } = this.admit(note);
      this.sendNotification(entry);
      this.maybeSettle();
      return { id };
    }
    if (this.disposing) throw abortError('Agent loop disposed');
    const id = note.message?.id ?? newMessageId();
    const entry = createUserMessage(machineUserMessage(note.message).content, {
      promptId: id,
      origin: note.message?.origin,
      bypassMaxSteps: note.bypassMaxSteps === true,
    });
    const admitted = this.admit(entry);
    this.notifications.register(id, note);
    this.sendNotification(admitted.entry);
    this.maybeSettle();
    const notifications = this.notifications;
    return {
      get dropped() {
        return notifications.isDropped(id);
      },
      drop: () => this.dropNotification(id),
    };
  }

  sendNow(input: LoopNotifyMessage): LoopSubmitResult;
  sendNow(promptIds: readonly string[]): Promise<void>;
  sendNow(input: LoopNotifyMessage | readonly string[]): LoopSubmitResult | Promise<void> {
    if (Array.isArray(input)) return this.sendNowEntries(input);
    const entry = input as LoopNotifyMessage;
    const { id, entry: admitted } = this.admit(entry);
    this.sendNotification(admitted, true);
    this.maybeSettle();
    return { id };
  }

  private async sendNowEntries(promptIds: readonly string[]): Promise<void> {
    if (this.disposing) throw abortError('Agent loop disposed');
    if (promptIds.length === 0) throw new Error2(ErrorCodes.REQUEST_INVALID, 'prompt_ids must not be empty');
    const loop = this.loop;
    if (loop?.state.turn === undefined) throw new Error2(ErrorCodes.PROMPT_NOT_FOUND, 'no active prompt to send now');
    const activeTurnId = loop.state.turn.id;
    const normal = new Map(loop.state.inbox.normal.map((entry) => [entry.attributes?.promptId, entry] as const));
    const notify = new Set(loop.state.inbox.notify.map((entry) => entry.attributes?.promptId));
    const ids = new Set(promptIds);
    if (ids.size !== promptIds.length || ![...ids].every((id) => normal.has(id) || notify.has(id))) {
      throw new Error2(ErrorCodes.PROMPT_NOT_FOUND, 'one or more prompts are not pending');
    }
    for (const id of ids) {
      const entry = normal.get(id);
      if (entry !== undefined) await this.materializeDaemonRefs(entry);
    }
    const pendingNormal = new Set(loop.state.inbox.normal.map((entry) => entry.attributes?.promptId));
    const pendingNotify = new Set(loop.state.inbox.notify.map((entry) => entry.attributes?.promptId));
    if (loop.state.turn?.id !== activeTurnId || ![...ids].every((id) => pendingNormal.has(id) || pendingNotify.has(id))) {
      throw new Error2(ErrorCodes.PROMPT_NOT_FOUND, 'one or more prompts are no longer pending');
    }
    loop.sendNowQueued(promptIds);
  }

  remind(...messages: readonly Message[]): void {
    if (this.disposing) throw abortError('Agent loop disposed');
    if (this.loop !== undefined && this.quiescenceDepth === 0) this.loop.remind(...messages);
    else this.pendingReminders.push(...messages);
  }

  flushReminders(): void {
    const loop = this.loop;
    if (loop === undefined) return;
    if (this.pendingReminders.length > 0) loop.remind(...this.pendingReminders.splice(0));
    loop.flushReminders();
  }

  private sendNotification(entry: UserMessage, sendNow = false): void {
    if (this.loop !== undefined && this.quiescenceDepth === 0) {
      if (sendNow) this.loop.sendNow(entry);
      else this.loop.notify(entry);
      return;
    }
    this.pendingNotifications.push(entry);
    const id = entry.attributes?.promptId;
    if (sendNow && id !== undefined) this.pendingSendNowNotifications.add(id);
  }

  private dropNotification(id: string): void {
    if (this.notifications.isMaterialized(id) || this.notifications.isDropped(id)) return;
    for (let index = this.pendingNotifications.length - 1; index >= 0; index -= 1) {
      if (this.pendingNotifications[index]!.attributes?.promptId === id) this.pendingNotifications.splice(index, 1);
    }
    this.pendingSendNowNotifications.delete(id);
    this.loop?.cancel(id);
    this.notifications.drop(id);
    this.maybeSettle();
  }

  snapshot(): LoopSnapshot {
    const loop = this.loop;
    const machineQueue = loop?.state.inbox.normal ?? [];
    const inFlight = this.prompts.pendingEntries().filter(
      (entry) => !machineQueue.some((item) => item.attributes?.promptId === entry.attributes?.promptId),
    );
    const parked = this.pendingSubmissions.filter(
      (entry) => !machineQueue.some((item) => item.attributes?.promptId === entry.attributes?.promptId),
    );
    const queue = [...machineQueue, ...inFlight, ...parked];
    const notificationCount =
      (loop === undefined ? 0 : loop.state.inbox.notify.length + loop.state.inbox.remind.length) +
      this.pendingNotifications.length;
    return this.turns.snapshot(loop, queue, notificationCount, this.quiescenceDepth > 0, this.hasPendingRequests());
  }

  private async materializeDaemonRefs(
    message: { readonly content: readonly ContentPart[] },
    signal?: AbortSignal,
  ): Promise<void> {
    if (!message.content.some((part) => daemonFileRefFromPart(part) !== undefined)) return;
    const files = this.instantiation.invokeFunction((accessor) => accessor.get(IFileService));
    const mediaStore = this.instantiation.invokeFunction((accessor) => accessor.get(ISessionMediaStore));
    await materializePromptDaemonRefs(message.content, { files, mediaStore, signal });
  }

  private async turnStarting(event: TurnStartingEvent, signal: AbortSignal) {
    const pending = this.prompts.prepareTurn(event);
    if (pending === undefined) return undefined;
    const promptMessage: ContextMessage = {
      role: 'user',
      content: [...pending.entry.content],
      id: pending.entry.attributes?.promptId,
      origin: pending.entry.attributes?.origin as PromptOrigin | undefined,
    };
    const ctx: PromptSubmitContext = { promptMessage, isSteer: false, hookParts: [], block: false };
    try {
      await this.hooks.onBeforeSubmitPrompt.run(ctx);
      if (ctx.block) return { type: 'blocked' as const, cause: { by: 'prompt', reason: 'blocked' } };
      await this.materializeDaemonRefs(promptMessage, signal);
      pending.message = {
        ...pending.entry,
        content: [
          ...ctx.hookParts,
          ...gateImageFormatParts(promptMessage.content, this.getModelProviderType()),
        ],
      };
      return undefined;
    } catch (error) {
      if (signal.aborted) return { type: 'blocked' as const, cause: { by: 'prompt', reason: 'aborted', message: toErrorMessage(error) } };
      return { type: 'blocked' as const, cause: { by: 'prompt', reason: 'gate_failed', message: toErrorMessage(error) } };
    }
  }

  private async messageAppending(event: MessageAppendingEvent, signal: AbortSignal) {
    if (event.item.kind === 'normal') {
      const pending = this.prompts.pending(event.turnId);
      if (pending !== undefined) return { message: { ...event.item.message, content: pending.message.content } };
      return undefined;
    }
    if (event.item.kind === 'notify') {
      await this.materializeDaemonRefs(event.item.message, signal);
      return {
        message: {
          ...event.item.message,
          content: gateImageFormatParts(event.item.message.content, this.getModelProviderType()),
        },
      };
    }
    return undefined;
  }

  cancel(target?: LoopCancelTarget, reason?: unknown): boolean {
    const cancellation = reason ?? userCancellationReason();
    if (target?.promptId !== undefined) {
      if (this.prompts.activePrompt()?.id === target.promptId) return this.cancelActiveTurn(undefined, cancellation);
      const handle = this.promptHandle(target.promptId);
      if (
        handle === undefined ||
        handle.state === 'completed' ||
        handle.state === 'failed' ||
        handle.state === 'cancelled' ||
        handle.state === 'blocked'
      ) {
        throw new Error2(ErrorCodes.PROMPT_NOT_FOUND, `prompt ${target.promptId} not found`);
      }
      for (let index = this.pendingSubmissions.length - 1; index >= 0; index -= 1) {
        if (this.pendingSubmissions[index]!.attributes?.promptId === target.promptId) this.pendingSubmissions.splice(index, 1);
      }
      this.loop?.cancel(target.promptId, { includeStarting: true });
      this.prompts.cancel(target.promptId);
      return true;
    }
    return this.cancelActiveTurn(target?.turnId, cancellation);
  }

  detachTool(task: LoopDetachedTask, text?: string): void {
    if (this.disposing) return;
    const completion: LoopDetachedTask['completion'] = (input) => task.completion(input);
    completion.onRejected = async (error) => {
      const current = task.info();
      const info = TERMINAL_STATUSES.has(current.status) ? current : {
        ...current,
        status: 'failed' as const,
        endedAt: Date.now(),
        stopReason: toErrorMessage(error),
      };
      return this.taskOutputs.createCompletion(info, task.toolCallId);
    };
    this.loop?.detachTool(task.toolCallId, text ?? `background task_id=${task.taskId}`, completion);
  }

  abortTool(toolCallId: string, reason?: unknown): void {
    if (this.disposing) return;
    this.loop?.abortTool(toolCallId, reason);
  }

  suppressTaskNotifications(taskIds: readonly string[]): void {
    for (const taskId of taskIds) {
      this.suppressedTaskNotifications.add(taskId);
      this.dropTaskNotification(taskId);
    }
  }

  registerToolBatchStarting(hook: LoopHooks['tool.batch-starting']): IDisposable {
    const id = randomUUID();
    this.loopHooks.addLoopHook({ point: 'tool.batch-starting', hook, id });
    return toDisposable(() => {
      this.loopHooks.remove(id);
    });
  }

  tryAcquireQuiescence(): IDisposable | undefined {
    if (this.disposing) throw abortError('Agent loop disposed');
    if (this.quiescenceDepth > 0 || this.historySnapshotDepth > 0 || this.hasPendingRequests()) return undefined;
    this.quiescenceDepth += 1;
    return toDisposable(() => this.releaseQuiescence());
  }

  tryAcquireHistorySnapshot(): IDisposable | undefined {
    if (this.disposing) throw abortError('Agent loop disposed');
    if (this.quiescenceDepth > 0 || this.historySnapshotDepth > 0) return undefined;
    this.historySnapshotDepth += 1;
    return toDisposable(() => {
      this.historySnapshotDepth -= 1;
    });
  }

  private releaseQuiescence(): void {
    if (this.quiescenceDepth === 0) return;
    this.quiescenceDepth -= 1;
    if (this.quiescenceDepth > 0 || this.disposing) return;
    this.drainPendingToLoop();
    this.maybeSettle();
  }

  private drainPendingToLoop(): void {
    const loop = this.loop;
    if (loop === undefined) return;
    const normal = new Set(loop.state.inbox.normal.map((item) => item.attributes?.promptId));
    for (const entry of this.pendingSubmissions.splice(0)) {
      const id = entry.attributes?.promptId;
      if (id === undefined || normal.has(id)) continue;
      loop.submit(entry);
    }
    const notify = new Set(loop.state.inbox.notify.map((item) => item.attributes?.promptId));
    for (const entry of this.pendingNotifications.splice(0)) {
      const id = entry.attributes?.promptId;
      const sendNow = id !== undefined && this.pendingSendNowNotifications.delete(id);
      if (id === undefined || notify.has(id)) continue;
      if (sendNow) loop.sendNow(entry);
      else loop.notify(entry);
    }
    if (this.quiescenceDepth > 0) return;
    if (this.pendingReminders.length > 0) loop.remind(...this.pendingReminders.splice(0));
    if (loop.state.status === 'interrupted') loop.resume();
    if (loop.state.inbox.normal.length > 0 || loop.state.inbox.notify.length > 0) loop.start();
  }

  private cancelActiveTurn(turnId: number | undefined, cancellation: unknown): boolean {
    const loop = this.loop;
    const activeTurnId = loop?.state.turn?.id;
    if (loop === undefined || activeTurnId === undefined || (turnId !== undefined && activeTurnId !== turnId)) return false;
    const ending = this.snapshot().turn?.ending === true;
    if (!ending) {
      void this.dispatcher.dispatch(new TurnCancel({
        agentId: this.scopeContext.agentId,
        turnId: activeTurnId,
        target: 'active',
        reason: isUserCancellation(cancellation) ? 'user_cancelled' : 'aborted',
      }));
    }
    if (isUserCancellation(cancellation)) this.cancelQueuedSkillActivations(cancellation);
    if (isUserCancellation(cancellation) && !this.disposing) {
      this.instantiation.invokeFunction((accessor) => {
        accessor.get(IAgentInterruptionReminderService).notifyUserCancellation(cancellation);
      });
    }
    this.turns.abort(activeTurnId, cancellation);
    const hasUserContinuation =
      this.pendingSubmissions.some((entry) => entry.attributes?.origin?.kind === 'user') ||
      loop.state.inbox.normal.some((entry) => entry.attributes?.origin?.kind === 'user') ||
      loop.state.inbox.notify.some((entry) => entry.attributes?.origin?.kind === 'user');
    loop.abort(cancellation, { continue: !isUserCancellation(cancellation) || hasUserContinuation });
    return true;
  }

  private cancelQueuedSkillActivations(cancellation: unknown): void {
    const entries = [...(this.loop?.state.inbox.normal ?? []), ...this.pendingSubmissions];
    for (const entry of entries) {
      if (entry.attributes?.origin?.kind !== 'skill_activation') continue;
      const id = entry.attributes.promptId;
      if (id !== undefined) this.cancel({ promptId: id }, cancellation);
    }
  }

  private hasPendingRequests(): boolean {
    if (this.disposing) return false;
    return (
      this.pendingSubmissions.length > 0 ||
      this.pendingNotifications.length > 0 ||
      this.pendingReminders.length > 0 ||
      (this.loop?.state.inbox.normal.length ?? 0) > 0 ||
      (this.loop?.state.inbox.notify.length ?? 0) > 0 ||
      (this.loop?.state.inbox.remind.length ?? 0) > 0 ||
      (this.loop?.state.completionPending ?? false) ||
      (this.loop?.state.resetting ?? false) ||
      (this.loop !== undefined && this.loop.state.status !== 'idle')
    );
  }

  async settled(): Promise<TurnResult | undefined> {
    await this.startPromise;
    await this.taskReconciliation;
    const loop = this.loop;
    if (loop === undefined) {
      if (!this.hasPendingRequests()) return this.turns.lastResult;
      await new Promise<void>((resolve) => this.settleWaiters.push(resolve));
      return this.turns.lastResult;
    }
    await loop.waitForIdle();
    await this.turns.drain();
    await this.wire.flush();
    return this.turns.lastResult;
  }

  continueTurn(reminders: readonly Message[] = []): void {
    if (this.disposing) throw abortError('Agent loop disposed');
    if (
      this.quiescenceDepth > 0 ||
      this.historySnapshotDepth > 0 ||
      this.hasPendingRequests() ||
      this.snapshot().paused
    ) {
      throw new Error2(ErrorCodes.SESSION_BUSY, 'Agent loop is currently busy');
    }
    this.runGate.begin();
    const loop = this.loop;
    if (loop === undefined) return;
    const allReminders =
      this.pendingReminders.length > 0
        ? [...this.pendingReminders.splice(0), ...reminders]
        : reminders;
    if (allReminders.length > 0) {
      loop.remind(...allReminders);
    }
    loop.continue({ force: true });
    this.maybeSettle();
  }

  async retry(): Promise<TurnResult | undefined> {
    const previous = this.turns.lastResult;
    this.loop?.continue({ force: true });
    await this.settled();
    const result = this.turns.lastResult;
    return result === previous ? undefined : result;
  }

  private maybeSettle(): void {
    if (this.hasPendingRequests() || this.settleWaiters.length === 0) return;
    const waiters = this.settleWaiters.splice(0);
    for (const resolve of waiters) resolve();
  }

  registerLoopErrorHandler(handler: LoopErrorHandler, options: LoopErrorHandlerRegistrationOptions = {}): IDisposable {
    if (options.before !== undefined && options.after !== undefined) {
      throw new BugIndicatingError('Loop error handler registration cannot specify both before and after');
    }
    this.deleteErrorHandler(handler.id);
    const target = options.before ?? options.after;
    if (target === undefined) {
      this.errorHandlers.push(handler);
    } else {
      const targetIndex = this.errorHandlers.findIndex((entry) => entry.id === target);
      if (targetIndex < 0) throw new BugIndicatingError(`Loop error handler target "${target}" is not registered`);
      const insertAt = options.before !== undefined ? targetIndex : targetIndex + 1;
      this.errorHandlers.splice(insertAt, 0, handler);
    }
    return toDisposable(() => {
      this.deleteErrorHandler(handler.id);
    });
  }

  private deleteErrorHandler(id: string): boolean {
    const index = this.errorHandlers.findIndex((entry) => entry.id === id);
    if (index < 0) return false;
    this.errorHandlers.splice(index, 1);
    return true;
  }
}

function machineUserMessage(message: ContextMessage | undefined): UserMessage {
  if (message === undefined) return EMPTY_LOOP_PROMPT;
  return { role: 'user', content: [...message.content] };
}

registerScopedService(
  LifecycleScope.Agent,
  IAgentLoopService,
  AgentLoopService,
  ScopeActivation.OnScopeCreated,
  'loop',
);

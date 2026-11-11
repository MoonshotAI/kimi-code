import { randomUUID } from 'node:crypto';

import { Disposable, toDisposable, type IDisposable } from '#/_base/di/lifecycle';
import { IInstantiationService } from '#/_base/di/instantiation';
import { SyncDescriptor } from '#/_base/di/descriptors';
import { ILogService } from '#/_base/log/log';
import { LifecycleScope } from '#/app/scopes';
import { ScopeActivation, registerScopedService } from '#/_base/di/scope';
import { defineState } from '#/state/state';
import { abortError, isUserCancellation, userCancellationReason } from '#/_base/utils/abort';
import { toErrorMessage } from '#/_base/errors/errorMessage';
import { AgentLoopRequestFactory } from './requester';
import { AgentLoopRequestObserver } from './requestObservation';
import { createAgentMediaPolicy } from './mediaPolicy';
import type { LoopRequester } from './requesterContract';
import { IAgentMediaResolverService } from '#/agent/media/mediaResolver';
import { IAgentToolExecutorService } from '#/agent/toolExecutor/toolExecutor';
import { agentTaskInfo } from '#/agent/task/handler';
import { IAgentTaskHistoryService } from '#/agent/task/taskService';
import { IAgentToolRegistryService } from '#/agent/toolRegistry/toolRegistry';
import { TaskStarted, TaskTerminated } from '#/agent/task/taskOps';
import { TERMINAL_STATUSES } from '#/agent/task/types';
import { IAgentTaskOutputService } from '#/agent/task/taskOutput';
import { restoreTaskCompletions } from '#/agent/task/completionRestore';
import { completionEntry as coreCompletionEntry, type ToolCompletionInput } from './core/tool/outcome';
import { IConfigService } from '#/app/config/config';
import { type ContentPart, type ToolDescription as Tool, type UserMessage } from '#human/llm/message';
import { BugIndicatingError, ErrorCodes, Error2 } from '#/errors';
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
import type { ModelCapability } from '#/llm-adapter/contract/capability';
import type { ModelRequestParams } from '#/llm-adapter/model/generate';
import type { ThinkingEffort } from '#human/llm-requester/thinking';
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
  type LoopNotifyEntry,
  type LoopNotifyHandle,
  type LoopSnapshot,
  type LoopSubmitResult,
  type PromptHandle,
  type PromptLaunchResult,
  type PromptPayload,
  type PromptSubmitContext,
  type SteerResult,
  type TurnResult,
} from './loop';
import { createUserEntry, type HistoryMessage, type UserEntry } from '#human/agent/turn';
import { TurnCancel, turnKey } from './turnOps';
import { EMPTY_LOOP_PROMPT, historyEntryFromContext } from './history';
import {
  createLoop,
  createMaxStepsHook,
  type Loop,
  type LoopEmitted,
  type MessageAppendingEvent,
  type TurnStartingEvent,
} from './core/index';
import { LoopJournal, type LoopJournalSnapshot } from './journal';
import { AgentPromptProjection } from './promptProjection';
import { AgentTurnProjection, loopLastRequestIdKey } from './turnProjection';
import { AgentNotificationProjection } from './notificationProjection';
import { AgentLoopProfileAdapter } from './profileAdapter';

export type LoopInterruptReason = 'aborted' | 'max_steps' | 'error' | 'steered';

export { loopLastRequestIdKey } from './turnProjection';
export const loopDisposingKey = defineState<boolean>('loop.disposing', () => false);

export class AgentLoopService extends Disposable implements IAgentLoopService {
  declare readonly _serviceBrand: undefined;

  readonly requester: LoopRequester;
  private readonly requestFactory: AgentLoopRequestFactory;
  readonly hooks: IAgentLoopService['hooks'] = {
    onWillBeginStep: new OrderedHookSlot(),
    onDidFinishStep: new OrderedHookSlot(),
    onBeforeSubmitPrompt: new OrderedHookSlot(),
  };

  private readonly errorHandlers: LoopErrorHandler[] = [];
  private readonly pendingSubmissions: UserEntry[] = [];
  private readonly pendingReminders: HistoryMessage[] = [];
  private readonly pendingNotifications: UserEntry[] = [];
  private readonly pendingSendNowNotifications = new Set<string>();
  private readonly settleWaiters: Array<() => void> = [];
  private quiescenceDepth = 0;
  private historySnapshotDepth = 0;
  private loop: Loop | undefined;
  private initialized = false;
  private startPromise: Promise<void> | undefined;
  private closePromise: Promise<void> | undefined;
  private readonly batchStartingHooks = new Map<string, import('./core/index').HookRegistration>();
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
    @IAgentProfileService private readonly profile: IAgentProfileService,
    @ISessionAgentProfileCatalog private readonly catalog: ISessionAgentProfileCatalog,
    @IProviderDiscoveryService private readonly discovery: IProviderDiscoveryService,
    @IPluginService private readonly plugins: IPluginService,
    @ISessionRunGate private readonly runGate: ISessionRunGate,
    @ILogService private readonly logger: ILogService,
    @IAgentMediaResolverService mediaResolver: IAgentMediaResolverService,
    @IAgentTaskOutputService private readonly taskOutputs: IAgentTaskOutputService,
  ) {
    super();
    const space = this.scopeContext.agentContext.space;
    if (space instanceof AgentSpaceImpl) this._register(space._setHistoryProvider(() => this.history()));
    const observer = instantiation.createInstance(AgentLoopRequestObserver);
    this.requestFactory = instantiation.createInstance(
      new SyncDescriptor(AgentLoopRequestFactory, [observer, () => this]),
    ) as AgentLoopRequestFactory;
    const requester = this.requestFactory;
    requester.registerMediaPolicy((model, request) => createAgentMediaPolicy(mediaResolver, model, request));
    requester.bindHistory(() => this.history());
    this.requester = {
      createTurnExecution: (input) => requester.createTurnExecution(input),
      prepareOperation: async (options, signal) => {
        if (this.loop === undefined) throw new BugIndicatingError('Agent loop is not started');
        const config = requester.requestConfigSnapshot();
        const baseline = options.tools ?? this.loop.state.profile.tools;
        const visible = options.tools === undefined && baseline !== undefined
          ? requester.operationTools(baseline, config.resolved.modelCapabilities)
          : baseline;
        const tools = await requester.prepareTools(signal, config.resolved.modelCapabilities, visible);
        return this.loop.operation((runtime) => requester.coreRequester({ ...options, runtime, tools, config }));
      },
    };
    this.journal = new LoopJournal(wire, scopeContext.agentId, dispatcher);
    this.prompts = new AgentPromptProjection(
      dispatcher,
      scopeContext.agentId,
      (includeCurrent) => this.snapshot().queue.length + (includeCurrent ? 1 : 0),
    );
    this.turns = new AgentTurnProjection({
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
    this.profileAdapter = new AgentLoopProfileAdapter(
      profile,
      dispatcher,
      scopeContext,
      discovery,
      catalog,
      telemetry,
      (value) => this.loop?.setSystemPrompt(value),
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

  private get disposing(): boolean {
    return this.states.get(loopDisposingKey);
  }

  private set disposing(value: boolean) {
    this.states.set(loopDisposingKey, value);
  }

  async start(tools?: readonly Tool[]): Promise<void> {
    if (this.loop !== undefined) return;
    this.startPromise ??= this.initializeLoop(undefined, tools).finally(() => {
      this.startPromise = undefined;
    });
    return this.startPromise;
  }

  baselineTools(): readonly Tool[] {
    return this.loop?.state.profile.tools ?? this.requestFactory.baselineTools();
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

  resolveRequestParams(): ModelRequestParams {
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
    const source = this.loop?.state.messages ?? this.journal.snapshot().input.messages ?? [];
    return this.turns.history(source);
  }

  historyRevision(): number {
    return this.loop?.historyRevision ?? 0;
  }

  replaceHistory(messages: readonly HistoryMessage[], reason?: string, onAccepted?: () => void): boolean {
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
    seededMessages?: readonly HistoryMessage[],
    initialTools?: readonly Tool[],
  ): Promise<void> {
    if (this.initialized) return;
    this.runGate.begin();
    await this.wire.drainPersisted().catch(() => undefined);
    const snapshot = this.journal.snapshot();
    this.profileAdapter.restore(snapshot);
    const tools = initialTools === undefined ? this.requestFactory.baselineTools() : [...initialTools];
    const taskHistory = this.instantiation.invokeFunction((accessor) => accessor.get(IAgentTaskHistoryService));
    await taskHistory.reconcile();
    const completions = await restoreTaskCompletions({
      wire: this.wire,
      agentId: this.scopeContext.agentId,
      taskOutputs: this.taskOutputs,
      messages: seededMessages ?? snapshot.input.messages ?? [],
      pending: snapshot.input.inbox?.notify ?? [],
      isLive: (taskId) => this.toolExecutor.handler(taskId)?.snapshot().status === 'running',
    });
    this.createLoopFromSnapshot(snapshot, tools, completions, seededMessages);
  }

  private createLoopFromSnapshot(
    snapshot: LoopJournalSnapshot,
    tools: readonly Tool[],
    completions: readonly UserEntry[],
    seededMessages?: readonly HistoryMessage[],
    minimumNextTurnId = 0,
    historyRevision?: number,
  ): void {
    this.initialized = true;
    const loop = createLoop({
      completionEntry: (input: ToolCompletionInput) => {
        const handler = this.toolExecutor.handlerForCall(input.toolCall.id);
        if (handler?.snapshot().fields.task === undefined) {
          return coreCompletionEntry(input.toolCall, input.outcome, input.result);
        }
        return this.taskOutputs.createCompletion(agentTaskInfo(handler), input.toolCall.id);
      },
      createTurnExecution: (input) => {
        const execution = this.requester.createTurnExecution({
          ...input,
          onTrace: (trace) => {
            this.turns.requestTrace = trace;
          },
          onOutcome: (outcome, source) => this.turns.recordOutcome(outcome, source),
        });
        this.turns.thinkingEffort = execution.thinkingEffort;
        return execution;
      },
      executor: this.toolExecutor.executor,
      toolContext: () => ({
        steerSignal: this.turns.steerSignal,
        trace: this.turns.requestTrace,
        remind: (message) => this.remind(historyEntryFromContext(message)),
      }),
      input: {
        ...snapshot.input,
        profile: {
          ...snapshot.input.profile,
          systemPrompt: this.getSystemPrompt(),
          tools,
        },
        messages: seededMessages === undefined ? snapshot.input.messages : [...seededMessages],
        inbox: {
          ...snapshot.input.inbox,
          notify: [...(snapshot.input.inbox?.notify ?? []), ...completions],
        },
        nextTurnId: Math.max(snapshot.input.nextTurnId ?? 0, minimumNextTurnId),
        historyRevision,
      },
      hooks: [
        ...this.batchStartingHooks.values(),
        createMaxStepsHook(
          () => this.config.get<LoopControl>(LOOP_CONTROL_SECTION)?.maxStepsPerTurn,
          (event) => loop.state.turn?.bypassMaxSteps === true && event.step === 1,
        ),
        { point: 'turn.starting', hook: (event, signal) => this.turnStarting(event, signal) },
        { point: 'message.appending', hook: (event, signal) => this.messageAppending(event, signal) },
        { point: 'step.starting', hook: (event) => this.turns.stepStarting(event) },
        { point: 'step.stopping', hook: (event) => this.turns.stepStopping(event) },
      ],
    });
    this.loop = loop;
    loop.subscribe((event) => {
      const enriched = this.turns.enrich(event, this.toolExecutor);
      this.notifications.project(event);
      if (event.type === 'llm.retrying') this.journal.append(enriched);
      this.turns.project(enriched, loop);
      this.projectTaskEvent(enriched);
      if (event.type !== 'llm.retrying') this.journal.append(enriched);
      if ((event.type === 'tool.async_ended' || (event.type === 'tool.ended' && !event.detached)) && event.taskId !== undefined) {
        this.toolExecutor.release(event.taskId);
      }
      this.maybeSettle();
    });
    this.drainPendingToLoop();
    this.maybeSettle();
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
  }

  async initializeHistory(messages: readonly HistoryMessage[]): Promise<void> {
    if (this.history().length > 0 || this.hasPendingRequests()) {
      throw new BugIndicatingError('Loop history initialization requires an empty quiescent loop');
    }
    await this.resetLoop(messages);
    if (!this.replaceHistory(messages, 'fork')) {
      throw new BugIndicatingError('Loop history initialization was rejected');
    }
  }

  async resetLoop(seededMessages?: readonly HistoryMessage[]): Promise<void> {
    if (this.disposing) return;
    const loop = this.loop;
    if (loop === undefined) {
      this.initialized = false;
      await this.initializeLoop(seededMessages);
      return;
    }
    if (loop.state.turn !== undefined || loop.state.resetting) {
      throw new BugIndicatingError('Loop reset requires a quiescent loop');
    }
    const minimumNextTurnId = loop.state.nextTurnId;
    const historyRevision = loop.historyRevision + 1;
    const baselineTools = loop.state.profile.tools ?? [];
    await loop.reset(async () => {
      this.runGate.begin();
      this.drainPendingToLoop();
      await this.wire.drainPersisted().catch(() => undefined);
      const snapshot = this.journal.snapshot();
      this.profileAdapter.restore(snapshot);
      const taskHistory = this.instantiation.invokeFunction((accessor) => accessor.get(IAgentTaskHistoryService));
      await taskHistory.reconcile();
      const completions = await restoreTaskCompletions({
        wire: this.wire,
        agentId: this.scopeContext.agentId,
        taskOutputs: this.taskOutputs,
        messages: seededMessages ?? snapshot.input.messages ?? [],
        pending: snapshot.input.inbox?.notify ?? [],
        isLive: (taskId) => this.toolExecutor.handler(taskId)?.snapshot().status === 'running',
      });
      const input = {
        ...snapshot,
        input: {
          ...snapshot.input,
          profile: { systemPrompt: this.getSystemPrompt(), tools: baselineTools },
          messages: seededMessages === undefined ? snapshot.input.messages : [...seededMessages],
          inbox: {
            ...snapshot.input.inbox,
            notify: [...(snapshot.input.inbox?.notify ?? []), ...completions],
          },
          nextTurnId: Math.max(snapshot.input.nextTurnId ?? 0, minimumNextTurnId),
          historyRevision,
        },
      };
      return input.input;
    });
    this.turns.invalidateHistory();
    this.drainPendingToLoop();
    this.maybeSettle();
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
      this.loop?.flushReminders();
      await this.loop?.close();
      await this.turns.drain();
      await this.journal.settled();
      await this.wire.drainPersisted();
      this.maybeSettle();
    })();
    return this.closePromise;
  }

  override dispose(): void {
    void this.close();
    super.dispose();
  }

  submit(payload: PromptPayload): Promise<PromptLaunchResult | undefined>;
  submit(input: UserEntry): LoopSubmitResult;
  submit(input: UserEntry | PromptPayload): LoopSubmitResult | Promise<PromptLaunchResult | undefined> {
    if ('input' in input) return this.submitClient(input);
    const { id, entry } = this.admit(input);
    if (this.loop !== undefined && this.quiescenceDepth === 0) this.loop.submit(entry);
    else this.pendingSubmissions.push(entry);
    this.maybeSettle();
    return { id };
  }

  private async submitClient(payload: PromptPayload): Promise<PromptLaunchResult | undefined> {
    await this.updatePromptMetadata(promptMetadataTextFromContentParts(payload.input));
    const status = this.snapshot();
    const { id } = this.submit({
      message: { role: 'user', content: [...payload.input] },
      meta: { promptId: payload.promptId, origin: { kind: 'user' } },
    });
    if (status.state === 'running' || status.paused || status.queue.length > 0) return undefined;
    return this.launchResult(id);
  }

  async notifyClient(input: LoopNotifyEntry): Promise<SteerResult> {
    this.telemetry.track2('input_steer', { parts: input.message.content.length });
    await this.updatePromptMetadata(promptMetadataTextFromContentParts(input.message.content));
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

  private admit(input: UserEntry): { readonly id: string; readonly entry: UserEntry } {
    if (this.disposing) throw abortError('Agent loop disposed');
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
    const queued = new Map(loop.state.inbox.normal.map((entry) => [entry.meta?.promptId, entry] as const));
    const ids = new Set(promptIds);
    if (ids.size !== promptIds.length || ![...ids].every((id) => queued.has(id))) {
      throw new Error2(ErrorCodes.PROMPT_NOT_FOUND, 'one or more prompts are not pending');
    }
    for (const id of ids) {
      const entry = queued.get(id);
      if (entry !== undefined) await this.materializeDaemonRefs(entry.message);
    }
    const pending = new Set(loop.state.inbox.normal.map((entry) => entry.meta?.promptId));
    if (loop.state.turn?.id !== activeTurnId || ![...ids].every((id) => pending.has(id))) {
      throw new Error2(ErrorCodes.PROMPT_NOT_FOUND, 'one or more prompts are no longer pending');
    }
    loop.steer(promptIds);
  }

  promptHandle(id: string): PromptHandle | undefined {
    return this.prompts.handle(id);
  }

  notify(input: LoopNotifyEntry): LoopSubmitResult;
  notify(note?: LoopNotify): LoopNotifyHandle;
  notify(note: LoopNotify | LoopNotifyEntry = {}): LoopSubmitResult | LoopNotifyHandle {
    if ('meta' in note) {
      const { id, entry } = this.admit(note);
      this.sendNotification(entry);
      this.maybeSettle();
      return { id };
    }
    if (this.disposing) throw abortError('Agent loop disposed');
    const id = note.message?.id ?? newMessageId();
    const entry = createUserEntry(machineUserMessage(note.message), {
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

  sendNow(input: LoopNotifyEntry): LoopSubmitResult;
  sendNow(promptIds: readonly string[]): Promise<void>;
  sendNow(input: LoopNotifyEntry | readonly string[]): LoopSubmitResult | Promise<void> {
    if (Array.isArray(input)) return this.sendNowEntries(input);
    const entry = input as LoopNotifyEntry;
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
    const normal = new Map(loop.state.inbox.normal.map((entry) => [entry.meta?.promptId, entry] as const));
    const notify = new Set(loop.state.inbox.notify.map((entry) => entry.meta?.promptId));
    const ids = new Set(promptIds);
    if (ids.size !== promptIds.length || ![...ids].every((id) => normal.has(id) || notify.has(id))) {
      throw new Error2(ErrorCodes.PROMPT_NOT_FOUND, 'one or more prompts are not pending');
    }
    for (const id of ids) {
      const entry = normal.get(id);
      if (entry !== undefined) await this.materializeDaemonRefs(entry.message);
    }
    const pendingNormal = new Set(loop.state.inbox.normal.map((entry) => entry.meta?.promptId));
    const pendingNotify = new Set(loop.state.inbox.notify.map((entry) => entry.meta?.promptId));
    if (loop.state.turn?.id !== activeTurnId || ![...ids].every((id) => pendingNormal.has(id) || pendingNotify.has(id))) {
      throw new Error2(ErrorCodes.PROMPT_NOT_FOUND, 'one or more prompts are no longer pending');
    }
    loop.sendNow(promptIds);
  }

  remind(...entries: readonly HistoryMessage[]): void {
    if (this.disposing) throw abortError('Agent loop disposed');
    if (this.loop !== undefined && this.quiescenceDepth === 0) this.loop.remind(...entries);
    else this.pendingReminders.push(...entries);
  }

  flushReminders(): void {
    const loop = this.loop;
    if (loop === undefined) return;
    if (this.pendingReminders.length > 0) loop.remind(...this.pendingReminders.splice(0));
    loop.flushReminders();
  }

  private sendNotification(entry: UserEntry, sendNow = false): void {
    if (this.loop !== undefined && this.quiescenceDepth === 0) {
      if (sendNow) this.loop.sendNow(entry);
      else this.loop.notify(entry);
      return;
    }
    this.pendingNotifications.push(entry);
    const id = entry.meta?.promptId;
    if (sendNow && id !== undefined) this.pendingSendNowNotifications.add(id);
  }

  private dropNotification(id: string): void {
    if (this.notifications.isMaterialized(id) || this.notifications.isDropped(id)) return;
    for (let index = this.pendingNotifications.length - 1; index >= 0; index -= 1) {
      if (this.pendingNotifications[index]!.meta?.promptId === id) this.pendingNotifications.splice(index, 1);
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
      (entry) => !machineQueue.some((item) => item.meta?.promptId === entry.meta?.promptId),
    );
    const parked = this.pendingSubmissions.filter(
      (entry) => !machineQueue.some((item) => item.meta?.promptId === entry.meta?.promptId),
    );
    const queue = [...machineQueue, ...inFlight, ...parked];
    const notificationCount =
      (loop === undefined ? 0 : loop.state.inbox.notify.length + loop.state.inbox.remind.length) +
      this.pendingNotifications.length;
    return this.turns.snapshot(loop, queue, notificationCount, this.quiescenceDepth > 0, this.hasPendingRequests());
  }

  private async materializeDaemonRefs(message: { readonly content: readonly ContentPart[] }): Promise<void> {
    if (!message.content.some((part) => daemonFileRefFromPart(part) !== undefined)) return;
    const files = this.instantiation.invokeFunction((accessor) => accessor.get(IFileService));
    const mediaStore = this.instantiation.invokeFunction((accessor) => accessor.get(ISessionMediaStore));
    await materializePromptDaemonRefs(message.content, { files, mediaStore });
  }

  private async turnStarting(event: TurnStartingEvent, signal: AbortSignal) {
    const pending = this.prompts.prepareTurn(event);
    if (pending === undefined) return undefined;
    const promptMessage: ContextMessage = {
      role: 'user',
      content: [...pending.entry.message.content],
      id: pending.entry.meta?.promptId,
      origin: pending.entry.meta?.origin as PromptOrigin | undefined,
    };
    const ctx: PromptSubmitContext = { promptMessage, isSteer: false, hookParts: [], block: false };
    try {
      await this.hooks.onBeforeSubmitPrompt.run(ctx);
      if (ctx.block) return { type: 'blocked' as const, cause: { by: 'prompt', reason: 'blocked' } };
      await this.materializeDaemonRefs(promptMessage);
      pending.message = {
        role: 'user',
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

  private messageAppending(event: MessageAppendingEvent, _signal: AbortSignal) {
    if (event.item.kind === 'normal') {
      const pending = this.prompts.pending(event.turnId);
      if (pending !== undefined) return { entry: { ...event.item.entry, message: pending.message } };
      return undefined;
    }
    if (event.item.kind === 'notify') {
      return {
        entry: {
          ...event.item.entry,
          message: {
            ...event.item.entry.message,
            content: gateImageFormatParts(event.item.entry.message.content, this.getModelProviderType()),
          },
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
        if (this.pendingSubmissions[index]!.meta?.promptId === target.promptId) this.pendingSubmissions.splice(index, 1);
      }
      this.loop?.cancel(target.promptId);
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

  registerToolBatchStarting(hook: import('./core/index').LoopHooks['tool.batch-starting']): IDisposable {
    const registration = { point: 'tool.batch-starting' as const, id: randomUUID(), hook };
    this.batchStartingHooks.set(registration.id, registration);
    this.loop?.hooks.add(registration);
    return toDisposable(() => {
      this.batchStartingHooks.delete(registration.id);
      this.loop?.hooks.remove(registration.id);
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
    const normal = new Set(loop.state.inbox.normal.map((item) => item.meta?.promptId));
    for (const entry of this.pendingSubmissions.splice(0)) {
      const id = entry.meta?.promptId;
      if (id === undefined || normal.has(id)) continue;
      loop.submit(entry);
    }
    const notify = new Set(loop.state.inbox.notify.map((item) => item.meta?.promptId));
    for (const entry of this.pendingNotifications.splice(0)) {
      const id = entry.meta?.promptId;
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
      this.pendingSubmissions.some((entry) => entry.meta?.origin?.kind === 'user') ||
      loop.state.inbox.normal.some((entry) => entry.meta?.origin?.kind === 'user') ||
      loop.state.inbox.notify.some((entry) => entry.meta?.origin?.kind === 'user');
    loop.abort(cancellation, { continue: !isUserCancellation(cancellation) || hasUserContinuation });
    return true;
  }

  private cancelQueuedSkillActivations(cancellation: unknown): void {
    const entries = [...(this.loop?.state.inbox.normal ?? []), ...this.pendingSubmissions];
    for (const entry of entries) {
      if (entry.meta?.origin?.kind !== 'skill_activation') continue;
      const id = entry.meta.promptId;
      if (id !== undefined) this.cancel({ promptId: id }, cancellation);
    }
  }

  private hasPendingRequests(): boolean {
    if (this.disposing) return false;
    return (
      this.pendingSubmissions.length > 0 ||
      this.pendingNotifications.length > 0 ||
      (this.loop?.state.inbox.normal.length ?? 0) > 0 ||
      (this.loop?.state.inbox.notify.length ?? 0) > 0 ||
      (this.loop?.state.completionPending ?? false) ||
      (this.loop?.state.resetting ?? false) ||
      (this.loop !== undefined && this.loop.state.status !== 'idle')
    );
  }

  async settled(): Promise<void> {
    await this.startPromise;
    const loop = this.loop;
    if (loop === undefined) {
      if (!this.hasPendingRequests()) return;
      await new Promise<void>((resolve) => this.settleWaiters.push(resolve));
      return;
    }
    await loop.waitForIdle();
    await this.turns.drain();
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

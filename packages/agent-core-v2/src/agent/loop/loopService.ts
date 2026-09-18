import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';

import { createControlledPromise } from '@antfu/utils';

import { Disposable, toDisposable, type IDisposable } from '#/_base/di/lifecycle';
import { IInstantiationService } from '#/_base/di/instantiation';
import { LifecycleScope } from '#/app/scopes';
import { ScopeActivation, registerScopedService } from '#/_base/di/scope';
import { defineState } from '#/state/state';
import { abortError, isAbortError, isUserCancellation, userCancellationReason } from '#/_base/utils/abort';
import { toErrorMessage } from '#/_base/errors/errorMessage';
import { onUnexpectedError } from '#/_base/errors/unexpectedError';
import { retryErrorFields } from '#/_base/utils/retry';
import { IAgentLLMRequesterService } from '#/agent/llmRequester/llmRequester';
import type { LLMRequestTrace } from '#/llm-adapter/contract/request-trace';
import type { ModelRequestTiming } from '#/llm-adapter/model/model-requester';
import { IAgentToolExecutorService } from '#/agent/toolExecutor/toolExecutor';
import { abortedToolOutput } from '#/agent/toolExecutor/toolExecutorService';
import type { ToolDidExecuteContext } from '#/agent/toolExecutor/toolHooks';
import type { ExecutableToolResult } from '#/tool/toolContract';
import { IAgentToolRegistryService } from '#/agent/toolRegistry/toolRegistry';
import { IConfigService } from '#/app/config/config';
import { AgentErrorEvent } from '#/agent/mcp/mcpEvents';
import { type FinishReason } from '#human/llm/finish-reason';
import { mergeInPlace } from '#/llm-adapter/contract/message';
import type { ContentPart, UserMessage } from '#human/llm/message';
import { emptyUsage, type TokenUsage } from '#human/llm/usage';
import { BugIndicatingError, ErrorCodes, Error2, isError2, toKimiErrorPayload } from '#/errors';
import { OrderedHookSlot } from '#/hooks';

import { IAgentContextMemoryService } from '#/agent/contextMemory/contextMemory';
import { isVacuousContentPart } from '#/agent/contextMemory/vacuousContent';
import { newMessageId } from '#/agent/contextMemory/messageId';
import { type ContextMessage, type PromptOrigin } from '#/agent/contextMemory/types';
import { gateImageFormatParts } from '#/agent/media/image-compress';
import { daemonFileRefFromPart } from '#/agent/media/mediaRef';
import { materializePromptDaemonRefs } from '#/agent/media/promptMediaIntake';
import { ISessionMediaStore } from '#/agent/media/sessionMediaStore';
import { IAgentProfileService } from '#/agent/profile/profile';
import { IAgentScopeContext } from '#/agent/scopeContext/scopeContext';
import { IAgentStateService } from '#/agent/state/agentState';
import { IFileService } from '#/app/file/fileService';
import type {
  TurnEndedEvent as TurnEndedTelemetryEvent,
  TurnInterruptedEvent,
  TurnStartedEvent as TurnStartedTelemetryEvent,
} from '#/app/telemetry/events';
import { ITelemetryService } from '#/app/telemetry/telemetry';
import { IEventDispatcher } from '#/state/eventDispatcher';
import { IWireService } from '#/wire/wire';
import {
  PromptAborted,
  PromptCompleted,
  PromptQueued,
  PromptStarted,
  PromptSteered,
  PromptSubmitted,
} from '#/agent/prompt/promptEvents';
import { LOOP_CONTROL_SECTION, type LoopControl } from './configSection';
import {
  createMaxStepsExceededError,
  IAgentLoopService,
  isMaxStepsExceededError,
  type AfterStepContext,
  type LoopCancelTarget,
  type LoopError,
  type LoopErrorContext,
  type LoopErrorHandler,
  type LoopErrorHandlerRegistrationOptions,
  type LoopNotify,
  type LoopNotifyHandle,
  type LoopRunResult,
  type LoopSnapshot,
  type LoopSubmitOptions,
  type LoopSubmitResult,
  type PromptCompletion,
  type PromptHandle,
  type PromptState,
  type PromptSubmitContext,
  type Turn,
  type TurnResult,
} from './loop';
import { mergeSteerMessages, stripBundledSkillBlocks } from '#human/agent/origin';
import { createUserEntry, type UserEntry } from '#human/agent/turn';
import {
  AssistantDelta,
  isDisplayablePromptOrigin,
  ThinkingDelta,
  ToolCallDelta,
  turnPromptAttachments,
  turnPromptText,
  TurnStarted,
  TurnStepCompleted,
  TurnStepInterrupted,
  TurnStepRetrying,
  TurnStepStarted,
  type TurnInterruptReason,
} from './turnEvents';
import { TurnCancel, TurnEnded, turnKey, TurnPrompt, TurnSteer } from './turnOps';
import {
  attachMachineEngine,
  EMPTY_MACHINE_PROMPT,
  ENGINE_JOURNAL_DOMAIN,
  engineJournal,
  historyFromContext,
  MACHINE_LOOP_MODEL,
  machineEngineAttachBundle,
  wireStoreJournal,
  type CreateMachineEngineOptions,
  type MachineEngine,
  type MachineEngineAttachBundle,
  type MachineEngineAttachRef,
  type MachineEngineEvent,
  type MachineTurnOutcome,
  type PromptGateVerdict,
} from './machine';

export type LoopInterruptReason = 'aborted' | 'max_steps' | 'error';

export const loopLastRequestTraceIdKey = defineState<string | undefined>(
  'loop.lastRequestTraceId',
  () => undefined as string | undefined,
);
export const loopDisposingKey = defineState<boolean>('loop.disposing', () => false);

const MAX_STEP_SIGNAL_LISTENERS = 64;

export class AgentLoopService extends Disposable implements IAgentLoopService {
  declare readonly _serviceBrand: undefined;

  readonly hooks: IAgentLoopService['hooks'] = {
    onWillBeginStep: new OrderedHookSlot(),
    onDidFinishStep: new OrderedHookSlot(),
    onBeforeSubmitPrompt: new OrderedHookSlot(),
  };

  private readonly errorHandlers: LoopErrorHandler[] = [];
  private readonly promptWaiters = new Map<string, PromptWaiter>();
  private readonly steered = new Map<string, SteeredPrompt>();
  private readonly terminalStates = new Map<string, PromptState>();
  private readonly pendingSubmissions: UserEntry[] = [];
  private readonly nudges: Nudge[] = [];
  private nudgeCursor = 0;
  private active: ActiveTurn | undefined;
  private pendingMachineTurn:
    | { readonly id: number; readonly queueItemId?: string; readonly entry?: UserEntry }
    | undefined;
  private machineTurnSuppressed = false;
  private readonly settleWaiters: Array<() => void> = [];
  private quiescenceDepth = 0;
  private activeRequestTrace: LLMRequestTrace | undefined;
  private engine: MachineEngine | undefined;

  constructor(
    @IAgentContextMemoryService private readonly context: IAgentContextMemoryService,
    @IAgentLLMRequesterService private readonly llmRequester: IAgentLLMRequesterService,
    @IAgentToolExecutorService private readonly toolExecutor: IAgentToolExecutorService,
    @IAgentToolRegistryService private readonly toolRegistry: IAgentToolRegistryService,
    @IConfigService private readonly config: IConfigService,
    @IEventDispatcher private readonly dispatcher: IEventDispatcher,
    @IAgentScopeContext private readonly scopeContext: IAgentScopeContext,
    @ITelemetryService private readonly telemetry: ITelemetryService,
    @IAgentStateService private readonly states: IAgentStateService,
    @IWireService private readonly wire: IWireService,
    @IInstantiationService private readonly instantiation: IInstantiationService,
    @IAgentProfileService private readonly profile: IAgentProfileService,
  ) {
    super();
    this.states.contributeState(turnKey);
    this.states.contributeState(loopLastRequestTraceIdKey);
    this.states.contributeState(loopDisposingKey);
    this.toolExecutor.hooks.onDidExecuteTool.register('prompt-service-delivery', async (ctx, next) => {
      await this.deliverToolResult(ctx);
      await next();
    });
  }

  private get lastRequestTraceId(): string | undefined {
    return this.states.get(loopLastRequestTraceIdKey);
  }

  private set lastRequestTraceId(value: string | undefined) {
    this.states.set(loopLastRequestTraceIdKey, value);
  }

  private get disposing(): boolean {
    return this.states.get(loopDisposingKey);
  }

  private set disposing(value: boolean) {
    this.states.set(loopDisposingKey, value);
  }

  private engineOptions(): CreateMachineEngineOptions {
    return {
      model: MACHINE_LOOP_MODEL,
      llmRequester: this.llmRequester,
      toolExecutor: this.toolExecutor,
      toolInfos: () => this.toolRegistry.list(),
      maxAttemptsPerStep: this.config.get<LoopControl>(LOOP_CONTROL_SECTION)?.maxAttemptsPerStep,
      initialTurnId: this.states.get(turnKey).nextTurnId,
      journal: wireStoreJournal(this.wire, ENGINE_JOURNAL_DOMAIN),
      trace: () => this.activeRequestTrace,
      toolTurnId: () => this.active?.id,
      steerSignal: () => this.active?.steerController.signal,
      source: () =>
        this.active === undefined
          ? undefined
          : {
              type: 'turn',
              turnId: this.active.id,
              step: this.active.gatedSteps,
            },
      gate: (signal) => this.gate(signal),
      promptGate: (queueItemId, message) => this.runPromptGate(queueItemId, message),
      onTrace: (trace) => {
        this.activeRequestTrace = trace;
      },
      onEvent: (event) => this.projectMachineEvent(event),
      onToolResult: (toolCallId, result) => this.appendMachineToolResult(toolCallId, result),
    };
  }

  buildAttachBundle(): MachineEngineAttachBundle {
    return machineEngineAttachBundle(this.engineOptions());
  }

  attachEngine(ref: MachineEngineAttachRef, bundle: MachineEngineAttachBundle): MachineEngine {
    if (this.engine !== undefined) {
      throw new BugIndicatingError('Machine engine already attached');
    }
    this.engine = attachMachineEngine(ref, bundle, this.engineOptions());
    if (this.dispatcher.restorePhase === 'new') {
      const hook = this.dispatcher.hooks.onDidRestore.register('loop.engineRefold', async (_ctx, next) => {
        hook.dispose();
        try {
          if (!this.disposing && this.active === undefined && this.pendingMachineTurn === undefined) {
            await this.machineEngine().resetJournal(this.freshEngineJournal());
          }
        } catch (error) {
          onUnexpectedError(error);
        }
        await next();
      });
    }
    this.rebuildRestoredRecords();
    if (this.quiescenceDepth > 0) {
      this.machineEngine().pause();
    }
    if (!this.disposing) {
      this.drainPendingToMachine();
      this.maybeSettle();
    }
    return this.engine;
  }

  private rebuildRestoredRecords(): void {
    if (this.engine === undefined) return;
    for (const item of this.engine.snapshot().queue) {
      const promptId = item.meta?.promptId;
      if (promptId === undefined || this.promptWaiters.has(promptId)) continue;
      this.terminalStates.delete(promptId);
      this.promptWaiters.set(promptId, this.createWaiter(promptId));
    }
  }

  private machineEngine(): MachineEngine {
    if (this.engine === undefined) {
      throw new BugIndicatingError('Machine engine not attached');
    }
    return this.engine;
  }

  override dispose(): void {
    if (this.disposing) return;
    this.disposing = true;
    const reason = abortError('Agent loop disposed');
    for (const waiter of this.promptWaiters.values()) {
      this.settleWaiterCancelled(waiter);
      this.terminalStates.set(waiter.id, 'cancelled');
    }
    this.promptWaiters.clear();
    this.steered.clear();
    this.pendingSubmissions.length = 0;
    const active = this.active;
    active?.turn.cancel(reason);
    this.engine?.stop();
    if (active !== undefined) {
      this.interruptMachineRunForCancel(active, reason);
      void this.endTurn(active, { type: 'cancelled', steps: active.steps, reason });
    }
    this.maybeSettle();
    super.dispose();
  }

  submit(input: UserEntry, options?: LoopSubmitOptions): LoopSubmitResult {
    if (this.disposing) throw abortError('Agent loop disposed');
    const meta = input.meta;
    const id = meta?.promptId ?? newMessageId();
    const origin = (meta?.origin as PromptOrigin | undefined) ?? { kind: 'user' };
    const tracked = meta?.tracked === true;
    const createdAt = meta?.createdAt ?? (tracked ? new Date().toISOString() : '');
    const userMessageId = meta?.userMessageId ?? (tracked ? id : '');
    const waiter = this.createWaiter(id, meta?.promptId, options?.onMaterialize);
    this.terminalStates.delete(id);
    this.promptWaiters.set(id, waiter);
    const message: ContextMessage = {
      role: 'user',
      content: [...input.message.content],
      id,
      toolCalls: [],
      origin: meta?.origin as PromptOrigin | undefined,
    };
    if (tracked) {
      const queued =
        this.active !== undefined ||
        this.machinePaused() ||
        (this.engine !== undefined && this.engine.snapshot().queue.length > 0);
      this.publishPromptSubmitted(
        { promptId: id, origin, userMessageId, createdAt, message },
        queued ? 'queued' : 'running',
      );
      if (queued) this.publishPromptQueued({ promptId: id, origin, message });
    }
    const entry: UserEntry = {
      message: { role: 'user', content: [...input.message.content] },
      meta: { promptId: id, origin, tracked, createdAt, userMessageId },
    };
    if (this.engine !== undefined) {
      try {
        this.machineEngine().submit(entry);
      } catch {
        waiter.launched.resolve(undefined);
        waiter.completion.resolve({
          promptId: id,
          result: undefined,
          state: 'failed',
        });
        this.publishPromptCompleted(id, 'failed');
        this.terminalStates.set(id, 'failed');
        waiter.failedEntry = entry;
        return { id };
      }
    } else {
      this.pendingSubmissions.push(entry);
    }
    if (
      options?.steerIfActive === true &&
      this.active !== undefined &&
      this.active.prompt.tracked &&
      this.engine !== undefined
    ) {
      this.machineEngine().steer(id);
    }
    return { id };
  }

  async steer(promptIds: readonly string[]): Promise<void> {
    if (this.disposing) throw abortError('Agent loop disposed');
    if (promptIds.length === 0) {
      throw new Error2(ErrorCodes.REQUEST_INVALID, 'prompt_ids must not be empty');
    }
    const active = this.active;
    if (active === undefined || !active.prompt.tracked) {
      throw new Error2(ErrorCodes.PROMPT_NOT_FOUND, 'no active prompt to steer into');
    }
    const engine = this.machineEngine();
    const ids = new Set(promptIds);
    const queuedIds = new Set(engine.snapshot().queue.map((item) => item.meta?.promptId));
    if (ids.size !== promptIds.length || ![...ids].every((id) => queuedIds.has(id))) {
      throw new Error2(ErrorCodes.PROMPT_NOT_FOUND, 'one or more prompts are not pending');
    }
    for (const id of ids) {
      const entry = engine.snapshot().queue.find((item) => item.meta?.promptId === id);
      if (entry !== undefined) await this.materializeDaemonRefs(entry.message);
    }
    if (
      this.active !== active ||
      ![...ids].every((id) => new Set(engine.snapshot().queue.map((item) => item.meta?.promptId)).has(id))
    ) {
      throw new Error2(ErrorCodes.PROMPT_NOT_FOUND, 'one or more prompts are no longer pending');
    }
    engine.steer(promptIds);
  }

  promptHandle(id: string): PromptHandle | undefined {
    const waiter = this.promptWaiters.get(id);
    if (waiter === undefined) return undefined;
    const projection = this.promptProjection(id);
    const state = (): PromptState => this.promptStateOf(id);
    const handle: PromptHandle = {
      id,
      userMessageId: projection?.userMessageId ?? '',
      createdAt: projection?.createdAt ?? '',
      get state() {
        return state();
      },
      message: projection?.message ?? EMPTY_HANDLE_MESSAGE,
      launched: waiter.launched,
      completion: waiter.completion,
    };
    if (this.terminalStates.has(id)) this.promptWaiters.delete(id);
    return handle;
  }

  private promptStateOf(id: string): PromptState {
    if (this.active?.prompt.id === id) return 'running';
    if (this.steered.has(id)) return 'steered';
    return this.terminalStates.get(id) ?? 'pending';
  }

  private promptProjection(id: string): PromptProjection | undefined {
    const failedEntry = this.promptWaiters.get(id)?.failedEntry;
    if (failedEntry !== undefined) return projectionFromEntry(failedEntry);
    const active = this.active;
    if (active !== undefined && active.prompt.id === id) return active.prompt;
    const steered = this.steered.get(id);
    if (steered !== undefined) return steered;
    const pending = this.pendingMachineTurn;
    if (pending?.queueItemId === id && pending.entry !== undefined) {
      return projectionFromEntry(pending.entry);
    }
    const queued = this.engine
      ?.snapshot()
      .queue.find((item) => item.meta?.promptId === id);
    if (queued !== undefined) return projectionFromEntry(queued);
    const parked = this.pendingSubmissions.find((item) => item.meta?.promptId === id);
    if (parked !== undefined) return projectionFromEntry(parked);
    return undefined;
  }

  notify(note: LoopNotify = {}): LoopNotifyHandle {
    if (this.disposing) throw abortError('Agent loop disposed');
    const nudge: Nudge = {
      contextMessage: note.message,
      bypassMaxSteps: note.bypassMaxSteps ?? false,
      turnScoped: note.turnScoped ?? true,
      onConsume: note.onConsume,
      onDrop: note.onDrop,
    };
    this.nudges.push(nudge);
    if (this.quiescenceDepth === 0 && this.engine !== undefined) {
      nudge.sentToMachine = true;
      this.machineEngine().notify(createUserEntry(machineUserMessage(note.message)));
    }
    return {
      get dropped() {
        return nudge.dropped === true;
      },
      drop: () => {
        if (nudge.dropped === true || nudge.consumed === true) return;
        nudge.dropped = true;
        nudge.onDrop?.();
        this.maybeSettle();
      },
    };
  }

  private createWaiter(
    id: string,
    dispatchPromptId?: string,
    onMaterialize?: () => void,
  ): PromptWaiter {
    return {
      id,
      dispatchPromptId,
      launched: createControlledPromise<Turn | undefined>(),
      completion: createControlledPromise<PromptCompletion>(),
      onMaterialize,
    };
  }

  private machinePaused(): boolean {
    return this.engine?.snapshot().paused ?? false;
  }

  snapshot(): LoopSnapshot {
    const engine = this.engine;
    const engineSnapshot = engine?.snapshot();
    const machineQueue = engineSnapshot?.queue ?? [];
    const parked = this.pendingSubmissions.filter(
      (entry) => !machineQueue.some((item) => item.meta?.promptId === entry.meta?.promptId),
    );
    const queue = [...machineQueue, ...parked];
    const turn = engineSnapshot?.turn;
    return {
      state: this.active === undefined ? 'idle' : 'running',
      activeTurnId: this.active?.id,
      activePromptId:
        this.active !== undefined && this.active.prompt.tracked ? this.active.prompt.id : undefined,
      queue,
      notificationCount: engineSnapshot?.notificationCount ?? 0,
      paused: engineSnapshot?.paused ?? false,
      hasPendingRequests: this.hasPendingRequests(),
      turn:
        turn === undefined
          ? undefined
          : {
              turnId: turn.turnId,
              phase: turn.phase,
              step: turn.step,
              ending: engineSnapshot?.aborting ?? false,
              endingReason: engineSnapshot?.aborting === true ? 'aborted' : undefined,
              retry: turn.retry,
              activeToolCalls: turn.activeToolCalls,
              since: this.active?.startedAt,
            },
      activeTraceId: this.activeRequestTrace?.traceId,
    };
  }

  private settlePromptLaunched(waiter: PromptWaiter, active: ActiveTurn): void {
    waiter.launched.resolve(active.turn);
    void active.turn.result.then((result) =>
      this.settlePromptCompletion(waiter, active.prompt, result),
    );
    if (!active.prompt.tracked) return;
    this.publishPromptStarted(active.prompt.id, active.prompt.origin);
  }

  private settlePromptCompletion(
    waiter: PromptWaiter,
    prompt: ActivePrompt,
    result: TurnResult,
  ): void {
    const state =
      result.type === 'cancelled' ? 'cancelled' : result.type === 'failed' ? 'failed' : 'completed';
    waiter.completion.resolve({
      promptId: waiter.id,
      result,
      state,
    });
    for (const [childId, steeredEntry] of this.steered) {
      if (steeredEntry.parentId !== waiter.id) continue;
      const child = this.promptWaiters.get(childId);
      if (child !== undefined) {
        child.completion.resolve({
          promptId: childId,
          result,
          state,
        });
        this.promptWaiters.delete(childId);
      }
      this.terminalStates.set(childId, state);
      this.steered.delete(childId);
    }
    if (prompt.tracked) {
      if (state === 'cancelled') this.publishPromptAborted(waiter.id);
      else this.publishPromptCompleted(waiter.id, state);
    }
    this.terminalStates.set(waiter.id, state);
    this.promptWaiters.delete(waiter.id);
  }

  private async materializeDaemonRefs(message: {
    readonly content: readonly ContentPart[];
  }): Promise<void> {
    if (!message.content.some((part) => daemonFileRefFromPart(part) !== undefined)) return;
    const files = this.instantiation.invokeFunction((accessor) => accessor.get(IFileService));
    const mediaStore = this.instantiation.invokeFunction((accessor) =>
      accessor.get(ISessionMediaStore),
    );
    await materializePromptDaemonRefs(message.content, { files, mediaStore });
  }

  private async runPromptGate(
    queueItemId: string | undefined,
    message: UserMessage,
  ): Promise<PromptGateVerdict> {
    const waiter = queueItemId === undefined ? undefined : this.promptWaiters.get(queueItemId);
    const entry =
      queueItemId === undefined
        ? undefined
        : this.machineEngine().snapshot().queue.find((item) => item.meta?.promptId === queueItemId);
    if (waiter === undefined || entry?.meta?.tracked !== true) {
      return false;
    }
    const promptMessage: ContextMessage = {
      role: 'user',
      content: [...message.content],
      toolCalls: [],
      id: queueItemId,
      origin: entry.meta?.origin as PromptOrigin | undefined,
    };
    const ctx: PromptSubmitContext = {
      promptMessage,
      isSteer: false,
      block: false,
    };
    await this.hooks.onBeforeSubmitPrompt.run(ctx);
    if (ctx.block) return { block: true };
    await this.materializeDaemonRefs(promptMessage);
    return {
      block: false,
      message: {
        role: 'user',
        content: gateImageFormatParts(promptMessage.content, this.profile.getModelProviderType()),
      },
    };
  }

  private settleGateRejectedPrompt(
    queueItemId: string | undefined,
    entry: UserEntry | undefined,
    state: 'blocked' | 'failed',
  ): void {
    const waiter = queueItemId === undefined ? undefined : this.promptWaiters.get(queueItemId);
    if (waiter === undefined) return;
    if (state === 'blocked' && entry !== undefined && entry.message.content.length > 0) {
      this.context.append({
        role: 'user',
        content: [...entry.message.content],
        id: waiter.id,
        toolCalls: [],
        origin: entry.meta?.origin as PromptOrigin | undefined,
      });
    }
    waiter.launched.resolve(undefined);
    waiter.completion.resolve({
      promptId: waiter.id,
      result: undefined,
      state,
    });
    this.publishPromptCompleted(waiter.id, state);
    this.terminalStates.set(waiter.id, state);
    this.promptWaiters.delete(waiter.id);
    this.maybeSettle();
  }


  private async deliverToolResult(ctx: ToolDidExecuteContext): Promise<void> {
    const delivery = ctx.result.delivery;
    if (delivery === undefined) return;
    const { delivery: _delivery, ...rest } = ctx.result;
    ctx.result = rest as ExecutableToolResult;
    if (delivery.kind === 'steer') {
      const message = delivery.message as ContextMessage;
      this.submit(
        { message: machineUserMessage(message), meta: { origin: message.origin } },
        { steerIfActive: true },
      );
    }
  }

  private publishPromptCompleted(promptId: string, reason: 'completed' | 'failed' | 'blocked'): void {
    void this.dispatcher.dispatch(
      new PromptCompleted({
        agentId: this.scopeContext.agentId,
        promptId,
        finishedAt: new Date().toISOString(),
        reason,
      }),
    );
  }

  private publishPromptQueued(input: {
    readonly promptId: string;
    readonly origin: PromptOrigin;
    readonly message: ContextMessage;
  }): void {
    if (input.origin.kind !== 'user') return;
    void this.dispatcher.dispatch(
      new PromptQueued({
        agentId: this.scopeContext.agentId,
        promptId: input.promptId,
        content: stripBundledSkillBlocks(input.message),
        clientMetadata: input.origin.clientMetadata,
        queueLength: (this.engine?.snapshot().queue.length ?? 0) + 1,
      }),
    );
  }

  private publishPromptSubmitted(
    input: {
      readonly promptId: string;
      readonly origin: PromptOrigin;
      readonly userMessageId: string;
      readonly createdAt: string;
      readonly message: ContextMessage;
    },
    status: 'running' | 'queued',
  ): void {
    if (input.origin.kind !== 'user') return;
    void this.dispatcher.dispatch(
      new PromptSubmitted({
        agentId: this.scopeContext.agentId,
        promptId: input.promptId,
        userMessageId: input.userMessageId,
        status,
        content: stripBundledSkillBlocks(input.message),
        clientMetadata: input.origin.clientMetadata,
        createdAt: input.createdAt,
      }),
    );
  }

  private publishPromptStarted(promptId: string, origin: PromptOrigin): void {
    if (origin.kind !== 'user') return;
    void this.dispatcher.dispatch(
      new PromptStarted({
        agentId: this.scopeContext.agentId,
        promptId,
      }),
    );
  }

  private publishPromptAborted(promptId: string): void {
    void this.dispatcher.dispatch(
      new PromptAborted({
        agentId: this.scopeContext.agentId,
        promptId,
        abortedAt: new Date().toISOString(),
      }),
    );
  }

  cancel(target?: LoopCancelTarget, reason?: unknown): boolean {
    const cancellation = reason ?? userCancellationReason();
    if (target?.promptId !== undefined) {
      const active = this.active;
      if (active !== undefined && active.prompt.tracked && active.prompt.id === target.promptId) {
        return this.cancelActiveTurn(undefined, cancellation);
      }
      const waiter = this.promptWaiters.get(target.promptId);
      if (waiter === undefined) {
        throw new Error2(ErrorCodes.PROMPT_NOT_FOUND, `prompt ${target.promptId} not found`);
      }
      return this.cancelWaiter(waiter, cancellation);
    }
    return this.cancelActiveTurn(target?.turnId, cancellation);
  }

  private cancelWaiter(waiter: PromptWaiter, cancellation: unknown): boolean {
    const active = this.active;
    if (active !== undefined && active.prompt.id === waiter.id) {
      return this.cancelActiveTurn(undefined, cancellation);
    }
    const tracked = this.promptProjection(waiter.id)?.tracked === true;
    this.engine?.cancelQueueItem(waiter.id);
    this.settleWaiterCancelled(waiter);
    if (tracked) {
      this.publishPromptAborted(waiter.id);
    }
    this.terminalStates.set(waiter.id, 'cancelled');
    this.promptWaiters.delete(waiter.id);
    this.steered.delete(waiter.id);
    return true;
  }

  private settleWaiterCancelled(waiter: PromptWaiter): void {
    waiter.launched.resolve(undefined);
    waiter.completion.resolve({
      promptId: waiter.id,
      result: undefined,
      state: 'cancelled',
    });
    this.maybeSettle();
  }

  tryAcquireQuiescence(): IDisposable | undefined {
    if (this.disposing) throw abortError('Agent loop disposed');
    if (
      this.quiescenceDepth > 0 ||
      this.active !== undefined ||
      this.hasPendingRequests() ||
      this.pendingMachineTurn !== undefined
    ) {
      return undefined;
    }
    this.quiescenceDepth += 1;
    this.engine?.pause();
    return toDisposable(() => this.releaseQuiescence());
  }

  private releaseQuiescence(): void {
    if (this.quiescenceDepth === 0) return;
    this.quiescenceDepth -= 1;
    if (this.quiescenceDepth > 0 || this.disposing) return;
    this.engine?.resume();
    this.drainPendingToMachine();
    this.maybeSettle();
  }

  private drainPendingToMachine(): void {
    if (this.engine === undefined) return;
    const queued = new Set(this.engine.snapshot().queue.map((item) => item.meta?.promptId));
    for (const entry of this.pendingSubmissions.splice(0)) {
      const id = entry.meta?.promptId;
      if (id === undefined || queued.has(id) || !this.promptWaiters.has(id)) continue;
      this.machineEngine().submit(entry);
    }
    if (this.quiescenceDepth > 0) return;
    for (const nudge of this.nudges.slice(this.nudgeCursor)) {
      if (!nudge.dropped && !nudge.sentToMachine) {
        nudge.sentToMachine = true;
        this.machineEngine().notify(createUserEntry(machineUserMessage(nudge.contextMessage)));
      }
    }
  }

  async resetMachineEngine(): Promise<void> {
    if (this.disposing) return;
    if (this.active !== undefined || this.pendingMachineTurn !== undefined) {
      throw new BugIndicatingError('Machine engine reset requires a quiescent loop');
    }
    await this.machineEngine().resetJournal(this.freshEngineJournal());
  }

  private freshEngineJournal(): ReturnType<typeof engineJournal> {
    return engineJournal(
      wireStoreJournal(this.wire, ENGINE_JOURNAL_DOMAIN),
      this.states.get(turnKey).nextTurnId,
    );
  }

  private cancelActiveTurn(turnId: number | undefined, cancellation: unknown): boolean {
    const active = this.active;
    if (active === undefined || (turnId !== undefined && active.id !== turnId)) return false;
    if (active.controller.signal.aborted) {
      this.machineEngine().abort(active.controller.signal.reason);
      return true;
    }
    void this.dispatcher.dispatch(
      new TurnCancel({
        agentId: this.scopeContext.agentId,
        turnId: active.id,
        target: 'active',
        reason: cancelReasonFor(cancellation),
      }),
    );
    active.controller.abort(cancellation);
    this.machineEngine().abort(cancellation);
    return true;
  }

  private settleUnboundRecord(
    pending: { readonly id: number; readonly queueItemId?: string; readonly entry?: UserEntry },
    outcome: { readonly outcome: MachineTurnOutcome; readonly error?: unknown },
  ): void {
    const active = this.active;
    if (active !== undefined) {
      active.afterChain = active.afterChain.then(() => {
        this.settleUnboundRecord(pending, outcome);
      });
      return;
    }
    if (pending.queueItemId === undefined) {
      const seeded = this.nudges.slice(this.nudgeCursor).find(
        (nudge) => !nudge.dropped && nudge.contextMessage !== undefined && nudge.contextMessage.content.length > 0,
      );
      if (seeded === undefined) {
        this.consumeDrainedNudges();
        return;
      }
      const seededMessage = seeded.contextMessage as ContextMessage;
      const waiter = this.createWaiter(seededMessage.id ?? newMessageId(), seededMessage.id);
      this.terminalStates.delete(waiter.id);
      this.promptWaiters.set(waiter.id, waiter);
      const entry: UserEntry = {
        message: { role: 'user', content: [...seededMessage.content] },
        meta: { promptId: waiter.id, origin: seededMessage.origin, tracked: false },
      };
      const seededTurn = this.beginActiveTurn(waiter, entry, pending.id);
      this.mirrorConsumedNudges(seededTurn);
      this.endPreGateTurn(seededTurn, outcome);
      return;
    }
    const waiter = this.promptWaiters.get(pending.queueItemId);
    if (waiter === undefined || pending.entry === undefined) return;
    const boundTurn = this.beginActiveTurn(waiter, pending.entry, pending.id);
    waiter.onMaterialize?.();
    this.materializeMessage(this.gatedProjectionMessage(boundTurn.prompt));
    this.settlePromptLaunched(waiter, boundTurn);
    this.endPreGateTurn(boundTurn, outcome);
  }

  private endPreGateTurn(
    turn: ActiveTurn,
    outcome: { readonly outcome: MachineTurnOutcome; readonly error?: unknown },
  ): void {
    if (outcome.outcome === 'aborted') {
      const reason = turn.controller.signal.aborted
        ? turn.controller.signal.reason
        : abortError('Turn aborted');
      turn.controller.abort(reason);
      turn.afterChain = turn.afterChain.then(() =>
        this.endTurn(turn, { type: 'cancelled', steps: 0, reason }),
      );
      return;
    }
    const error = outcome.error ?? new Error2(ErrorCodes.INTERNAL, 'Turn ended before first step');
    turn.afterChain = turn.afterChain.then(() =>
      this.endTurn(turn, { type: 'failed', steps: 0, error }),
    );
  }

  private hasPendingRequests(): boolean {
    return (
      this.pendingSubmissions.length > 0 ||
      (this.engine?.snapshot().queue.length ?? 0) > 0 ||
      this.nudges.slice(this.nudgeCursor).some((nudge) => !nudge.dropped)
    );
  }

  settled(): Promise<void> {
    if (
      this.active === undefined &&
      !this.hasPendingRequests() &&
      this.pendingMachineTurn === undefined
    ) {
      return Promise.resolve();
    }
    return new Promise<void>((resolve) => {
      this.settleWaiters.push(resolve);
    });
  }

  private maybeSettle(): void {
    if (
      this.active !== undefined ||
      this.pendingMachineTurn !== undefined ||
      this.hasPendingRequests()
    ) return;
    if (this.settleWaiters.length === 0) return;
    const waiters = this.settleWaiters.splice(0);
    for (const resolve of waiters) resolve();
  }

  registerLoopErrorHandler(
    handler: LoopErrorHandler,
    options: LoopErrorHandlerRegistrationOptions = {},
  ): IDisposable {
    if (options.before !== undefined && options.after !== undefined) {
      throw new BugIndicatingError('Loop error handler registration cannot specify both before and after');
    }
    this.deleteErrorHandler(handler.id);
    const target = options.before ?? options.after;
    if (target === undefined) {
      this.errorHandlers.push(handler);
    } else {
      const targetIndex = this.errorHandlers.findIndex((entry) => entry.id === target);
      if (targetIndex < 0) {
        throw new BugIndicatingError(`Loop error handler target "${target}" is not registered`);
      }
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

  private async gate(machineSignal: AbortSignal): Promise<MachineGateDecision> {
    const active = this.active;
    if (active !== undefined) await active.afterChain;
    const pending = this.pendingMachineTurn;
    if (pending !== undefined) {
      this.pendingMachineTurn = undefined;
      if (!this.bindMachineTurn(pending)) return { type: 'fail' };
    }
    const turn = this.active;
    if (turn === undefined) return { type: 'fail' };
    if (turn.controller.signal.aborted || machineSignal.aborted) return { type: 'fail' };
    if (turn.stopRequested) return { type: 'fail' };
    if (turn.failedStep !== undefined) return { type: 'fail' };
    const consumed = this.mirrorConsumedNudges(turn);
    if (turn.steerController.signal.aborted) {
      turn.steerController = new AbortController();
    }
    if (turn.toolStopRequested && consumed.live === 0) return { type: 'fail' };
    const stepOrdinal = Math.max(this.engine?.currentStep() ?? 0, turn.steps + 1);
    const maxSteps = this.config.get<LoopControl>(LOOP_CONTROL_SECTION)?.maxStepsPerTurn;
    if (
      maxSteps !== undefined &&
      maxSteps > 0 &&
      stepOrdinal > maxSteps &&
      !consumed.bypass
    ) {
      turn.maxStepsError = createMaxStepsExceededError(maxSteps);
      return { type: 'fail' };
    }
    turn.steps = stepOrdinal;
    turn.gatedSteps = stepOrdinal;
    const step: MachineStepState = {
      number: stepOrdinal,
      uuid: randomUUID(),
      signal: turn.controller.signal,
      contentAppended: false,
      entry: undefined,
      usage: undefined,
      timing: undefined,
      providerFinishReason: undefined,
      rawFinishReason: undefined,
      messageId: undefined,
      pendingToolIds: new Set(),
      toolCallUuids: new Map(),
      resolvedToolIds: new Set(),
      toolStopTurn: false,
    };
    turn.current = step;
    turn.interruptStep = step.number;
    this.activeRequestTrace = undefined;
    this.telemetry.setContext({ trace_id: undefined });
    EventEmitter.setMaxListeners(MAX_STEP_SIGNAL_LISTENERS, turn.controller.signal);
    try {

      await this.hooks.onWillBeginStep.run({
        turnId: turn.id,
        step: stepOrdinal,
        firstStepOfTurn: stepOrdinal === 1,
        signal: step.signal,
      });

    } catch (error) {

      return this.failMachineGate(turn, step, error);
    }
    if (step.signal.aborted) {
      return this.failMachineGate(turn, step, step.signal.reason ?? abortError('Step aborted'));
    }
    return { type: 'proceed', signal: step.signal, step: step.number };
  }

  private failMachineGate(
    turn: ActiveTurn,
    step: MachineStepState,
    error: unknown,
  ): MachineGateDecision {
    if (turn.controller.signal.aborted || isAbortError(error) || step.signal.aborted) {
      turn.abortReason = turn.controller.signal.aborted ? turn.controller.signal.reason : error;
      return { type: 'fail' };
    }
    turn.failedStep = {
      number: step.number,
      uuid: step.uuid,
      error,
    };
    return { type: 'fail' };
  }

  private bindMachineTurn(pending: {
    readonly id: number;
    readonly queueItemId?: string;
    readonly entry?: UserEntry;
  }): boolean {
    if (this.active !== undefined) {
      if (pending.queueItemId !== undefined && pending.entry !== undefined) {
        const waiter = this.promptWaiters.get(pending.queueItemId);
        if (waiter !== undefined) {
          this.machineEngine().submit({
            message: this.gatedEntryMessage(pending.entry),
            meta: pending.entry.meta,
          });
        }
      }
      return true;
    }
    if (pending.queueItemId !== undefined) {
      const waiter = this.promptWaiters.get(pending.queueItemId);
      if (waiter === undefined || pending.entry === undefined) {
        this.machineTurnSuppressed = true;
        return false;
      }
      const boundTurn = this.beginActiveTurn(waiter, pending.entry, pending.id);
      waiter.onMaterialize?.();
      this.materializeMessage(this.gatedProjectionMessage(boundTurn.prompt));
      this.settlePromptLaunched(waiter, boundTurn);
      return true;
    }
    const seeded = this.nudges.slice(this.nudgeCursor).find(
      (nudge) => !nudge.dropped && nudge.contextMessage !== undefined && nudge.contextMessage.content.length > 0,
    );
    if (seeded === undefined) {
      this.machineTurnSuppressed = true;
      return false;
    }
    const seededMessage = seeded.contextMessage as ContextMessage;
    const waiter = this.createWaiter(seededMessage.id ?? newMessageId(), seededMessage.id);
    this.promptWaiters.set(waiter.id, waiter);
    const entry: UserEntry = {
      message: { role: 'user', content: [...seededMessage.content] },
      meta: { promptId: waiter.id, origin: seededMessage.origin, tracked: false },
    };
    this.beginActiveTurn(waiter, entry, pending.id);
    return true;
  }

  private gatedProjectionMessage(prompt: ActivePrompt): ContextMessage {
    if (!prompt.tracked) return prompt.message;
    return {
      ...prompt.message,
      content: gateImageFormatParts(prompt.message.content, this.profile.getModelProviderType()),
    };
  }

  private gatedEntryMessage(entry: UserEntry): UserMessage {
    if (entry.meta?.tracked !== true) return { role: 'user', content: [...entry.message.content] };
    return {
      role: 'user',
      content: gateImageFormatParts(entry.message.content, this.profile.getModelProviderType()),
    };
  }

  private beginActiveTurn(waiter: PromptWaiter, entry: UserEntry, id: number): ActiveTurn {
    const origin = (entry.meta?.origin as PromptOrigin | undefined) ?? { kind: 'user' };
    const tracked = entry.meta?.tracked === true;
    const prompt: ActivePrompt = {
      id: waiter.id,
      promptId: tracked ? waiter.id : waiter.dispatchPromptId,
      tracked,
      origin,
      message: {
        role: 'user',
        content: [...entry.message.content],
        id: waiter.id,
        toolCalls: [],
        origin: entry.meta?.origin as PromptOrigin | undefined,
      },
      userMessageId: entry.meta?.userMessageId ?? '',
      createdAt: entry.meta?.createdAt ?? '',
    };
    const controller = new AbortController();
    const ready = createControlledPromise<void>();
    const result = createControlledPromise<TurnResult>();
    void ready.catch(() => undefined);
    const turn: MutableTurn = {
      id,
      state: 'queued',
      signal: controller.signal,
      ready,
      result,
      cancel: (reason) => {
        if (this.active?.turn === turn) {
          return this.cancelActiveTurn(undefined, reason ?? userCancellationReason());
        }
        return true;
      },
    };
    const active: ActiveTurn = {
      id,
      prompt,
      controller,
      steerController: new AbortController(),
      turn,
      ready,
      result,
      startedAt: Date.now(),
      steps: 0,
      gatedSteps: 0,
      nudgeCursor: this.nudgeCursor,
      current: undefined,
      interruptStep: undefined,
      failedStep: undefined,
      stopRequested: false,
      toolStopRequested: false,
      forcedStopReason: undefined,
      lastStopReason: undefined,
      filtered: false,
      maxStepsError: undefined,
      abortReason: undefined,
      retryRequested: false,
      afterChain: Promise.resolve(),
      partials: [],
      forceContentPartBoundary: false,
      readyResolved: false,
      mode: undefined,
      providerType: undefined,
      protocol: undefined,
    };
    this.active = active;
    active.readyResolved = true;
    ready.resolve();
    active.mode = this.telemetry.getContext().mode;
    const { provider_type, protocol } = this.telemetry.getContext();
    active.providerType = provider_type;
    active.protocol = protocol;
    this.telemetry.setContext({ turn_id: id });
    const thinkingEffort = this.llmRequester.prepareTurnConfig(id)?.thinkingEffort;
    this.telemetry.setContext({ thinking_effort: thinkingEffort });
    void this.dispatcher.dispatch(
      new TurnPrompt({
        agentId: this.scopeContext.agentId,
        input: prompt.message.content,
        origin: prompt.origin,
        promptId: prompt.promptId,
        turnId: id,
      }),
    );
    turn.state = 'running';
    void this.dispatcher.dispatch(
      new TurnStarted({
        agentId: this.scopeContext.agentId,
        turnId: id,
        promptId: prompt.promptId,
        origin: prompt.origin,
        prompt: isDisplayablePromptOrigin(prompt.origin)
          ? turnPromptText(prompt.message.content, prompt.origin)
          : undefined,
        promptAttachments: turnPromptAttachments(prompt.message.content, prompt.origin),
      }),
    );
    const started: TurnStartedTelemetryEvent = {
      turn_id: id,
      mode: active.mode ?? 'agent',
      provider_type,
      protocol,
    };
    this.telemetry.track2('turn_started', started);
    return active;
  }

  private materializeMessage(message: ContextMessage): void {
    if (message.content.length === 0) return;
    this.context.append(message);
  }

  private consumeDrainedNudges(): { readonly live: number; readonly bypass: boolean } {
    const engine = this.engine;
    if (engine === undefined) return { live: 0, bypass: false };
    const notificationCount = engine.snapshot().notificationCount;
    let consumed = this.nudges.length - this.nudgeCursor - notificationCount;
    let live = 0;
    let bypass = false;
    while (consumed > 0 && this.nudgeCursor < this.nudges.length) {
      const nudge = this.nudges[this.nudgeCursor]!;
      this.nudgeCursor += 1;
      consumed -= 1;
      if (nudge.dropped) continue;
      live += 1;
      bypass = bypass || nudge.bypassMaxSteps;
      nudge.consumed = true;
      if (nudge.contextMessage !== undefined && nudge.contextMessage.content.length > 0) {
        this.materializeMessage(nudge.contextMessage);
        if (nudge.promptIds !== undefined && nudge.promptIds.length > 0) {
          void this.dispatcher.dispatch(
            new TurnSteer({
              agentId: this.scopeContext.agentId,
              input: nudge.contextMessage.content,
              origin: nudge.contextMessage.origin ?? { kind: 'user' },
              messageId: nudge.contextMessage.id,
              promptIds: [...nudge.promptIds],
              turnId: this.active?.id,
            }),
          );
        }
      }
      nudge.onConsume?.();
    }
    return { live, bypass };
  }

  private mirrorConsumedNudges(turn: ActiveTurn): { readonly live: number; readonly bypass: boolean } {
    const consumed = this.consumeDrainedNudges();
    turn.nudgeCursor = this.nudgeCursor;
    return consumed;
  }

  private projectMachineEvent(event: MachineEngineEvent): void {
    switch (event.type) {
      case 'turnStarted': {
        this.pendingMachineTurn = {
          id: event.machineTurnId,
          queueItemId: event.queueItemId,
          entry: event.entry,
        };
        this.machineTurnSuppressed = false;
        return;
      }
      case 'promptBlocked': {
        this.settleGateRejectedPrompt(event.queueItemId, event.entry, 'blocked');
        return;
      }
      case 'promptGateFailed': {
        this.settleGateRejectedPrompt(event.queueItemId, event.entry, 'failed');
        return;
      }
      case 'promptSteered': {
        const active = this.active;
        if (active === undefined) return;
        const children: { readonly waiter: PromptWaiter; readonly projection: SteeredPrompt }[] = [];
        for (const entry of event.entries) {
          const id = entry.meta?.promptId;
          if (id === undefined) continue;
          const waiter = this.promptWaiters.get(id);
          if (waiter === undefined) continue;
          const origin = (entry.meta?.origin as PromptOrigin | undefined) ?? { kind: 'user' };
          children.push({
            waiter,
            projection: {
              parentId: active.prompt.id,
              tracked: entry.meta?.tracked === true,
              origin,
              message: {
                role: 'user',
                content: [...entry.message.content],
                id,
                toolCalls: [],
                origin: entry.meta?.origin as PromptOrigin | undefined,
              },
              userMessageId: entry.meta?.userMessageId ?? '',
              createdAt: entry.meta?.createdAt ?? '',
            },
          });
        }
        if (children.length === 0) return;
        for (const { waiter, projection } of children) {
          this.steered.set(waiter.id, projection);
          waiter.launched.resolve(active.turn);
        }
        active.steerController.abort(abortError('Steered by new input'));
        const merged =
          children.length === 1
            ? {
                content: children[0]!.projection.message.content,
                origin: children[0]!.projection.origin,
              }
            : mergeSteerMessages(
                children.map((child) => ({
                  content: child.projection.message.content,
                  origin: child.projection.origin,
                })),
              );
        const gatedContent = gateImageFormatParts(
          merged.content,
          this.profile.getModelProviderType(),
        );
        const messageId = newMessageId();
        const promptIds = children.map((child) => child.waiter.id);
        this.nudges.push({
          contextMessage: {
            role: 'user',
            content: gatedContent,
            toolCalls: [],
            origin: merged.origin,
            id: messageId,
          },
          promptIds,
          bypassMaxSteps: false,
          turnScoped: false,
          sentToMachine: true,
        });
        void this.dispatcher.dispatch(
          new PromptSteered({
            agentId: this.scopeContext.agentId,
            activePromptId: active.prompt.id,
            promptIds,
            messageId,
            content: children.flatMap((child) =>
              stripBundledSkillBlocks(child.projection.message),
            ),
            steeredAt: new Date().toISOString(),
          }),
        );
        return;
      }
      case 'turnSettled': {
        const outcome = event;
        const active = this.active;
        if (this.machineTurnSuppressed) {
          this.machineTurnSuppressed = false;
          this.maybeSettle();
          return;
        }
        if (this.pendingMachineTurn !== undefined) {
          const pending = this.pendingMachineTurn;
          this.pendingMachineTurn = undefined;
          this.machineTurnSuppressed = false;
          this.settleUnboundRecord(pending, outcome);
          this.maybeSettle();
          return;
        }
        if (active === undefined) return;
        active.afterChain = active.afterChain.then(() => this.evaluateSettle(active, outcome));
        return;
      }
      case 'stepStarted': {
        const turn = this.active;
        const step = turn?.current;
        if (turn === undefined || step === undefined) return;
        if (!turn.readyResolved) {
          turn.readyResolved = true;
          turn.ready.resolve();
        }
        void this.dispatcher.dispatch(
          new TurnStepStarted({
            agentId: this.scopeContext.agentId,
            turnId: turn.id,
            step: step.number,
            stepId: step.uuid,
          }),
        );
        this.context.appendLoopEvent({
          type: 'step.begin',
          uuid: step.uuid,
          turnId: String(turn.id),
          step: step.number,
        });
        turn.partials = [];
        turn.forceContentPartBoundary = false;
        return;
      }
      case 'delta': {
        const turn = this.active;
        if (turn === undefined) return;
        const delta = event.delta;
        switch (delta.kind) {
          case 'assistant':
            this.accumulateMachinePart(turn, { type: 'text', text: delta.delta });
            void this.dispatcher.dispatch(
              new AssistantDelta({ agentId: this.scopeContext.agentId, turnId: turn.id, delta: delta.delta }),
            );
            return;
          case 'thinking': {
            const part = this.accumulateMachinePart(turn, {
              type: 'think',
              think: delta.delta,
              encrypted: delta.encrypted,
              detailsIndex: delta.detailsIndex,
              hidden: delta.hidden,
            });
            if (part?.type === 'think' && part.hidden === true) return;
            void this.dispatcher.dispatch(
              new ThinkingDelta({ agentId: this.scopeContext.agentId, turnId: turn.id, delta: delta.delta }),
            );
            return;
          }
          case 'toolCall':
            if (delta.started === true) turn.forceContentPartBoundary = true;
            void this.dispatcher.dispatch(
              new ToolCallDelta({
                agentId: this.scopeContext.agentId,
                turnId: turn.id,
                toolCallId: delta.toolCallId,
                name: delta.name,
                argumentsPart: delta.argumentsPart,
              }),
            );
            return;
        }
        return;
      }
      case 'stepCompleted': {
        const turn = this.active;
        const step = turn?.current;
        if (turn === undefined || step === undefined) return;
        step.entry = event.entry;
        step.usage = event.usage;
        step.timing = event.timing;
        step.providerFinishReason = event.finish?.finishReason ?? undefined;
        step.rawFinishReason = event.finish?.rawFinishReason ?? undefined;
        step.messageId = event.messageId;
        for (const part of event.entry.message.content) {
          this.context.appendLoopEvent({
            type: 'content.part',
            uuid: randomUUID(),
            turnId: String(turn.id),
            step: step.number,
            stepUuid: step.uuid,
            part,
          });
        }
        step.contentAppended = true;
        this.lastRequestTraceId = this.activeRequestTrace?.traceId;
        const toolCalls = event.entry.message.toolCalls;
        if (toolCalls.length === 0) {
          const finishReason = step.providerFinishReason ?? 'completed';
          this.endOrInterruptMachineStep(turn, step, finishReason === 'tool_calls' ? 'other' : finishReason);
        } else {
          step.pendingToolIds = new Set(toolCalls.map((call) => call.id));
        }
        return;
      }
      case 'toolStarted': {
        const turn = this.active;
        const step = turn?.current;
        if (turn === undefined || step === undefined) return;
        const callUuid = randomUUID();
        step.toolCallUuids.set(event.toolCallId, callUuid);
        const extras = step.entry?.message.toolCalls.find((call) => call.id === event.toolCallId)?.extras;
        this.context.appendLoopEvent({
          type: 'tool.call',
          uuid: callUuid,
          turnId: String(turn.id),
          step: step.number,
          stepUuid: step.uuid,
          toolCallId: event.toolCallId,
          name: event.name,
          args: event.args,
          extras,
          display: event.display,
        });
        return;
      }
      case 'toolDone': {
        const turn = this.active;
        const step = turn?.current;
        if (turn === undefined || step === undefined) return;
        step.pendingToolIds.delete(event.toolCallId);
        if (this.isCannedUnknownToolResult(step, event.toolCallId, event.result)) {
          turn.afterChain = turn.afterChain.then(async () => {
            await this.executeUnknownToolCall(turn, step, event.toolCallId);
            if (turn.current === step && step.pendingToolIds.size === 0) {
              this.endOrInterruptMachineStep(turn, step, step.toolStopTurn ? 'completed' : 'tool_calls');
            }
          });
          return;
        }
        if (step.pendingToolIds.size === 0) {
          this.endOrInterruptMachineStep(turn, step, step.toolStopTurn ? 'completed' : 'tool_calls');
        }
        return;
      }
      case 'toolFailed': {
        const turn = this.active;
        const step = turn?.current;
        if (turn === undefined || step === undefined) return;
        const message = event.error instanceof Error ? event.error.message : String(event.error);
        this.context.appendLoopEvent({
          type: 'tool.result',
          parentUuid: step.toolCallUuids.get(event.toolCallId) ?? randomUUID(),
          toolCallId: event.toolCallId,
          result: { output: message, isError: true },
        });
        step.resolvedToolIds.add(event.toolCallId);
        step.pendingToolIds.delete(event.toolCallId);
        if (step.pendingToolIds.size === 0) {
          this.endOrInterruptMachineStep(turn, step, step.toolStopTurn ? 'completed' : 'tool_calls');
        }
        return;
      }
      case 'toolBatchFailed': {
        const turn = this.active;
        const step = turn?.current;
        if (turn === undefined || step === undefined) return;
        if (step.signal.aborted) return;
        this.closeFailedMachineStep(turn, step, 'error');
        turn.failedStep ??= {
          number: step.number,
          uuid: step.uuid,
          error: event.error,
        };
        turn.current = undefined;
        this.machineEngine().abort();
        return;
      }
      case 'recovering': {
        const turn = this.active;
        const step = turn?.current;
        if (turn === undefined) return;
        if (step !== undefined) {
          this.closeFailedMachineStep(turn, step, 'error');
        }
        turn.current = undefined;
        return;
      }
      case 'retrying': {
        const turn = this.active;
        const step = turn?.current;
        if (turn === undefined) return;
        if (step !== undefined) {
          this.closeFailedMachineStep(turn, step, 'error');
        }
        const fields =
          event.rawError !== undefined
            ? retryErrorFields(event.rawError)
            : {
                errorName: event.errorName,
                errorMessage: event.errorMessage,
                statusCode: event.statusCode,
              };
        void this.dispatcher.dispatch(
          new TurnStepRetrying({
            agentId: this.scopeContext.agentId,
            turnId: turn.id,
            step: step?.number ?? turn.gatedSteps,
            stepId: step?.uuid,
            failedAttempt: event.failedAttempt,
            nextAttempt: event.nextAttempt,
            maxAttempts: event.maxAttempts,
            delayMs: event.delayMs,
            errorName: fields.errorName,
            errorMessage: fields.errorMessage,
            statusCode: fields.statusCode,
          }),
        );
        turn.current = undefined;
        return;
      }
      case 'stepFailed': {
        const turn = this.active;
        const step = turn?.current;
        if (turn === undefined || step === undefined) return;
        this.closeFailedMachineStep(turn, step, step.signal.aborted ? 'interrupted' : 'error');
        turn.failedStep ??= {
          number: step.number,
          uuid: step.uuid,
          error: event.rawError ?? event.error,
        };
        turn.current = undefined;
        return;
      }
      default:
        return;
    }
  }

  private isCannedUnknownToolResult(
    step: MachineStepState,
    toolCallId: string,
    result: { readonly content: readonly ContentPart[]; readonly isError?: boolean },
  ): boolean {
    if (step.toolCallUuids.has(toolCallId)) return false;
    if (result.isError !== true || result.content.length !== 1) return false;
    const part = result.content[0];
    const call = step.entry?.message.toolCalls.find((entry) => entry.id === toolCallId);
    return (
      part !== undefined &&
      part.type === 'text' &&
      call !== undefined &&
      part.text === `unknown tool: ${call.name}`
    );
  }

  private async executeUnknownToolCall(
    turn: ActiveTurn,
    step: MachineStepState,
    toolCallId: string,
  ): Promise<void> {
    const call = step.entry?.message.toolCalls.find((entry) => entry.id === toolCallId);
    if (call === undefined) return;
    try {
      for await (const result of this.toolExecutor.execute([call], {
        signal: turn.controller.signal,
        turnId: turn.id,
        trace: this.activeRequestTrace,
        onToolCall: (payload) => {
          const callUuid = randomUUID();
          step.toolCallUuids.set(payload.toolCallId, callUuid);
          const extras = step.entry?.message.toolCalls.find(
            (entry) => entry.id === payload.toolCallId,
          )?.extras;
          this.context.appendLoopEvent({
            type: 'tool.call',
            uuid: callUuid,
            turnId: String(turn.id),
            step: step.number,
            stepUuid: step.uuid,
            toolCallId: payload.toolCallId,
            name: payload.name,
            args: payload.args,
            extras,
          });
        },
      })) {
        if (result.toolCallId === toolCallId) {
          this.appendMachineToolResult(toolCallId, result.result);
        }
      }
    } catch (error) {
      if (this.active !== turn || turn.current !== step || step.signal.aborted) return;
      this.closeFailedMachineStep(turn, step, 'error');
      turn.failedStep ??= {
        number: step.number,
        uuid: step.uuid,
        error,
      };
      turn.current = undefined;
      this.machineEngine().abort();
    }
  }

  private accumulateMachinePart(turn: ActiveTurn, part: ContentPart): ContentPart | undefined {
    const last = turn.partials.at(-1);
    if (part.type === 'think' && last?.type === 'text' && isVacuousContentPart(part)) return undefined;
    if (!turn.forceContentPartBoundary && last !== undefined && mergeInPlace(last, part)) return last;
    turn.forceContentPartBoundary = false;
    turn.partials.push({ ...part });
    return turn.partials.at(-1);
  }

  private appendMachineToolResult(
    toolCallId: string,
    result: {
      readonly output: string | ContentPart[];
      readonly isError?: boolean;
      readonly note?: string;
      readonly stopTurn?: boolean;
      readonly stopTurnReason?: string;
    },
  ): void {
    const turn = this.active;
    const step = turn?.current;
    if (turn === undefined || step === undefined) return;
    this.context.appendLoopEvent({
      type: 'tool.result',
      parentUuid: step.toolCallUuids.get(toolCallId) ?? randomUUID(),
      toolCallId,
      result: { output: result.output, isError: result.isError, note: result.note },
    });
    step.resolvedToolIds.add(toolCallId);
    if (result.stopTurn === true) {
      step.toolStopTurn = true;
      turn.toolStopRequested = true;
      turn.forcedStopReason ??= result.stopTurnReason;
    }
  }

  private drainMachinePartials(turn: ActiveTurn, step: MachineStepState): void {
    const drained = turn.partials.splice(0).filter((entry) => !isVacuousContentPart(entry));
    let lastCompleteThink = -1;
    for (const [index, part] of drained.entries()) {
      if (part.type === 'think' && part.encrypted !== undefined) {
        lastCompleteThink = index;
      }
    }
    for (const part of drained.filter(
      (part, index) => part.type !== 'think' || index <= lastCompleteThink,
    )) {
      this.context.appendLoopEvent({
        type: 'content.part',
        uuid: randomUUID(),
        turnId: String(turn.id),
        step: step.number,
        stepUuid: step.uuid,
        part,
      });
    }
  }

  private closeFailedMachineStep(
    turn: ActiveTurn,
    step: MachineStepState,
    finishReason: 'error' | 'interrupted',
  ): void {
    if (!step.contentAppended) this.drainMachinePartials(turn, step);
    this.context.appendLoopEvent({
      type: 'step.end',
      uuid: step.uuid,
      turnId: String(turn.id),
      step: step.number,
      finishReason,
    });
  }

  private endOrInterruptMachineStep(
    turn: ActiveTurn,
    step: MachineStepState,
    finishReason: FinishReason,
  ): void {
    if (turn.controller.signal.aborted) {
      this.context.appendLoopEvent({
        type: 'step.end',
        uuid: step.uuid,
        turnId: String(turn.id),
        step: step.number,
        finishReason: 'interrupted',
      });
      turn.current = undefined;
      return;
    }
    this.endMachineStep(turn, step, finishReason);
  }

  private endMachineStep(turn: ActiveTurn, step: MachineStepState, finishReason: FinishReason): void {
    const normalized = normalizeFinishReason(finishReason);
    const usage = step.usage ?? emptyUsage();
    turn.lastStopReason = finishReason;
    turn.current = undefined;
    const firstStepOfTurn = step.number === 1;
    turn.afterChain = turn.afterChain.then(async () => {
      this.finishMachineStepProjection(turn, step, normalized, usage);
      await this.runMachineAfterStep(turn, step, firstStepOfTurn, usage, finishReason);
    });
  }

  private finishMachineStepProjection(
    turn: ActiveTurn,
    step: MachineStepState,
    normalized: string,
    usage: TokenUsage,
  ): void {
    this.context.appendLoopEvent({
      type: 'step.end',
      uuid: step.uuid,
      turnId: String(turn.id),
      step: step.number,
      finishReason: normalized,
      usage,
      llmFirstTokenLatencyMs: step.timing?.firstTokenLatencyMs,
      llmStreamDurationMs: step.timing?.streamDurationMs,
      llmRequestBuildMs: step.timing?.requestBuildMs,
      llmServerFirstTokenMs: step.timing?.serverFirstTokenMs,
      llmServerDecodeMs: step.timing?.serverDecodeMs,
      llmClientConsumeMs: step.timing?.clientConsumeMs,
      llmClientBlockedMs: step.timing?.clientBlockedMs,
      messageId: step.messageId,
      providerFinishReason: step.providerFinishReason,
      rawFinishReason: step.rawFinishReason,
    });
    void this.dispatcher.dispatch(
      new TurnStepCompleted({
        agentId: this.scopeContext.agentId,
        turnId: turn.id,
        step: step.number,
        stepId: step.uuid,
        usage,
        finishReason: normalized,
        llmFirstTokenLatencyMs: step.timing?.firstTokenLatencyMs,
        llmStreamDurationMs: step.timing?.streamDurationMs,
        llmRequestBuildMs: step.timing?.requestBuildMs,
        llmServerFirstTokenMs: step.timing?.serverFirstTokenMs,
        llmServerDecodeMs: step.timing?.serverDecodeMs,
        llmClientConsumeMs: step.timing?.clientConsumeMs,
        llmClientBlockedMs: step.timing?.clientBlockedMs,
        providerFinishReason: step.providerFinishReason,
        rawFinishReason: step.rawFinishReason,
      }),
    );
  }

  private async runMachineAfterStep(
    turn: ActiveTurn,
    step: MachineStepState,
    firstStepOfTurn: boolean,
    usage: TokenUsage,
    finishReason: FinishReason,
  ): Promise<void> {
    const context: AfterStepContext = {
      turnId: turn.id,
      step: step.number,
      firstStepOfTurn,
      signal: step.signal,
      usage,
      finishReason,
      stopTurn: false,
    };
    try {
      await this.hooks.onDidFinishStep.run(context);
    } catch (error) {
      if (isAbortError(error) || step.signal.aborted) {
        turn.abortReason = turn.controller.signal.aborted
          ? turn.controller.signal.reason
          : error;
        return;
      }
    }
    turn.interruptStep = undefined;
    if (context.stopTurn) turn.stopRequested = true;
    if (finishReason === 'filtered') turn.filtered = true;
  }

  private async evaluateSettle(
    turn: ActiveTurn,
    outcome: { readonly outcome: MachineTurnOutcome; readonly error?: unknown },
  ): Promise<void> {
    if (this.active !== turn) return;
    if (
      turn.failedStep !== undefined &&
      turn.abortReason === undefined &&
      !turn.controller.signal.aborted
    ) {
      await this.recoverOrFailMachineRun(turn);
      return;
    }
    if (turn.abortReason !== undefined || turn.controller.signal.aborted || outcome.outcome === 'aborted') {
      const reason =
        turn.abortReason ??
        (turn.controller.signal.aborted ? turn.controller.signal.reason : undefined) ??
        abortError('Turn aborted');
      this.interruptMachineRunForCancel(turn, reason);
      await this.endTurn(turn, { type: 'cancelled', steps: turn.steps, reason });
      return;
    }
    if (turn.filtered) {
      await this.endTurn(turn, {
        type: 'failed',
        steps: turn.steps,
        error: new Error2(ErrorCodes.PROVIDER_FILTERED, 'Provider safety policy blocked the response.', {
          name: 'ProviderFilteredError',
          details: { finishReason: 'filtered' },
        }),
      });
      return;
    }
    if (turn.maxStepsError !== undefined) {
      await this.endTurn(turn, { type: 'failed', steps: turn.steps, error: turn.maxStepsError });
      return;
    }
    if (turn.stopRequested) {
      await this.endTurn(turn, this.machineCompletedResult(turn));
      return;
    }
    if (this.hasLiveNudge()) {
      return;
    }
    if (turn.toolStopRequested) {
      await this.endTurn(turn, this.machineCompletedResult(turn));
      return;
    }
    if (outcome.outcome === 'failed') {
      const error = outcome.error ?? new Error('Turn failed');
      this.emitStepInterrupted(turn.id, turn.interruptStep, 'error', toErrorMessage(error));
      await this.endTurn(turn, { type: 'failed', steps: turn.steps, error });
      return;
    }
    await this.endTurn(turn, this.machineCompletedResult(turn));
  }

  private hasLiveNudge(): boolean {
    return this.nudges.slice(this.nudgeCursor).some((nudge) => !nudge.dropped);
  }

  private async recoverOrFailMachineRun(turn: ActiveTurn): Promise<void> {
    const failure = turn.failedStep!;
    turn.failedStep = undefined;
    const context: LoopErrorContext = {
      turnId: turn.id,
      step: failure.number,
      stepId: failure.uuid,
      signal: turn.controller.signal,
      error: failure.error,
      retry: () => {
        turn.retryRequested = true;
      },
    };
    const handler = this.errorHandlers.find((entry) => entry.match(context));
    if (handler !== undefined) {
      try {
        if (await handler.handle(context)) {
          turn.interruptStep = undefined;
          if (turn.retryRequested) {
            turn.retryRequested = false;
            await this.machineEngine().resetHistory(historyFromContext(this.context.get()));
            this.machineEngine().notify(createUserEntry(EMPTY_MACHINE_PROMPT));
          }
          return;
        }
      } catch (handlerError) {
        if (isAbortError(handlerError) || turn.controller.signal.aborted) {
          const reason = turn.controller.signal.aborted ? turn.controller.signal.reason : handlerError;
          this.interruptMachineRunForCancel(turn, reason);
          await this.endTurn(turn, { type: 'cancelled', steps: turn.steps, reason });
          return;
        }
        this.emitStepInterrupted(turn.id, failure.number, 'error', toErrorMessage(handlerError));
        await this.endTurn(turn, { type: 'failed', steps: turn.steps, error: handlerError });
        return;
      }
    }
    this.failMachineStep(turn, failure.number, failure.error);
    await this.endTurn(turn, { type: 'failed', steps: turn.steps, error: failure.error });
  }

  private failMachineStep(turn: ActiveTurn, step: number | undefined, error: unknown): void {
    const reason: LoopInterruptReason = isMaxStepsExceededError(error) ? 'max_steps' : 'error';
    const interruptedError =
      isError2(error) && error.code === ErrorCodes.INTERNAL && error.cause !== undefined ? error.cause : error;
    this.emitStepInterrupted(turn.id, step, reason, toErrorMessage(interruptedError));
  }

  private backfillAbortedToolResults(step: MachineStepState, reason: unknown): void {
    for (const toolCallId of step.pendingToolIds) {
      if (step.resolvedToolIds.has(toolCallId)) continue;
      const name =
        step.entry?.message.toolCalls.find((call) => call.id === toolCallId)?.name ?? toolCallId;
      this.context.appendLoopEvent({
        type: 'tool.result',
        parentUuid: step.toolCallUuids.get(toolCallId) ?? randomUUID(),
        toolCallId,
        result: { output: abortedToolOutput(name, reason), isError: true },
      });
      step.resolvedToolIds.add(toolCallId);
    }
  }

  private interruptMachineRunForCancel(turn: ActiveTurn, reason: unknown): void {
    const current = turn.current;
    if (current !== undefined) {
      this.backfillAbortedToolResults(current, reason);
      if (!current.contentAppended) this.drainMachinePartials(turn, current);
      this.context.appendLoopEvent({
        type: 'step.end',
        uuid: current.uuid,
        turnId: String(turn.id),
        step: current.number,
        finishReason: 'interrupted',
      });
      turn.current = undefined;
    }
    if (turn.interruptStep !== undefined) {
      this.emitStepInterrupted(
        turn.id,
        turn.interruptStep,
        'aborted',
        isUserCancellation(reason) ? undefined : toErrorMessage(reason),
      );
      turn.interruptStep = undefined;
    }
  }

  private machineCompletedResult(turn: ActiveTurn): LoopRunResult {
    const truncated = turn.lastStopReason === 'truncated';
    return {
      type: 'completed',
      steps: turn.steps,
      truncated,
      stopReason: turn.forcedStopReason,
    };
  }

  private async endTurn(turn: ActiveTurn, result: TurnResult): Promise<void> {
    if (this.active !== turn) return;
    this.active = undefined;
    await this.wire.drainPersisted().catch(() => undefined);
    for (const nudge of this.nudges.slice(this.nudgeCursor)) {
      if (nudge.turnScoped && !nudge.dropped) {
        nudge.dropped = true;
        nudge.onDrop?.();
      }
    }
    turn.turn.state = result.type;
    if (!turn.readyResolved) {
      if (result.type === 'failed') {
        turn.ready.reject(result.error);
      } else if (result.type === 'cancelled') {
        turn.ready.reject(
          result.reason instanceof Error ? result.reason : abortError('Turn cancelled'),
        );
      } else {
        turn.ready.reject(new Error2(ErrorCodes.INTERNAL, 'Turn ended before first step'));
      }
    }
    const durationMs = Date.now() - turn.startedAt;
    const traceId =
      result.type === 'completed' ? this.lastRequestTraceId : this.activeRequestTrace?.traceId;
    const error = result.type === 'failed' ? toKimiErrorPayload(result.error) : undefined;
    const interruptReason = result.type === 'completed' ? undefined : interruptReasonFor(result);
    void this.dispatcher.dispatch(
      new TurnEnded({
        agentId: this.scopeContext.agentId,
        turnId: turn.id,
        reason: result.type,
        error,
        durationMs,
        interruptReason,
        stopReason: result.type === 'completed' ? result.stopReason : undefined,
      }),
    );
    if (error !== undefined) {
      void this.dispatcher.dispatch(
        new AgentErrorEvent({ ...error, agentId: this.scopeContext.agentId }),
      );
    }
    if (interruptReason !== undefined) {
      const interrupted: TurnInterruptedEvent = {
        turn_id: turn.id,
        at_step: result.steps,
        mode: turn.mode ?? 'agent',
        interrupt_reason: interruptReason,
        provider_type: turn.providerType,
        protocol: turn.protocol,
        trace_id: traceId,
      };
      this.telemetry.track2('turn_interrupted', interrupted);
    }
    const ended: TurnEndedTelemetryEvent = {
      turn_id: turn.id,
      reason: result.type,
      duration_ms: durationMs,
      mode: turn.mode ?? 'agent',
      error_type: error?.code,
      provider_type: turn.providerType,
      protocol: turn.protocol,
      trace_id: traceId,
    };
    this.telemetry.track2('turn_ended', ended);
    this.telemetry.setContext({ turn_id: undefined, trace_id: undefined, thinking_effort: undefined });
    this.activeRequestTrace = undefined;
    this.lastRequestTraceId = undefined;
    turn.result.resolve(result);
    this.maybeSettle();
  }

  private emitStepInterrupted(
    turnId: number,
    activeStep: number | undefined,
    reason: LoopInterruptReason,
    message?: string,
  ): void {
    if (activeStep === undefined) return;
    void this.dispatcher.dispatch(
      new TurnStepInterrupted({
        agentId: this.scopeContext.agentId,
        turnId,
        step: activeStep,
        reason,
        message,
      }),
    );
  }
}

type MachineGateDecision =
  | { readonly type: 'proceed'; readonly signal: AbortSignal; readonly step: number }
  | { readonly type: 'fail' };

function normalizeFinishReason(reason: FinishReason): string {
  if (reason === 'tool_calls') return 'tool_use';
  if (reason === 'completed') return 'end_turn';
  if (reason === 'truncated') return 'max_tokens';
  return reason;
}

function machineUserMessage(message: ContextMessage | undefined): UserMessage {
  if (message === undefined) return EMPTY_MACHINE_PROMPT;
  return { role: 'user', content: [...message.content] };
}

type MutableTurn = {
  -readonly [K in keyof Turn]: Turn[K];
};

interface PromptWaiter {
  readonly id: string;
  readonly dispatchPromptId?: string;
  readonly launched: ReturnType<typeof createControlledPromise<Turn | undefined>>;
  readonly completion: ReturnType<typeof createControlledPromise<PromptCompletion>>;
  readonly onMaterialize?: () => void;
  failedEntry?: UserEntry;
}

interface PromptProjection {
  readonly tracked: boolean;
  readonly origin: PromptOrigin;
  readonly message: ContextMessage;
  readonly userMessageId: string;
  readonly createdAt: string;
}

interface ActivePrompt extends PromptProjection {
  readonly id: string;
  readonly promptId?: string;
}

interface SteeredPrompt extends PromptProjection {
  readonly parentId: string;
}

const EMPTY_HANDLE_MESSAGE: ContextMessage = {
  role: 'user',
  content: [],
  toolCalls: [],
};

function projectionFromEntry(entry: UserEntry): PromptProjection {
  const origin = (entry.meta?.origin as PromptOrigin | undefined) ?? { kind: 'user' };
  return {
    tracked: entry.meta?.tracked === true,
    origin,
    message: {
      role: 'user',
      content: [...entry.message.content],
      id: entry.meta?.promptId,
      toolCalls: [],
      origin: entry.meta?.origin as PromptOrigin | undefined,
    },
    userMessageId: entry.meta?.userMessageId ?? '',
    createdAt: entry.meta?.createdAt ?? '',
  };
}

interface Nudge {
  readonly contextMessage?: ContextMessage;
  readonly promptIds?: readonly string[];
  readonly bypassMaxSteps: boolean;
  readonly turnScoped: boolean;
  readonly onConsume?: () => void;
  readonly onDrop?: () => void;
  dropped?: boolean;
  consumed?: boolean;
  sentToMachine?: boolean;
}

type MachineStepEntry = Extract<MachineEngineEvent, { readonly type: 'stepCompleted' }>['entry'];

interface MachineStepState {
  readonly number: number;
  readonly uuid: string;
  readonly signal: AbortSignal;
  contentAppended: boolean;
  entry: MachineStepEntry | undefined;
  usage: TokenUsage | undefined;
  timing: ModelRequestTiming | undefined;
  providerFinishReason: FinishReason | undefined;
  rawFinishReason: string | undefined;
  messageId: string | undefined;
  pendingToolIds: Set<string>;
  toolCallUuids: Map<string, string>;
  resolvedToolIds: Set<string>;
  toolStopTurn: boolean;
}

interface MachineFailedStep {
  readonly number: number;
  readonly uuid: string;
  readonly error: unknown;
}

interface ActiveTurn {
  readonly id: number;
  readonly prompt: ActivePrompt;
  readonly controller: AbortController;
  steerController: AbortController;
  readonly turn: MutableTurn;
  readonly ready: ReturnType<typeof createControlledPromise<void>>;
  readonly result: ReturnType<typeof createControlledPromise<TurnResult>>;
  readonly startedAt: number;
  steps: number;
  gatedSteps: number;
  nudgeCursor: number;
  current: MachineStepState | undefined;
  interruptStep: number | undefined;
  failedStep: MachineFailedStep | undefined;
  stopRequested: boolean;
  toolStopRequested: boolean;
  forcedStopReason: string | undefined;
  lastStopReason: FinishReason | undefined;
  filtered: boolean;
  maxStepsError: LoopError | undefined;
  abortReason: unknown;
  retryRequested: boolean;
  afterChain: Promise<void>;
  partials: ContentPart[];
  forceContentPartBoundary: boolean;
  readyResolved: boolean;
  mode: 'agent' | 'plan' | undefined;
  providerType: string | undefined;
  protocol: string | undefined;
}

function cancelReasonFor(cancellation: unknown): 'user_cancelled' | 'aborted' {
  return isUserCancellation(cancellation) ? 'user_cancelled' : 'aborted';
}

function interruptReasonFor(
  result: Extract<TurnResult, { readonly type: 'cancelled' | 'failed' }>,
): TurnInterruptReason {
  if (result.type === 'cancelled') {
    return isUserCancellation(result.reason) ? 'user_cancelled' : 'aborted';
  }
  if (isMaxStepsExceededError(result.error)) return 'max_steps';
  if (isError2(result.error) && result.error.code === ErrorCodes.PROVIDER_FILTERED) {
    return 'filtered';
  }
  return 'error';
}

registerScopedService(
  LifecycleScope.Agent,
  IAgentLoopService,
  AgentLoopService,
  ScopeActivation.OnScopeCreated,
  'loop',
);

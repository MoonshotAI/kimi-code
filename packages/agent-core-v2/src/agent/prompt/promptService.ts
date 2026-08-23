/* oxlint-disable typescript-eslint/no-unsafe-declaration-merging, eslint-plugin-import/namespace -- Event2 class+payload-interface declaration merging is the sanctioned event-declaration idiom. */
import { IInstantiationService } from '#/_base/di/instantiation';
import { LifecycleScope } from '#/app/scopes';
import { ScopeActivation, registerScopedService } from '#/_base/di/scope';
import { defineState } from '#/state/state';
import { extractImageCompressionCaptions } from '#/agent/media/image-compress';
import { userCancellationReason } from '#/_base/utils/abort';
import { IAgentContextMemoryService } from '#/agent/contextMemory/contextMemory';
import { newMessageId } from '#/agent/contextMemory/messageId';
import { USER_PROMPT_ORIGIN, type ContextMessage } from '#/agent/contextMemory/types';
import { IAgentFullCompactionService } from '#/agent/fullCompaction/fullCompaction';
import { IAgentLoopService, type Turn, type TurnResult } from '#/agent/loop/loop';
import { TurnSteer } from '#/agent/loop/turnOps';
import { IAgentStateService } from '#/agent/state/agentState';
import { IAgentSystemReminderService } from '#/agent/systemReminder/systemReminder';
import type { ExecutableToolResult } from '#/tool/toolContract';
import type { ToolDidExecuteContext } from '#/agent/toolExecutor/toolHooks';
import { IAgentToolExecutorService } from '#/agent/toolExecutor/toolExecutor';
import { IAgentToolPolicyService } from '#/agent/toolPolicy/toolPolicy';
import { IFileService } from '#/app/file/fileService';
import type { ContentPart } from '#/kosong/contract/message';
import { IEventService } from '#/app/event/event';
import { AgentEvent2 } from '#/app/event/event2';
import { ErrorCodes, Error2, isError2 } from '#/errors';
import { OrderedHookSlot } from '#/hooks';
import { IEventDispatcher } from '#/state/eventDispatcher';
import { IAgentScopeContext } from '#/agent/scopeContext/scopeContext';
import { ITelemetryService } from '#/app/telemetry/telemetry';
import { MAIN_AGENT_ID } from '#/session/agentLifecycle/agentLifecycle';
import { ISessionContext } from '#/session/sessionContext/sessionContext';
import { ISessionMetadata } from '#/session/sessionMetadata/sessionMetadata';
import { applyPromptMetadataUpdate } from '#/session/sessionMetadata/promptMetadata';

import {
  IAgentPromptService,
  promptAdmission,
  type PromptCompletion,
  type PromptHandle,
  type PromptInput,
  type PromptLaunchResult,
  type PromptPayload,
  type PromptQueueSnapshot,
  type PromptReservation,
  type PromptSnapshot,
  type PromptState,
  type PromptSubmitContext,
  type SteerPayload,
} from './prompt';
import { promptMetadataTextFromContentParts } from './promptMetadataText';
import { PromptStepRequest, RetryStepRequest, SteerStepRequest } from './promptStepRequests';
import { PromptAccepted, promptAdmissionKey } from './promptOps';
import { daemonFileRefFromPart } from '#/agent/media/mediaRef';
import { materializePromptDaemonRefs } from '#/agent/media/promptMediaIntake';
import { ISessionMediaStore } from '#/agent/media/sessionMediaStore';

export interface PromptCompletedPayload {
  readonly agentId: string;
  readonly promptId: string;
  readonly finishedAt: string;
  readonly reason: 'completed' | 'failed' | 'blocked';
}

export class PromptCompleted extends AgentEvent2<PromptCompletedPayload> {
  static override readonly type = 'prompt.completed';
  static override readonly observable = true;
}
export interface PromptCompleted extends PromptCompletedPayload {}

export interface PromptAbortedPayload {
  readonly agentId: string;
  readonly promptId: string;
  readonly abortedAt: string;
}

export class PromptAborted extends AgentEvent2<PromptAbortedPayload> {
  static override readonly type = 'prompt.aborted';
  static override readonly observable = true;
}
export interface PromptAborted extends PromptAbortedPayload {}

export interface PromptSteeredPayload {
  readonly agentId: string;
  readonly activePromptId: string;
  readonly promptIds: string[];
  readonly content: ContentPart[];
  readonly steeredAt: string;
}

export class PromptSteered extends AgentEvent2<PromptSteeredPayload> {
  static override readonly type = 'prompt.steered';
  static override readonly observable = true;
}
export interface PromptSteered extends PromptSteeredPayload {}

export interface PromptQueuedPayload {
  readonly agentId: string;
  readonly promptId: string;
  readonly content: ContentPart[];
  readonly queueLength: number;
}

export class PromptQueued extends AgentEvent2<PromptQueuedPayload> {
  static override readonly type = 'prompt.queued';
  static override readonly observable = true;
}
export interface PromptQueued extends PromptQueuedPayload {}

interface Deferred<T> { readonly promise: Promise<T>; resolve(value: T): void; reject(reason: unknown): void }
interface Record extends PromptSnapshot {
  state: PromptState;
  readonly launchedDeferred: Deferred<Turn | undefined>;
  readonly completionDeferred: Deferred<PromptCompletion>;
  handle: PromptHandle;
}

function bundledSkillBlockCount(message: ContextMessage): number {
  return message.origin?.kind === 'user' ? (message.origin.skillActivations?.length ?? 0) : 0;
}

function stripBundledSkillBlocks(message: ContextMessage): ContentPart[] {
  return message.content.slice(bundledSkillBlockCount(message));
}

function mergeSteerMessages(records: readonly Record[]): ContextMessage {
  const skillActivations = records.flatMap((item) =>
    item.message.origin?.kind === 'user' ? (item.message.origin.skillActivations ?? []) : [],
  );
  return {
    role: 'user',
    content: [
      ...records.flatMap((item) => item.message.content.slice(0, bundledSkillBlockCount(item.message))),
      ...records.flatMap((item) => stripBundledSkillBlocks(item.message)),
    ],
    toolCalls: [],
    origin: skillActivations.length === 0 ? USER_PROMPT_ORIGIN : { kind: 'user', skillActivations },
  };
}

export const promptLaunchingKey = defineState<boolean>('prompt.launching', () => false);

export class AgentPromptService implements IAgentPromptService {
  declare readonly _serviceBrand: undefined;
  private active: (Record & { turn: Turn }) | undefined;
  private readonly pending: Record[] = [];
  private readonly steered = new Map<string, Record[]>();
  private readonly reservedPromptIds = new Set<string>();
  private steering = 0;
  private fullCompactionService: IAgentFullCompactionService | undefined;
  readonly hooks = { onBeforeSubmitPrompt: new OrderedHookSlot<PromptSubmitContext>() };

  constructor(
    @IAgentContextMemoryService private readonly context: IAgentContextMemoryService,
    @IAgentSystemReminderService private readonly reminders: IAgentSystemReminderService,
    @IInstantiationService private readonly instantiation: IInstantiationService,
    @IAgentLoopService private readonly loop: IAgentLoopService,
    @IAgentToolExecutorService toolExecutor: IAgentToolExecutorService,
    @IAgentToolPolicyService private readonly toolPolicy: IAgentToolPolicyService,
    @IEventDispatcher private readonly dispatcher: IEventDispatcher,
    @IAgentStateService private readonly states: IAgentStateService,
    @ITelemetryService private readonly telemetry: ITelemetryService,
    @ISessionMetadata private readonly metadata: ISessionMetadata,
    @IEventService private readonly eventService: IEventService,
    @ISessionContext private readonly sessionContext: ISessionContext,
    @IAgentScopeContext private readonly scopeContext: IAgentScopeContext,
  ) {
    this.states.contributeState(promptLaunchingKey);
    this.states.contributeState(promptAdmissionKey);
    toolExecutor.hooks.onDidExecuteTool.register('prompt-service-delivery', async (ctx, next) => {
      await this.deliverToolResult(ctx);
      await next();
    });
  }

  private get launching(): boolean {
    return this.states.get(promptLaunchingKey);
  }

  private set launching(value: boolean) {
    this.states.set(promptLaunchingKey, value);
  }

  [promptAdmission](promptId?: string): PromptReservation {
    if (promptId !== undefined && promptId.length === 0) {
      throw new Error2(ErrorCodes.REQUEST_INVALID, 'prompt_id must not be empty');
    }
    const accepted = this.states.get(promptAdmissionKey);
    let id = promptId ?? newMessageId();
    while (accepted.has(id) || this.reservedPromptIds.has(id)) {
      if (promptId !== undefined) {
        throw new Error2(ErrorCodes.PROMPT_ID_CONFLICT, `prompt_id '${id}' is already in use`);
      }
      id = newMessageId();
    }
    this.reservedPromptIds.add(id);
    let submitted = false;
    return {
      id,
      submit: async (message) => {
        if (submitted) throw new Error2(ErrorCodes.REQUEST_INVALID, 'prompt reservation already submitted');
        submitted = true;
        this.reservedPromptIds.delete(id);
        await this.dispatcher.dispatch(
          new PromptAccepted({ agentId: this.scopeContext.agentId, promptId: id }),
        );
        return this.enqueue({ id, message });
      },
      dispose: () => {
        this.reservedPromptIds.delete(id);
      },
    };
  }

  async enqueue(input: PromptInput): Promise<PromptHandle> {
    const id = input.id ?? input.message.id ?? newMessageId();
    const message = { ...input.message, id };
    const launchedDeferred = deferred<Turn | undefined>();
    const completionDeferred = deferred<PromptCompletion>();
    const record = {} as Record;
    Object.assign(record, {
      id, userMessageId: id, createdAt: new Date().toISOString(), state: 'pending', message,
      launchedDeferred, completionDeferred,
    });
    record.handle = {
      get id() { return record.id; }, get userMessageId() { return record.userMessageId; },
      get createdAt() { return record.createdAt; }, get state() { return record.state; },
      get message() { return record.message; }, launched: launchedDeferred.promise,
      completion: completionDeferred.promise,
    };
    this.pending.push(record);
    if (this.active === undefined && !this.launching) {
      if (this.fullCompaction.compacting !== null && this.loop.status().state !== 'running') {
        this.publishQueued(record);
        return record.handle;
      }
      void this.startNext();
      await Promise.race([record.launchedDeferred.promise, record.completionDeferred.promise]);
    } else {
      this.publishQueued(record);
    }
    return record.handle;
  }

  async submit(payload: PromptPayload): Promise<PromptLaunchResult | undefined> {
    const reservation = this[promptAdmission](payload.promptId);
    try {
      if (payload.disabledTools !== undefined) {
        try {
          await this.toolPolicy.setSessionDisabledTools(payload.disabledTools);
        } catch (error) {
          throw new Error2(
            ErrorCodes.REQUEST_INVALID,
            error instanceof Error ? error.message : String(error),
          );
        }
      }
      await this.updatePromptMetadata(promptMetadataTextFromContentParts(payload.input));
      const handle = await reservation.submit({
        role: 'user',
        content: [...payload.input],
        toolCalls: [],
        origin: { kind: 'user' },
      });
      if (handle.state === 'pending') return undefined;
      const turn = await handle.launched;
      return turn === undefined ? undefined : { turn_id: turn.id };
    } finally {
      reservation.dispose();
    }
  }

  async submitSteer(payload: SteerPayload): Promise<PromptLaunchResult | undefined> {
    this.telemetry.track2('input_steer', { parts: payload.input.length });
    await this.updatePromptMetadata(promptMetadataTextFromContentParts(payload.input));
    const queued = await this.enqueue({ message: {
      role: 'user',
      content: [...payload.input],
      toolCalls: [],
    } });
    if (queued.state !== 'pending') {
      const turn = await queued.launched;
      return turn === undefined ? undefined : { turn_id: turn.id };
    }
    try {
      const [steered] = await this.steer([queued.id]);
      const turn = await steered?.launched;
      return turn === undefined ? undefined : { turn_id: turn.id };
    } catch (error) {
      if (isError2(error) && error.code === ErrorCodes.PROMPT_NOT_FOUND) return undefined;
      throw error;
    }
  }

  private async updatePromptMetadata(text: string | undefined): Promise<void> {
    if (this.scopeContext.agentId !== MAIN_AGENT_ID) return;
    await applyPromptMetadataUpdate(
      {
        metadata: this.metadata,
        eventService: this.eventService,
        sessionId: this.sessionContext.sessionId,
      },
      text,
    );
  }

  list(): PromptQueueSnapshot {
    return { active: this.active === undefined ? undefined : snapshot(this.active), pending: this.pending.map(snapshot) };
  }

  async steer(promptIds: readonly string[]): Promise<readonly PromptHandle[]> {
    if (promptIds.length === 0) throw new Error2(ErrorCodes.REQUEST_INVALID, 'prompt_ids must not be empty');
    if (this.active === undefined) throw new Error2(ErrorCodes.PROMPT_NOT_FOUND, 'no active prompt to steer into');
    const ids = new Set(promptIds);
    if (ids.size !== promptIds.length || this.pending.filter((item) => ids.has(item.id)).length !== ids.size) {
      throw new Error2(ErrorCodes.PROMPT_NOT_FOUND, 'one or more prompts are not pending');
    }
    const selected = this.pending.filter((item) => ids.has(item.id));
    const activeAtEntry = this.active;
    const { message: rerouted, captions } = this.extractCompressionCaptions(mergeSteerMessages(selected));
    await this.materializeDaemonRefs(rerouted);
    if (selected.some((item) => !this.pending.includes(item)) || this.active !== activeAtEntry) {
      throw new Error2(ErrorCodes.PROMPT_NOT_FOUND, 'one or more prompts are no longer pending');
    }
    this.steering++;
    const removed: { readonly item: Record; readonly index: number }[] = [];
    for (const item of selected) {
      const index = this.pending.indexOf(item);
      removed.push({ item, index });
      this.pending.splice(index, 1);
    }
    const request = new SteerStepRequest(rerouted, captions, this.reminders, (materialized) => {
      void this.dispatcher.dispatch(
        new TurnSteer({
          agentId: this.scopeContext.agentId,
          input: materialized.content,
          origin: materialized.origin ?? USER_PROMPT_ORIGIN,
        }),
      );
    }, () => {});
    let turn: Turn | undefined;
    try {
      turn = (await this.loop.enqueue(request).assigned).turn;
    } catch {
      turn = undefined;
    } finally {
      this.steering--;
    }
    if (turn === undefined || this.active !== activeAtEntry) {
      for (const { item, index } of removed.reverse()) this.pending.splice(index, 0, item);
      if (this.active === undefined) void this.startNext();
      throw new Error2(ErrorCodes.PROMPT_NOT_FOUND, 'no active turn to steer into');
    }
    for (const item of selected) { item.state = 'steered'; item.launchedDeferred.resolve(turn); }
    this.steered.set(this.active.id, [...(this.steered.get(this.active.id) ?? []), ...selected]);
    void this.dispatcher.dispatch(
      new PromptSteered({ agentId: this.scopeContext.agentId, activePromptId: this.active.id, promptIds: selected.map((x) => x.id), content: selected.flatMap((item) => stripBundledSkillBlocks(item.message)), steeredAt: new Date().toISOString() }),
    );
    return selected.map((item) => item.handle);
  }

  abort(promptId: string, reason: Error = userCancellationReason()): boolean {
    if (this.active?.id === promptId) { this.loop.cancel(this.active.turn.id, reason); return true; }
    const index = this.pending.findIndex((item) => item.id === promptId);
    if (index < 0) throw new Error2(ErrorCodes.PROMPT_NOT_FOUND, `prompt ${promptId} not found`);
    const [item] = this.pending.splice(index, 1) as [Record];
    item.state = 'cancelled'; item.launchedDeferred.resolve(undefined);
    item.completionDeferred.resolve({ promptId, result: undefined, state: 'cancelled' });
    this.publishAborted(promptId);
    return true;
  }

  async drain(reason: Error = userCancellationReason()): Promise<void> {
    for (const item of this.pending.slice()) this.abort(item.id, reason);
    if (this.active !== undefined) this.abort(this.active.id, reason);
  }

  async inject(message: ContextMessage): Promise<Turn | undefined> {
    const { message: rerouted, captions } = this.extractCompressionCaptions(message);
    await this.materializeDaemonRefs(rerouted);
    const request = new SteerStepRequest(rerouted, captions, this.reminders, (materialized) => {
      void this.dispatcher.dispatch(
        new TurnSteer({
          agentId: this.scopeContext.agentId,
          input: materialized.content,
          origin: materialized.origin ?? USER_PROMPT_ORIGIN,
        }),
      );
    }, () => {}, 'activeOrNewTurn');
    return (await this.loop.enqueue(request).assigned).turn;
  }

  async retry(): Promise<Turn | undefined> { return (await this.loop.enqueue(new RetryStepRequest()).assigned).turn; }

  clear(): void {
    for (const item of this.pending.slice()) this.abort(item.id);
    if (this.active !== undefined) this.abort(this.active.id);
    this.context.clear();
  }

  private async startNext(): Promise<void> {
    if (this.active !== undefined || this.launching || this.steering > 0) return;
    const item = this.pending.shift(); if (item === undefined) return;
    this.launching = true;
    try {
      if (this.fullCompaction.compacting !== null && this.loop.status().state !== 'running') { this.pending.unshift(item); return; }
      const { message, captions } = this.extractCompressionCaptions(item.message);
      await this.materializeDaemonRefs(message);
      if (await this.blockedByHook(message, false)) {
        this.appendPrompt(message, captions); item.state = 'blocked'; item.launchedDeferred.resolve(undefined);
        item.completionDeferred.resolve({ promptId: item.id, result: undefined, state: 'blocked' });
        this.publishCompleted(item.id, 'blocked'); return;
      }
      const turn = (await this.loop.enqueue(new PromptStepRequest(message, captions, this.reminders)).assigned).turn;
      if (turn === undefined) { this.pending.unshift(item); return; }
      item.state = 'running'; item.launchedDeferred.resolve(turn); this.active = Object.assign(item, { turn });
      void turn.result.then((result) => this.settle(item, result));
    } catch {
      item.state = 'failed';
      item.launchedDeferred.resolve(undefined);
      item.completionDeferred.resolve({ promptId: item.id, result: undefined, state: 'failed' });
      this.publishCompleted(item.id, 'failed');
    } finally {
      this.launching = false;
      if (this.active === undefined) void this.startNext();
    }
  }

  private settle(item: Record, result: TurnResult): void {
    if (this.active?.id !== item.id) return;
    this.active = undefined;
    const state = result.type === 'cancelled' ? 'cancelled' : result.type === 'failed' ? 'failed' : 'completed';
    item.state = state; item.completionDeferred.resolve({ promptId: item.id, result, state });
    for (const child of this.steered.get(item.id) ?? []) { child.state = state; child.completionDeferred.resolve({ promptId: child.id, result, state }); }
    this.steered.delete(item.id);
    if (state === 'cancelled') this.publishAborted(item.id); else this.publishCompleted(item.id, state);
    void this.startNext();
  }

  private async materializeDaemonRefs(message: ContextMessage): Promise<void> {
    if (!message.content.some((part) => daemonFileRefFromPart(part) !== undefined)) return;
    const files = this.instantiation.invokeFunction((accessor) => accessor.get(IFileService));
    const mediaStore = this.instantiation.invokeFunction((accessor) => accessor.get(ISessionMediaStore));
    await materializePromptDaemonRefs(message.content, { files, mediaStore });
  }

  private async blockedByHook(promptMessage: ContextMessage, isSteer: boolean): Promise<boolean> {
    const ctx = { promptMessage, isSteer, block: false }; await this.hooks.onBeforeSubmitPrompt.run(ctx); return ctx.block;
  }
  private get fullCompaction(): IAgentFullCompactionService {
    if (this.fullCompactionService === undefined) {
      this.fullCompactionService = this.instantiation.invokeFunction((a) => a.get(IAgentFullCompactionService));
      this.fullCompactionService.onDidFinishCompaction(() => { void this.startNext(); });
    }
    return this.fullCompactionService;
  }
  private extractCompressionCaptions(message: ContextMessage): { message: ContextMessage; captions: readonly string[] } {
    if ((message.origin ?? USER_PROMPT_ORIGIN).kind !== 'user') return { message, captions: [] };
    const captions: string[] = []; const parts: ContentPart[] = [];
    for (const part of message.content) {
      if (part.type !== 'text') { parts.push(part); continue; }
      const extracted = extractImageCompressionCaptions(part.text); captions.push(...extracted.captions);
      if (extracted.text.trim().length > 0) parts.push({ type: 'text', text: extracted.text });
    }
    return { message: captions.length === 0 ? message : { ...message, content: parts }, captions };
  }
  private appendPrompt(message: ContextMessage, captions: readonly string[]): void {
    const ownerPromptId = message.id ?? newMessageId();
    for (const caption of captions) {
      this.reminders.appendSystemReminder(caption, {
        kind: 'injection',
        variant: 'image_compression',
        ownerPromptId,
      });
    }
    if (message.content.length > 0) this.context.append({ ...message, id: ownerPromptId });
  }
  private async deliverToolResult(ctx: ToolDidExecuteContext): Promise<void> {
    const delivery = ctx.result.delivery; if (delivery === undefined) return;
    const { delivery: _delivery, ...rest } = ctx.result; ctx.result = rest as ExecutableToolResult;
    if (delivery.kind === 'steer') await this.inject(delivery.message as ContextMessage);
  }
  private publishCompleted(promptId: string, reason: 'completed' | 'failed' | 'blocked'): void { void this.dispatcher.dispatch(new PromptCompleted({ agentId: this.scopeContext.agentId, promptId, finishedAt: new Date().toISOString(), reason })); }
  private publishQueued(record: Record): void {
    if ((record.message.origin ?? USER_PROMPT_ORIGIN).kind !== 'user') return;
    void this.dispatcher.dispatch(new PromptQueued({ agentId: this.scopeContext.agentId, promptId: record.id, content: stripBundledSkillBlocks(record.message), queueLength: this.pending.length }));
  }
  private publishAborted(promptId: string): void { void this.dispatcher.dispatch(new PromptAborted({ agentId: this.scopeContext.agentId, promptId, abortedAt: new Date().toISOString() })); }
}

function snapshot(item: Record): PromptSnapshot { return { id: item.id, userMessageId: item.userMessageId, createdAt: item.createdAt, state: item.state, message: item.message }; }
function deferred<T>(): Deferred<T> { let resolve!: (value: T) => void; let reject!: (reason: unknown) => void; const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; }); return { promise, resolve, reject }; }

registerScopedService(
  LifecycleScope.Agent,
  IAgentPromptService,
  AgentPromptService,
  ScopeActivation.OnScopeCreated,
  'prompt',
);

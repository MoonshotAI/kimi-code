import { toDisposable, type IDisposable } from '#/_base/di/lifecycle';
import { extractImageCompressionCaptions } from '#/agent/media/image-compress';
import { userCancellationReason } from '#/_base/utils/abort';
import { AgentContextMemory, type ContextMemoryRuntime } from '#/features/contextMemory/contextMemoryAgentRuntime';
import { newMessageId } from '#/features/contextMemory/messageId';
import { USER_PROMPT_ORIGIN, type ContextMessage } from '#/features/contextMemory/types';
import { AgentFullCompaction, type FullCompactionRuntime } from '#/features/fullCompaction/fullCompactionAgentRuntime';
import { getLoopControl } from '#/features/loop/internal/access';
import { IAgentHostService, type AgentHost } from '#/agent/host/agentHost';
import type { LoopControl, Turn, TurnResult } from '#/features/loop/internal/loop';
import { TurnSteer } from '#/features/loop/turnOps';
import { AgentReminder, type ReminderRuntime } from '#/features/reminder/reminderAgentRuntime';

import type { ExecutableToolResult } from '#/tool/toolContract';
import type { ToolDidExecuteContext } from '#/features/toolExecutor/toolHooks';
import { activateToolExecutorWhenReady } from '#/features/toolExecutor/internal/executorActivation';
import { AgentTools } from '#/features/toolExecutor/toolExecutorAgentRuntime';
import { IFileService } from '#/app/file/fileService';
import type { ContentPart } from '#/kosong/contract/message';
import { IEventService } from '#/app/event/event';
import { ErrorCodes, Error2, isError2 } from '#/errors';
import { OrderedHookSlot } from '#/hooks';
import type { AgentRuntimeContext } from '#/agent/runtime/agentRuntime';
import { IAgentLifecycleService, MAIN_AGENT_ID } from '#/session/agentLifecycle/agentLifecycle';
import { ISessionContext } from '#/session/sessionContext/sessionContext';
import { ISessionMetadata } from '#/session/sessionMetadata/sessionMetadata';
import { applyPromptMetadataUpdate } from '#/session/sessionMetadata/promptMetadata';
import type {
  PromptBeforeSubmitHook,
  PromptCompletion,
  PromptHandle,
  PromptInput,
  PromptOrigin,
  PromptQueueSnapshot,
  PromptSnapshot,
  PromptState,
  PromptSubmitContext,
  PromptSubmitInput,
  PromptSubmitResult,
  PromptAdmissionReservation,
} from '../prompt';
import { promptMetadataTextFromContentParts } from '../promptMetadataText';
import { PromptStepRequest, RetryStepRequest, SteerStepRequest } from './promptStepRequests';
import { PromptAccepted } from '../promptOps';
import { PromptAborted, PromptCompleted, PromptQueued, PromptSteered } from '../promptEvents';
import { daemonFileRefFromPart } from '#/agent/media/mediaRef';
import { materializePromptDaemonRefs } from '#/agent/media/promptMediaIntake';
import { ISessionMediaStore } from '#/agent/media/sessionMediaStore';

interface Deferred<T> { readonly promise: Promise<T>; resolve(value: T): void; reject(reason: unknown): void }
interface Record {
  id: string;
  userMessageId: string;
  readonly createdAt: string;
  state: PromptState;
  readonly message: ContextMessage;
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

function userMessageForOrigin(content: readonly ContentPart[], origin: PromptOrigin): ContextMessage {
  return {
    role: 'user',
    content: [...content],
    toolCalls: [],
    origin: origin.kind === 'user' ? { kind: 'user' } : undefined,
  };
}

function submitResultOf(handle: PromptHandle, turn: Turn | undefined): PromptSubmitResult {
  const state = handle.state === 'running' || handle.state === 'steered'
    ? 'running'
    : handle.state === 'blocked' ? 'blocked' : 'queued';
  return {
    promptId: handle.id,
    createdAt: handle.createdAt,
    state,
    turnId: turn === undefined ? undefined : turn.id,
  };
}

export class PromptDomain {
  private active: (Record & { turn: Turn }) | undefined;
  private readonly pending: Record[] = [];
  private readonly steered = new Map<string, Record[]>();
  private readonly reservedPromptIds = new Set<string>();
  private steering = 0;
  private launching = false;
  private fullCompactionRuntime: FullCompactionRuntime | undefined;
  private fullCompactionSubscription: IDisposable | undefined;
  private readonly hooks = { onBeforeSubmitPrompt: new OrderedHookSlot<PromptSubmitContext>() };

  constructor(private readonly runtime: AgentRuntimeContext<ReadonlySet<string>>) {}

  private get host(): AgentHost {
    return this.runtime.get(IAgentHostService).of(this.runtime.agent);
  }

  attach(): IDisposable {
    const registration = activateToolExecutorWhenReady(
      this.runtime.get(IAgentLifecycleService),
      this.host.scopeContext,
      (executor) =>
        executor.registerDidExecuteHook('prompt-service-delivery', async (ctx, next) => {
          await this.deliverToolResult(ctx);
          await next();
        }),
      { deferToScopeCreated: true },
    );
    return toDisposable(() => {
      registration.dispose();
      this.fullCompactionSubscription?.dispose();
      this.fullCompactionSubscription = undefined;
    });
  }

  private get agentId(): string {
    return this.runtime.agent.agentId;
  }

  private reminder(): ReminderRuntime {
    return this.runtime.get(IAgentLifecycleService).resolve(this.runtime.agent, AgentReminder);
  }

  private get context(): ContextMemoryRuntime {
    return this.runtime.get(IAgentLifecycleService).resolve(this.runtime.agent, AgentContextMemory);
  }

  registerBeforeSubmitHook(name: string, hook: PromptBeforeSubmitHook): IDisposable {
    return this.hooks.onBeforeSubmitPrompt.register(name, hook);
  }

  private reserveAdmissionId(promptId: string | undefined): string {
    if (promptId !== undefined && promptId.length === 0) {
      throw new Error2(ErrorCodes.REQUEST_INVALID, 'prompt_id must not be empty');
    }
    const accepted = this.runtime.getState();
    let id = promptId ?? newMessageId();
    while (accepted.has(id) || this.reservedPromptIds.has(id)) {
      if (promptId !== undefined) {
        throw new Error2(ErrorCodes.PROMPT_ID_CONFLICT, `prompt_id '${id}' is already in use`);
      }
      id = newMessageId();
    }
    this.reservedPromptIds.add(id);
    return id;
  }

  private async dispatchAccepted(id: string, message: ContextMessage): Promise<void> {
    this.reservedPromptIds.delete(id);
    await this.runtime.dispatch(
      new PromptAccepted({
        agentId: this.agentId,
        promptId: id,
        content: stripBundledSkillBlocks(message),
      }),
    );
  }

  reserveAdmission(promptId: string | undefined): PromptAdmissionReservation {
    const id = this.reserveAdmissionId(promptId);
    let disposed = false;
    return {
      id,
      dispose: () => {
        if (disposed) return;
        disposed = true;
        this.reservedPromptIds.delete(id);
      },
    };
  }

  async submit(input: PromptSubmitInput): Promise<PromptSubmitResult> {
    if (input.admission === 'currentTurn') return this.submitSteer(input);
    const promptId = this.reserveAdmissionId(input.promptId);
    let accepted = false;
    try {
      if (input.disabledTools !== undefined) {
        try {
          await this.runtime
            .get(IAgentLifecycleService)
            .resolve(this.runtime.agent, AgentTools)
            .setSessionDisabledTools(input.disabledTools);
        } catch (error) {
          throw new Error2(
            ErrorCodes.REQUEST_INVALID,
            error instanceof Error ? error.message : String(error),
          );
        }
      }
      await this.updatePromptMetadata(promptMetadataTextFromContentParts(input.content));
      const message = userMessageForOrigin(input.content, input.origin);
      await this.dispatchAccepted(promptId, message);
      accepted = true;
      const handle = await this.enqueue({ id: promptId, message });
      if (handle.state === 'pending') {
        return { promptId: handle.id, createdAt: handle.createdAt, state: 'queued' };
      }
      const turn = await handle.launched;
      return submitResultOf(handle, turn);
    } finally {
      if (!accepted) this.reservedPromptIds.delete(promptId);
    }
  }

  private async submitSteer(input: PromptSubmitInput): Promise<PromptSubmitResult> {
    this.host.telemetry.track2('input_steer', { parts: input.content.length });
    await this.updatePromptMetadata(promptMetadataTextFromContentParts(input.content));
    const queued = await this.enqueue({ message: {
      role: 'user',
      content: [...input.content],
      toolCalls: [],
    } });
    if (queued.state !== 'pending') {
      const turn = await queued.launched;
      return submitResultOf(queued, turn);
    }
    try {
      const [steered] = await this.steer([queued.id]);
      if (steered === undefined) {
        return { promptId: queued.id, createdAt: queued.createdAt, state: 'queued' };
      }
      const turn = await steered.launched;
      return submitResultOf(steered, turn);
    } catch (error) {
      if (isError2(error) && error.code === ErrorCodes.PROMPT_NOT_FOUND) {
        return { promptId: queued.id, createdAt: queued.createdAt, state: 'queued' };
      }
      throw error;
    }
  }

  async submitMessage(message: ContextMessage): Promise<PromptHandle> {
    const id = this.reserveAdmissionId(message.id);
    let accepted = false;
    try {
      await this.dispatchAccepted(id, message);
      accepted = true;
      return await this.enqueue({ id, message });
    } finally {
      if (!accepted) this.reservedPromptIds.delete(id);
    }
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
      if (this.fullCompaction.status() === 'running' && this.loop.status().state !== 'running') {
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

  private async updatePromptMetadata(text: string | undefined): Promise<void> {
    if (this.agentId !== MAIN_AGENT_ID) return;
    await applyPromptMetadataUpdate(
      {
        metadata: this.runtime.get(ISessionMetadata),
        eventService: this.runtime.get(IEventService),
        sessionId: this.runtime.get(ISessionContext).sessionId,
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
    const request = new SteerStepRequest(rerouted, captions, this.reminder(), (materialized) => {
      void this.host.dispatcher.dispatch(
        new TurnSteer({
          agentId: this.agentId,
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
    void this.host.dispatcher.dispatch(
      new PromptSteered({ agentId: this.agentId, activePromptId: this.active.id, promptIds: selected.map((x) => x.id), content: selected.flatMap((item) => stripBundledSkillBlocks(item.message)), steeredAt: new Date().toISOString() }),
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
    const request = new SteerStepRequest(rerouted, captions, this.reminder(), (materialized) => {
      void this.host.dispatcher.dispatch(
        new TurnSteer({
          agentId: this.agentId,
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
    void this.context.clear();
  }

  private get loop(): LoopControl {
    return getLoopControl(this.runtime.agent);
  }

  private async startNext(): Promise<void> {
    if (this.active !== undefined || this.launching || this.steering > 0) return;
    const item = this.pending.shift(); if (item === undefined) return;
    this.launching = true;
    try {
      if (this.fullCompaction.status() === 'running' && this.loop.status().state !== 'running') { this.pending.unshift(item); return; }
      const { message, captions } = this.extractCompressionCaptions(item.message);
      await this.materializeDaemonRefs(message);
      if (await this.blockedByHook(message, false)) {
        this.appendPrompt(message, captions); item.state = 'blocked'; item.launchedDeferred.resolve(undefined);
        item.completionDeferred.resolve({ promptId: item.id, result: undefined, state: 'blocked' });
        this.publishCompleted(item.id, 'blocked'); return;
      }
      const turn = (await this.loop.enqueue(new PromptStepRequest(message, captions, this.reminder())).assigned).turn;
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
    const files = this.runtime.get(IFileService);
    const mediaStore = this.runtime.get(ISessionMediaStore);
    await materializePromptDaemonRefs(message.content, { files, mediaStore });
  }

  private async blockedByHook(promptMessage: ContextMessage, isSteer: boolean): Promise<boolean> {
    const ctx = { promptMessage, isSteer, block: false }; await this.hooks.onBeforeSubmitPrompt.run(ctx); return ctx.block;
  }
  private get fullCompaction(): FullCompactionRuntime {
    if (this.fullCompactionRuntime === undefined) {
      this.fullCompactionRuntime = this.runtime
        .get(IAgentLifecycleService)
        .resolve(this.runtime.agent, AgentFullCompaction);
      this.fullCompactionSubscription = this.fullCompactionRuntime.onDidFinish(() => { void this.startNext(); });
    }
    return this.fullCompactionRuntime;
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
      this.reminder().notify(caption, {
        variant: 'image_compression',
        ownerPromptId,
      });
    }
    if (message.content.length > 0) void this.context.append({ ...message, id: ownerPromptId });
  }
  private async deliverToolResult(ctx: ToolDidExecuteContext): Promise<void> {
    const delivery = ctx.result.delivery; if (delivery === undefined) return;
    const { delivery: _delivery, ...rest } = ctx.result; ctx.result = rest as ExecutableToolResult;
    if (delivery.kind === 'steer') await this.inject(delivery.message as ContextMessage);
  }
  private publishCompleted(promptId: string, reason: 'completed' | 'failed' | 'blocked'): void { void this.host.dispatcher.dispatch(new PromptCompleted({ agentId: this.agentId, promptId, finishedAt: new Date().toISOString(), reason })); }
  private publishQueued(record: Record): void {
    if ((record.message.origin ?? USER_PROMPT_ORIGIN).kind !== 'user') return;
    void this.host.dispatcher.dispatch(new PromptQueued({ agentId: this.agentId, promptId: record.id, content: stripBundledSkillBlocks(record.message), queueLength: this.pending.length }));
  }
  private publishAborted(promptId: string): void { void this.host.dispatcher.dispatch(new PromptAborted({ agentId: this.agentId, promptId, abortedAt: new Date().toISOString() })); }
}

function snapshot(item: Record): PromptSnapshot { return { id: item.id, userMessageId: item.userMessageId, createdAt: item.createdAt, state: item.state, message: item.message }; }
function deferred<T>(): Deferred<T> { let resolve!: (value: T) => void; let reject!: (reason: unknown) => void; const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; }); return { promise, resolve, reject }; }

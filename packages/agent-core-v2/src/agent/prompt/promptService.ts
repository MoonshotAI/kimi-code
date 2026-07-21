/**
 * `prompt` domain (L4) — owns the per-agent prompt scheduler.
 *
 * Assigns prompt and message identities, serializes user prompts through an
 * active slot and FIFO, converts selected pending prompts into active-turn
 * steers, settles lifecycle handles, and keeps system input outside the prompt
 * resource model. Bound at Agent scope.
 */

import { InstantiationType } from '#/_base/di/extensions';
import { IInstantiationService } from '#/_base/di/instantiation';
import { LifecycleScope, registerScopedService } from '#/_base/di/scope';
import { extractImageCompressionCaptions } from '#/agent/media/image-compress';
import { userCancellationReason } from '#/_base/utils/abort';
import { IAgentContextMemoryService } from '#/agent/contextMemory/contextMemory';
import { newMessageId } from '#/agent/contextMemory/messageId';
import { formatUndoUnavailableMessage, precheckUndo } from '#/agent/contextMemory/contextOps';
import { USER_PROMPT_ORIGIN, type ContextMessage } from '#/agent/contextMemory/types';
import { IAgentFullCompactionService } from '#/agent/fullCompaction/fullCompaction';
import { IAgentLoopService, type Turn, type TurnResult } from '#/agent/loop/loop';
import { steerTurn } from '#/agent/loop/turnOps';
import { IAgentSystemReminderService } from '#/agent/systemReminder/systemReminder';
import type { ExecutableToolResult } from '#/tool/toolContract';
import type { ToolDidExecuteContext } from '#/agent/toolExecutor/toolHooks';
import { IAgentToolExecutorService } from '#/agent/toolExecutor/toolExecutor';
import type { ContentPart } from '#/kosong/contract/message';
import { IEventBus } from '#/app/event/eventBus';
import { ErrorCodes, Error2 } from '#/errors';
import { OrderedHookSlot } from '#/hooks';
import { IWireService } from '#/wire/wire';

import {
  IAgentPromptService,
  type PromptCompletion,
  type PromptHandle,
  type PromptInput,
  type PromptQueueSnapshot,
  type PromptSnapshot,
  type PromptState,
  type PromptSubmitContext,
} from './prompt';
import { PromptStepRequest, RetryStepRequest, SteerStepRequest } from './promptStepRequests';

declare module '#/app/event/eventBus' {
  interface DomainEventMap {
    'prompt.completed': { type: 'prompt.completed'; promptId: string; finishedAt: string; reason: 'completed' | 'failed' | 'blocked' };
    'prompt.aborted': { type: 'prompt.aborted'; promptId: string; abortedAt: string };
    'prompt.steered': { type: 'prompt.steered'; activePromptId: string; promptIds: string[]; content: ContentPart[]; steeredAt: string };
  }
}

interface Deferred<T> { readonly promise: Promise<T>; resolve(value: T): void; reject(reason: unknown): void }
interface Record extends PromptSnapshot {
  state: PromptState;
  readonly launchedDeferred: Deferred<Turn | undefined>;
  readonly completionDeferred: Deferred<PromptCompletion>;
  handle: PromptHandle;
}

export class AgentPromptService implements IAgentPromptService {
  declare readonly _serviceBrand: undefined;
  private active: (Record & { turn: Turn }) | undefined;
  private readonly pending: Record[] = [];
  private readonly steered = new Map<string, Record[]>();
  private launching = false;
  private fullCompactionService: IAgentFullCompactionService | undefined;
  readonly hooks = { onBeforeSubmitPrompt: new OrderedHookSlot<PromptSubmitContext>() };

  constructor(
    @IAgentContextMemoryService private readonly context: IAgentContextMemoryService,
    @IAgentSystemReminderService private readonly reminders: IAgentSystemReminderService,
    @IInstantiationService private readonly instantiation: IInstantiationService,
    @IAgentLoopService private readonly loop: IAgentLoopService,
    @IAgentToolExecutorService toolExecutor: IAgentToolExecutorService,
    @IWireService private readonly wire: IWireService,
    @IEventBus private readonly eventBus: IEventBus,
  ) {
    toolExecutor.hooks.onDidExecuteTool.register('prompt-service-delivery', async (ctx, next) => {
      await this.deliverToolResult(ctx);
      await next();
    });
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
        return record.handle;
      }
      void this.startNext();
      await Promise.race([record.launchedDeferred.promise, record.completionDeferred.promise]);
    }
    return record.handle;
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
    for (const item of selected) this.pending.splice(this.pending.indexOf(item), 1);
    const message: ContextMessage = {
      role: 'user', content: selected.flatMap((item) => item.message.content), toolCalls: [], origin: USER_PROMPT_ORIGIN,
    };
    const { message: rerouted, captions } = this.extractCompressionCaptions(message);
    const request = new SteerStepRequest(rerouted, captions, this.reminders, (materialized) => {
      this.wire.dispatch(steerTurn({ input: materialized.content, origin: materialized.origin ?? USER_PROMPT_ORIGIN }));
    }, () => {});
    const turn = (await this.loop.enqueue(request).assigned).turn;
    if (turn === undefined) throw new Error2(ErrorCodes.PROMPT_NOT_FOUND, 'no active turn to steer into');
    for (const item of selected) { item.state = 'steered'; item.launchedDeferred.resolve(turn); }
    this.steered.set(this.active.id, [...(this.steered.get(this.active.id) ?? []), ...selected]);
    this.eventBus.publish({ type: 'prompt.steered', activePromptId: this.active.id, promptIds: selected.map((x) => x.id), content: rerouted.content as ContentPart[], steeredAt: new Date().toISOString() });
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

  async inject(message: ContextMessage): Promise<Turn | undefined> {
    const { message: rerouted, captions } = this.extractCompressionCaptions(message);
    const request = new SteerStepRequest(rerouted, captions, this.reminders, (materialized) => {
      this.wire.dispatch(steerTurn({ input: materialized.content, origin: materialized.origin ?? USER_PROMPT_ORIGIN }));
    }, () => {}, 'activeOrNewTurn');
    return (await this.loop.enqueue(request).assigned).turn;
  }

  async retry(): Promise<Turn | undefined> { return (await this.loop.enqueue(new RetryStepRequest()).assigned).turn; }

  undo(count: number): number {
    if (count <= 0) return 0;
    const check = precheckUndo(this.context.get(), count);
    if (!check.ok) throw new Error2(ErrorCodes.SESSION_UNDO_UNAVAILABLE, formatUndoUnavailableMessage(check), { details: { reason: check.reason, requestedCount: count, undoableCount: check.undoable } });
    return this.context.undo(count).removedCount;
  }

  clear(): void {
    for (const item of this.pending.slice()) this.abort(item.id);
    if (this.active !== undefined) this.abort(this.active.id);
    this.context.clear();
  }

  private async startNext(): Promise<void> {
    if (this.active !== undefined || this.launching) return;
    const item = this.pending.shift(); if (item === undefined) return;
    this.launching = true;
    try {
      if (this.fullCompaction.compacting !== null && this.loop.status().state !== 'running') { this.pending.unshift(item); return; }
      const { message, captions } = this.extractCompressionCaptions(item.message);
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
    for (const caption of captions) this.reminders.appendSystemReminder(caption, { kind: 'injection', variant: 'image_compression' });
    if (message.content.length > 0) this.context.append(message);
  }
  private async deliverToolResult(ctx: ToolDidExecuteContext): Promise<void> {
    const delivery = ctx.result.delivery; if (delivery === undefined) return;
    const { delivery: _delivery, ...rest } = ctx.result; ctx.result = rest as ExecutableToolResult;
    if (delivery.kind === 'steer') await this.inject(delivery.message as ContextMessage);
  }
  private publishCompleted(promptId: string, reason: 'completed' | 'failed' | 'blocked'): void { this.eventBus.publish({ type: 'prompt.completed', promptId, finishedAt: new Date().toISOString(), reason }); }
  private publishAborted(promptId: string): void { this.eventBus.publish({ type: 'prompt.aborted', promptId, abortedAt: new Date().toISOString() }); }
}

function snapshot(item: Record): PromptSnapshot { return { id: item.id, userMessageId: item.userMessageId, createdAt: item.createdAt, state: item.state, message: item.message }; }
function deferred<T>(): Deferred<T> { let resolve!: (value: T) => void; let reject!: (reason: unknown) => void; const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; }); return { promise, resolve, reject }; }

registerScopedService(LifecycleScope.Agent, IAgentPromptService, AgentPromptService, InstantiationType.Eager, 'prompt');

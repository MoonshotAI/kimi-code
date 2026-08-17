/**
 * `prompt` domain — owns the per-agent prompt scheduler.
 *
 * Assigns prompt and message identities, serializes user prompts through an
 * active slot and FIFO, converts selected pending prompts into active-turn
 * steers, settles lifecycle handles, and keeps system input outside the prompt
 * resource model. Daemon file references in submissions are materialized
 * through the `media` domain's intake (`materializePromptDaemonRefs` — copy
 * the bytes into the session media store; the reference stays the bare
 * `kimi-file://<fileId>` form); the media store owns the canonical
 * persistence. `submit` /
 * `submitSteer` are the wire-facing user entry
 * points: they track `input_steer` through `telemetry`, persist the derived
 * title/lastPrompt through `sessionMetadata` for the main agent only
 * (publishing the live update through `event`), enqueue, and settle
 * `{turn_id}` from the launch handle. A `submit` payload may carry a
 * client-chosen `promptId` (admitted through the reservation so a duplicate
 * rejects before any session state changes) and a client-managed session
 * tool denylist, applied through `toolPolicy` before the enqueue.
 * The pure-data `launching` flag is registered into
 * `agentState` (`IAgentStateService`) and read/written through it; the
 * `active` / `pending` / `steered` records stay plain fields because their
 * `Record` values carry Deferred promise handles (the container only holds
 * pure data structures), as do the lazily-resolved `fullCompactionService`
 * reference and the `hooks` slot. Bound at Agent scope.
 */

import { IInstantiationService } from '#/_base/di/instantiation';
import { Disposable } from '#/_base/di/lifecycle';
import { LifecycleScope } from '#/app/scopes';
import { ScopeActivation, registerScopedService } from '#/_base/di/scope';
import { defineState } from '#/_base/state/stateRegistry';
import { extractImageCompressionCaptions } from '#/agent/media/image-compress';
import { daemonFileRefFromPart } from '#/agent/media/mediaRef';
import { materializePromptDaemonRefs } from '#/agent/media/promptMediaIntake';
import { ISessionMediaStore } from '#/agent/media/sessionMediaStore';
import { userCancellationReason } from '#/_base/utils/abort';
import { IAgentContextMemoryService } from '#/agent/contextMemory/contextMemory';
import { newMessageId } from '#/agent/contextMemory/messageId';
import { USER_PROMPT_ORIGIN, type ContextMessage } from '#/agent/contextMemory/types';
import { IAgentFullCompactionService } from '#/agent/fullCompaction/fullCompaction';
import { IAgentLoopService, type Turn, type TurnResult } from '#/agent/loop/loop';
import { steerTurn } from '#/agent/loop/turnOps';
import { IAgentStateService } from '#/agent/state/agentState';
import { IAgentSystemReminderService } from '#/agent/systemReminder/systemReminder';
import type { ExecutableToolResult } from '#/tool/toolContract';
import type { ToolDidExecuteContext } from '#/agent/toolExecutor/toolHooks';
import { IAgentToolExecutorService } from '#/agent/toolExecutor/toolExecutor';
import { IAgentToolPolicyService } from '#/agent/toolPolicy/toolPolicy';
import { ProfileError } from '#/agent/profile/profile';
import type { ContentPart } from '#/kosong/contract/message';
import { IFileService } from '#/app/file/fileService';
import { IEventBus } from '#/app/event/eventBus';
import { IEventService } from '#/app/event/event';
import { ErrorCodes, Error2, isError2 } from '#/errors';
import { OrderedHookSlot } from '#/hooks';
import { IWireService } from '#/wire/wire';
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
  type PromptReservation,
  type PromptQueueSnapshot,
  type PromptSnapshot,
  type PromptState,
  type PromptSubmitContext,
  type SteerPayload,
} from './prompt';
import { promptMetadataTextFromContentParts } from './promptMetadataText';
import { promptAccepted, PromptAdmissionModel } from './promptOps';
import { PromptStepRequest, RetryStepRequest, SteerStepRequest } from './promptStepRequests';

declare module '#/app/event/eventBus' {
  interface DomainEventMap {
    'prompt.completed': { type: 'prompt.completed'; promptId: string; finishedAt: string; reason: 'completed' | 'failed' | 'blocked' };
    'prompt.aborted': { type: 'prompt.aborted'; promptId: string; abortedAt: string };
    'prompt.steered': { type: 'prompt.steered'; activePromptId: string; promptIds: string[]; content: ContentPart[]; steeredAt: string };
    'prompt.queued': { type: 'prompt.queued'; promptId: string; content: ContentPart[]; queueLength: number };
  }
}

interface Deferred<T> { readonly promise: Promise<T>; resolve(value: T): void; reject(reason: unknown): void }
interface Record extends PromptSnapshot {
  state: PromptState;
  message: ContextMessage;
  readonly launchedDeferred: Deferred<Turn | undefined>;
  readonly completionDeferred: Deferred<PromptCompletion>;
  readonly intakeController: AbortController;
  intake: Promise<void>;
  handle: PromptHandle;
}

interface SteeringReservation {
  readonly item: Record;
  readonly active: Record & { turn: Turn };
}

export const promptLaunchingKey = defineState<boolean>('prompt.launching', () => false);

export class AgentPromptService extends Disposable implements IAgentPromptService {
  declare readonly _serviceBrand: undefined;
  private active: (Record & { turn: Turn }) | undefined;
  private readonly pending: Record[] = [];
  private launchingItem: Record | undefined;
  private readonly steered = new Map<string, Record[]>();
  private readonly steering = new Map<string, SteeringReservation>();
  private readonly reservedPromptIds = new Set<string>();
  private readonly intakes = new Set<Promise<void>>();
  private readonly intakeControllers = new Set<AbortController>();
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
    @IAgentStateService private readonly states: IAgentStateService,
    @IFileService private readonly files: IFileService,
    @ISessionMediaStore private readonly mediaStore: ISessionMediaStore,
    @ITelemetryService private readonly telemetry: ITelemetryService,
    @ISessionMetadata private readonly metadata: ISessionMetadata,
    @IEventService private readonly eventService: IEventService,
    @ISessionContext private readonly sessionContext: ISessionContext,
    @IAgentScopeContext private readonly scopeContext: IAgentScopeContext,
    @IAgentToolPolicyService private readonly toolPolicy: IAgentToolPolicyService,
  ) {
    super();
    this.states.register(promptLaunchingKey);
    this._register(
      toolExecutor.hooks.onDidExecuteTool.register('prompt-service-delivery', async (ctx, next) => {
        await this.deliverToolResult(ctx);
        await next();
      }),
    );
  }

  private get launching(): boolean {
    return this.states.get(promptLaunchingKey);
  }

  private set launching(value: boolean) {
    this.states.set(promptLaunchingKey, value);
  }

  private mediaIntakeOf(record: Record): Promise<void> {
    const intake = materializePromptDaemonRefs(record.message.content, {
      files: this.files,
      mediaStore: this.mediaStore,
      signal: record.intakeController.signal,
    });
    let tracked!: Promise<void>;
    tracked = intake
      .catch(() => undefined)
      .then(() => {
        this.intakes.delete(tracked);
        this.intakeControllers.delete(record.intakeController);
      });
    this.intakes.add(tracked);
    this.intakeControllers.add(record.intakeController);
    return tracked;
  }

  [promptAdmission](promptId?: string): PromptReservation {
    if (promptId !== undefined && promptId.length === 0) {
      throw new Error2(ErrorCodes.REQUEST_INVALID, 'prompt_id must not be empty');
    }
    let id = promptId ?? newMessageId();
    const accepted = this.wire.getModel(PromptAdmissionModel);
    while (accepted.has(id) || this.reservedPromptIds.has(id)) {
      if (promptId !== undefined) throw promptIdConflict(id);
      id = newMessageId();
    }
    this.reservedPromptIds.add(id);
    let submitted = false;
    return {
      id,
      submit: (message) => {
        if (submitted || !this.reservedPromptIds.has(id)) {
          throw new Error2(ErrorCodes.REQUEST_INVALID, 'prompt reservation is no longer available');
        }
        submitted = true;
        this.reservedPromptIds.delete(id);
        this.wire.dispatch(promptAccepted({ promptId: id }));
        return this.enqueueAccepted(id, message);
      },
      dispose: () => {
        if (submitted) return;
        submitted = true;
        this.reservedPromptIds.delete(id);
      },
    };
  }

  async enqueue(input: PromptInput): Promise<PromptHandle> {
    const reservation = this[promptAdmission](input.id ?? input.message.id);
    try {
      return await reservation.submit(input.message);
    } finally {
      reservation.dispose();
    }
  }

  private async enqueueAccepted(id: string, inputMessage: ContextMessage): Promise<PromptHandle> {
    const message = { ...inputMessage, id };
    const launchedDeferred = deferred<Turn | undefined>();
    const completionDeferred = deferred<PromptCompletion>();
    const record = {
      id, userMessageId: id, createdAt: new Date().toISOString(), state: 'pending', message,
      launchedDeferred, completionDeferred, intakeController: new AbortController(),
    } as Record;
    const requiresMediaIntake = message.content.some((part) => daemonFileRefFromPart(part) !== undefined);
    record.intake = this.mediaIntakeOf(record);
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
      if (requiresMediaIntake) {
        this.publishQueued(record);
        return record.handle;
      }
      await Promise.race([record.launchedDeferred.promise, record.completionDeferred.promise]);
    } else {
      this.publishQueued(record);
    }
    return record.handle;
  }

  async submit(payload: PromptPayload): Promise<PromptLaunchResult | undefined> {
    // Reserve the (possibly client-chosen) id first: a duplicate promptId must
    // reject before the denylist or the session metadata changes.
    const reservation = this[promptAdmission](payload.promptId);
    try {
      if (payload.disabledTools !== undefined) {
        try {
          await this.toolPolicy.setSessionDisabledTools(payload.disabledTools);
        } catch (error) {
          if (error instanceof ProfileError) {
            throw new Error2(ErrorCodes.REQUEST_INVALID, error.message);
          }
          throw error;
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
    // A steer is user input like a prompt — and can even launch the session's
    // first turn (e.g. goal mode) — so keep title/lastPrompt in sync the same
    // way, matching v1.
    await this.updatePromptMetadata(promptMetadataTextFromContentParts(payload.input));
    const queued = await this.enqueue({ message: {
      role: 'user',
      content: [...payload.input],
      toolCalls: [],
    } });
    if (queued.state !== 'pending') {
      // No active prompt at enqueue time, so the enqueue itself already
      // launched this input as its own turn (idle session, or a goal-turn
      // boundary where the previous turn just ended) — v1's
      // steer-degrades-to-launch end state. Return that turn instead of
      // rejecting on a steer-by-id that can never find the record pending.
      const turn = await queued.launched;
      return turn === undefined ? undefined : { turn_id: turn.id };
    }
    try {
      const [steered] = await this.steer([queued.id]);
      const turn = await steered?.launched;
      return turn === undefined ? undefined : { turn_id: turn.id };
    } catch (error) {
      // Pending but nothing active to steer into (a manual compaction holds
      // the context): the message stays queued and launches once compaction
      // finishes, so report it as queued rather than failing the steer.
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
    // startNext shifts the launching record out of `pending` before its media
    // intake settles; keep reporting it as queued during that window so the
    // snapshot never loses an accepted (and abortable) submission between the
    // `prompt.queued` event and `turn.started`.
    const pending = this.pending.map(snapshot);
    if (this.launchingItem !== undefined) pending.unshift(snapshot(this.launchingItem));
    return { active: this.active === undefined ? undefined : snapshot(this.active), pending };
  }

  async steer(promptIds: readonly string[]): Promise<readonly PromptHandle[]> {
    if (promptIds.length === 0) throw new Error2(ErrorCodes.REQUEST_INVALID, 'prompt_ids must not be empty');
    const active = this.active;
    if (active === undefined) throw new Error2(ErrorCodes.PROMPT_NOT_FOUND, 'no active prompt to steer into');
    const ids = new Set(promptIds);
    if (ids.size !== promptIds.length || this.pending.filter((item) => ids.has(item.id)).length !== ids.size) {
      throw new Error2(ErrorCodes.PROMPT_NOT_FOUND, 'one or more prompts are not pending');
    }
    const selected = this.pending.filter((item) => ids.has(item.id));
    for (const item of selected) {
      this.pending.splice(this.pending.indexOf(item), 1);
      this.steering.set(item.id, { item, active });
    }
    try {
      await Promise.all(selected.map((item) => item.intake));
      if (!this.reservationsMatch(selected, active)) {
        throw new Error2(ErrorCodes.PROMPT_NOT_FOUND, 'prompt steer was cancelled');
      }
      if (this.active !== active) {
        this.cancelSteering(selected);
        throw new Error2(ErrorCodes.PROMPT_NOT_FOUND, 'active prompt finished before steer');
      }
      const message: ContextMessage = {
        role: 'user', content: selected.flatMap((item) => item.message.content), toolCalls: [], origin: USER_PROMPT_ORIGIN,
      };
      const { message: rerouted, captions } = this.extractCompressionCaptions(message);
      const request = new SteerStepRequest(rerouted, captions, this.reminders, (materialized) => {
        this.wire.dispatch(steerTurn({ input: materialized.content, origin: materialized.origin ?? USER_PROMPT_ORIGIN }));
      }, () => {});
      const receipt = this.loop.enqueue(request);
      const turn = (await receipt.assigned).turn;
      const cancelledMidFlight = !this.reservationsMatch(selected, active);
      if (turn === undefined || this.active !== active || turn.id !== active.turn.id || cancelledMidFlight) {
        // The steer request is turn-agnostic (`turnScoped: false`), so without
        // an explicit abort it could still materialize its content into
        // whichever turn pops it next. An abort that landed inside the
        // `assigned` window has already settled the record as cancelled —
        // keep that terminal state instead of flipping it to 'steered'.
        receipt.abort(userCancellationReason());
        this.cancelSteering(selected);
        throw new Error2(
          ErrorCodes.PROMPT_NOT_FOUND,
          cancelledMidFlight ? 'prompt steer was cancelled' : 'no active turn to steer into',
        );
      }
      for (const item of selected) {
        this.steering.delete(item.id);
        item.state = 'steered';
        item.launchedDeferred.resolve(turn);
      }
      this.steered.set(active.id, [...(this.steered.get(active.id) ?? []), ...selected]);
      this.eventBus.publish({ type: 'prompt.steered', activePromptId: active.id, promptIds: selected.map((x) => x.id), content: rerouted.content, steeredAt: new Date().toISOString() });
      return selected.map((item) => item.handle);
    } catch (error) {
      this.cancelSteering(selected);
      throw error;
    }
  }

  abort(promptId: string, reason: Error = userCancellationReason()): boolean {
    if (this.active?.id === promptId) { this.loop.cancel(this.active.turn.id, reason); return true; }
    if (this.launchingItem?.id === promptId) {
      const item = this.launchingItem;
      this.cancelRecord(item, reason);
      return true;
    }
    const reservation = this.steering.get(promptId);
    if (reservation !== undefined) {
      this.steering.delete(promptId);
      this.cancelRecord(reservation.item, reason);
      return true;
    }
    const index = this.pending.findIndex((item) => item.id === promptId);
    if (index < 0) throw new Error2(ErrorCodes.PROMPT_NOT_FOUND, `prompt ${promptId} not found`);
    const [item] = this.pending.splice(index, 1) as [Record];
    this.cancelRecord(item, reason);
    return true;
  }

  async drain(reason: Error = userCancellationReason()): Promise<void> {
    for (const item of this.pending.slice()) this.abort(item.id, reason);
    for (const item of this.steering.values()) this.abort(item.item.id, reason);
    if (this.launchingItem !== undefined) this.abort(this.launchingItem.id, reason);
    for (const controller of this.intakeControllers) controller.abort(reason);
    await Promise.allSettled(this.intakes);
  }

  async inject(message: ContextMessage): Promise<Turn | undefined> {
    const { message: rerouted, captions } = this.extractCompressionCaptions(message);
    const request = new SteerStepRequest(rerouted, captions, this.reminders, (materialized) => {
      this.wire.dispatch(steerTurn({ input: materialized.content, origin: materialized.origin ?? USER_PROMPT_ORIGIN }));
    }, () => {}, 'activeOrNewTurn');
    return (await this.loop.enqueue(request).assigned).turn;
  }

  async retry(): Promise<Turn | undefined> { return (await this.loop.enqueue(new RetryStepRequest()).assigned).turn; }

  clear(): void {
    for (const item of this.pending.slice()) this.abort(item.id);
    for (const item of this.steering.values()) this.abort(item.item.id);
    if (this.launchingItem !== undefined) this.abort(this.launchingItem.id);
    if (this.active !== undefined) this.abort(this.active.id);
    this.context.clear();
  }

  override dispose(): void {
    for (const controller of this.intakeControllers) controller.abort(userCancellationReason());
    super.dispose();
  }

  private reservationsMatch(
    selected: readonly Record[],
    active: Record & { turn: Turn },
  ): boolean {
    return selected.every((item) => {
      const reservation = this.steering.get(item.id);
      return reservation?.item === item && reservation.active === active;
    });
  }

  private cancelSteering(selected: readonly Record[], reason = userCancellationReason()): void {
    for (const item of selected) {
      const reservation = this.steering.get(item.id);
      if (reservation?.item !== item) continue;
      this.steering.delete(item.id);
      this.cancelRecord(item, reason);
    }
  }

  private cancelRecord(item: Record, reason: Error): void {
    if (cancelled(item)) return;
    item.intakeController.abort(reason);
    item.state = 'cancelled';
    item.launchedDeferred.resolve(undefined);
    item.completionDeferred.resolve({ promptId: item.id, result: undefined, state: 'cancelled' });
    this.publishAborted(item.id);
  }

  private async startNext(): Promise<void> {
    if (this.active !== undefined || this.launching) return;
    const item = this.pending.shift(); if (item === undefined) return;
    this.launching = true;
    this.launchingItem = item;
    let requeued = false;
    try {
      await Promise.race([item.intake, item.launchedDeferred.promise]);
      if (cancelled(item)) return;
      if (this.fullCompaction.compacting !== null && this.loop.status().state !== 'running') {
        this.pending.unshift(item);
        requeued = true;
        return;
      }
      const { message, captions } = this.extractCompressionCaptions(item.message);
      const blocked = await this.blockedByHook(message, false);
      if (cancelled(item)) return;
      if (blocked) {
        this.appendPrompt(message, captions); item.state = 'blocked'; item.launchedDeferred.resolve(undefined);
        item.completionDeferred.resolve({ promptId: item.id, result: undefined, state: 'blocked' });
        this.publishCompleted(item.id, 'blocked'); return;
      }
      const turn = (await this.loop.enqueue(new PromptStepRequest(message, captions, this.reminders)).assigned).turn;
      if (turn === undefined) { if (!cancelled(item)) this.pending.unshift(item); return; }
      if (cancelled(item)) { this.loop.cancel(turn.id); return; }
      item.state = 'running'; item.launchedDeferred.resolve(turn); this.active = Object.assign(item, { turn });
      void turn.result.then((result) => {
        this.settle(item, result);
      });
    } catch {
      if (cancelled(item)) return;
      item.state = 'failed';
      item.launchedDeferred.resolve(undefined);
      item.completionDeferred.resolve({ promptId: item.id, result: undefined, state: 'failed' });
      this.publishCompleted(item.id, 'failed');
    } finally {
      this.launchingItem = undefined;
      this.launching = false;
      if (!requeued && this.active === undefined) void this.startNext();
    }
  }

  private settle(item: Record, result: TurnResult): void {
    if (this.active?.id !== item.id) return;
    this.active = undefined;
    this.cancelSteering(
      [...this.steering.values()]
        .filter((reservation) => reservation.active === item)
        .map((reservation) => reservation.item),
    );
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
  private publishCompleted(promptId: string, reason: 'completed' | 'failed' | 'blocked'): void { this.eventBus.publish({ type: 'prompt.completed', promptId, finishedAt: new Date().toISOString(), reason }); }
  private publishQueued(record: Record): void {
    if ((record.message.origin ?? USER_PROMPT_ORIGIN).kind !== 'user') return;
    // Count from the same snapshot `list()` exposes: a record startNext
    // already shifted into `launchingItem` (media intake still running) is
    // still queued.
    const queueLength = this.pending.length + (this.launchingItem === undefined ? 0 : 1);
    this.eventBus.publish({ type: 'prompt.queued', promptId: record.id, content: record.message.content, queueLength });
  }
  private publishAborted(promptId: string): void { this.eventBus.publish({ type: 'prompt.aborted', promptId, abortedAt: new Date().toISOString() }); }
}

function promptIdConflict(promptId: string): Error2 {
  return new Error2(ErrorCodes.PROMPT_ID_CONFLICT, `prompt id "${promptId}" is already in use`, {
    details: { promptId },
  });
}

function snapshot(item: Record): PromptSnapshot { return { id: item.id, userMessageId: item.userMessageId, createdAt: item.createdAt, state: item.state, message: item.message }; }
function cancelled(item: Record): boolean { return item.state === 'cancelled'; }
function deferred<T>(): Deferred<T> { let resolve!: (value: T) => void; let reject!: (reason: unknown) => void; const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; }); return { promise, resolve, reject }; }

registerScopedService(
  LifecycleScope.Agent,
  IAgentPromptService,
  AgentPromptService,
  ScopeActivation.OnScopeCreated,
  'prompt',
);

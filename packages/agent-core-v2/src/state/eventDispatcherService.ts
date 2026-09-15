import { produce } from 'immer';

import { BugIndicatingError } from '#/_base/errors/errors';
import { onUnexpectedError } from '#/_base/errors/unexpectedError';
import { ILogService } from '#/_base/log/log';
import { Service } from '#/_base/di/service';
import { toDisposable, type IDisposable } from '#/_base/di/lifecycle';
import { type CollectionView } from '#/_base/di/collection';
import { LifecycleScope } from '#/app/scopes';
import { ScopeActivation, registerScopedService } from '#/_base/di/scope';
import { IAgentBlobService } from '#/agent/blob/agentBlobService';
import { IAgentScopeContext } from '#/agent/scopeContext/scopeContext';
import { IAgentStateService } from '#/agent/state/agentState';
import {
  event2FromRecord,
  type AgentDomainTrait,
  type Event2,
  type Event2Class,
} from '#/app/event/event2';
import { IEventBus } from '#/app/event/eventBus';
import type { ContentPart } from '#human/llm/message';
import { OrderedHookSlot } from '#/hooks';
import { IWireService } from '#/wire/wire';
import { WireError, WireErrors } from '#/wire/errors';
import { isHumanRecordType } from '#/wire/human';
import { AGENT_SWITCHED_TYPE } from '#/wire/tree/index';
import type { PartsTransformer } from '#/wire/record';

import { IEventDispatcher, type DurableAgentRuntimeParticipant, type RestorePhase } from './eventDispatcher';
import { StateError, StateErrors } from './errors';
import {
  expandedRuntimeFolds,
  type StateFold,
  type FoldContext,
  type ReplayableStateKey,
} from './state';
import {
  EventStateContribution,
  foldEventStateContributions,
  type EventStateContributionRecord,
  type FoldedEventStateRegistry,
} from './stateContribution';

const MAX_DRAIN = 100;

const UNREPORTED_WIRE_RECORD_TYPES: ReadonlySet<string> = new Set([
  'staleGuard.recorded',
  'staleGuard.cleared',
  AGENT_SWITCHED_TYPE,
  'context.undone',
]);

export class CycleError extends StateError {
  constructor(readonly depth: number, readonly eventTypes: readonly string[]) {
    super(
      StateErrors.codes.STATE_CYCLE,
      `Event dispatch cascade exceeded MAX_DRAIN (${depth}); possible event cycle`,
      { details: { depth, eventTypes: eventTypes.slice(0, 20) } },
    );
    this.name = 'CycleError';
  }
}

interface StateMeta {
  checkpoints: unknown[];
}

interface QueuedEvent {
  readonly event: Event2<any>;
  readonly resolve: () => void;
  readonly reject: (error: unknown) => void;
}

interface PreparedFold {
  readonly key: ReplayableStateKey<any>;
  readonly meta: StateMeta;
  readonly ctx: FoldContextImpl;
  readonly next: any;
}

type ParticipantApplier = (
  state: any,
  event: Event2<any>,
  ctx: FoldContextImpl,
) => unknown;

interface ParticipantAttachment {
  readonly id: string;
  readonly appliers: ReadonlyMap<Event2Class<any, any>, ParticipantApplier>;
  readonly meta: StateMeta;
  readonly undoable: boolean;
  readonly initial: unknown;
  readonly getState: () => any;
  readonly commit: (state: any) => void;
}

interface PreparedParticipant {
  readonly attachment: ParticipantAttachment;
  readonly ctx: FoldContextImpl;
  readonly next: any;
}

class FoldContextImpl implements FoldContext {
  pendingCheckpoint = false;
  pendingClear = false;
  pendingUndo: number | undefined;

  constructor(
    private readonly owner: EventDispatcherService,
    readonly silent: boolean,
  ) {}

  checkpoint(): void {
    if (!this.silent) return;
    this.pendingCheckpoint = true;
  }

  clearCheckpoints(): void {
    if (!this.silent) return;
    this.pendingClear = true;
  }

  undoToCheckpoint(count: number): void {
    if (!this.silent) return;
    this.pendingUndo = count;
  }

  emit(event: Event2<any>): void {
    if (this.silent) return;
    this.owner.enqueue(event);
  }
}

function sanitizePendingUndo(ctx: FoldContextImpl, meta: StateMeta): void {
  if (
    ctx.pendingUndo !== undefined &&
    (!Number.isSafeInteger(ctx.pendingUndo) ||
      ctx.pendingUndo <= 0 ||
      meta.checkpoints.length < ctx.pendingUndo)
  ) {
    ctx.pendingUndo = undefined;
  }
}

export class EventDispatcherService extends Service implements IEventDispatcher {
  declare readonly _serviceBrand: undefined;

  readonly hooks: IEventDispatcher['hooks'] = {
    onDidRestore: new OrderedHookSlot(),
  };

  private readonly metas = new Map<ReplayableStateKey<any>, StateMeta>();
  private folded: FoldedEventStateRegistry;

  private readonly participantTargets = new Map<string, ParticipantAttachment[]>();
  private readonly participantAttachments = new Map<string, ParticipantAttachment>();
  restorePhase: RestorePhase = 'new';
  private dispatching = false;
  private disposed = false;
  private queue: QueuedEvent[] = [];
  private drainDepth = 0;
  private didRunRestoreHooks = false;
  private lateAttachments: Array<{
    readonly participant: DurableAgentRuntimeParticipant;
    readonly resolve: (disposable: IDisposable) => void;
    readonly reject: (error: unknown) => void;
  }> = [];

  constructor(
    @IWireService private readonly wire: IWireService,
    @IEventBus private readonly eventBus: IEventBus,
    @IAgentScopeContext private readonly agentScope: IAgentScopeContext | undefined,
    @IAgentBlobService private readonly blobService: IAgentBlobService,
    @IAgentStateService private readonly agentState: IAgentStateService,
    @ILogService private readonly logger: ILogService,
    @EventStateContribution view: CollectionView<EventStateContributionRecord>,
  ) {
    super();
    this.folded = this.foldContributions(view);
    this._register(
      view.onDidChange(() => {
        this.folded = this.foldContributions(view);
      }),
    );
    this._register(
      this.agentState.onDidContributeReplayable((key) => {
        if (this.restorePhase !== 'new') {
          throw new BugIndicatingError(
            `Replayable state '${key.name}' contributed while the event dispatcher is in phase '${this.restorePhase}'; replayable state owners must contribute before restore`,
          );
        }
        this.folded = this.foldContributions(view);
      }),
    );
    this._register(
      this.agentState.onDidWithdrawReplayable((key) => {
        this.metas.delete(key);
        this.folded = this.foldContributions(view);
      }),
    );
  }

  private foldContributions(
    view: CollectionView<EventStateContributionRecord>,
  ): FoldedEventStateRegistry {
    return foldEventStateContributions(view.items, this.agentState.replayableKeys());
  }

  attach(participant: DurableAgentRuntimeParticipant): IDisposable {
    if (this.restorePhase !== 'new') {
      throw new BugIndicatingError(
        `Agent runtime participant '${participant.id}' attached while the event dispatcher is in phase '${this.restorePhase}'; durable runtime owners must attach before restore`,
      );
    }
    const attachment = this.buildParticipantAttachment(participant);
    this.attachParticipant(attachment);
    return toDisposable(() => { this.detachParticipant(attachment); });
  }

  async attachLate(participant: DurableAgentRuntimeParticipant): Promise<IDisposable> {
    if (this.restorePhase === 'restoring') {
      return new Promise<IDisposable>((resolve, reject) => {
        this.lateAttachments.push({ participant, resolve, reject });
      });
    }
    if (this.restorePhase !== 'ready') {
      throw new BugIndicatingError(
        `Agent runtime participant '${participant.id}' late-attached while the event dispatcher is in phase '${this.restorePhase}'; late attach requires a restored dispatcher`,
      );
    }
    return this.attachLateNow(participant);
  }

  private async attachLateNow(participant: DurableAgentRuntimeParticipant): Promise<IDisposable> {
    if (this.disposed) {
      throw new Error(`Agent runtime participant '${participant.id}' late-attached to a disposed event dispatcher`);
    }
    const attachment = this.buildParticipantAttachment(participant);
    this.dispatching = true;
    try {
      await this.wire.flush();
      const stream = participant.undoable
        ? this.wire.readRestorable()
        : this.wire.readJournal();
      for await (const record of stream) {
        if (record.type === 'metadata') continue;
        const cls = this.folded.events.get(record.type);
        if (cls === undefined) continue;
        let eventRecord = record;
        if (cls.agentDomain) {
          if (this.agentScope === undefined) continue;
          const recordAgentId = record['agentId'];
          if (recordAgentId === undefined) eventRecord = { ...record, agentId: this.agentScope.agentId };
          else if (recordAgentId !== this.agentScope.agentId) continue;
        }
        const event = event2FromRecord(cls, eventRecord);
        if (event === undefined) continue;
        const applier = attachment.appliers.get(event.constructor as Event2Class);
        if (applier === undefined) continue;
        const ctx = new FoldContextImpl(this, true);
        const next = produce(
          attachment.getState(),
          (draft: any) => applier(draft, event, ctx),
        );
        if (ctx.pendingUndo !== undefined && next !== attachment.getState()) {
          throw new BugIndicatingError(
            `Fold of event '${event.type}' on durable participant '${attachment.id}' both mutates and undoes to a checkpoint`,
          );
        }
        sanitizePendingUndo(ctx, attachment.meta);
        this.commitParticipant(attachment, ctx, next);
      }
      this.attachParticipant(attachment);
      this.drainQueue();
    } catch (error) {
      for (const entry of this.queue.splice(0)) entry.reject(error);
      throw error;
    } finally {
      this.queue.length = 0;
      this.dispatching = false;
      this.drainDepth = 0;
    }
    return toDisposable(() => { this.detachParticipant(attachment); });
  }

  private buildParticipantAttachment(
    participant: DurableAgentRuntimeParticipant,
  ): ParticipantAttachment {
    const base = new Map<Event2Class<any, any>, StateFold<any, any>>();
    for (const cls of participant.events) base.set(cls, participant.transition);
    const folds = expandedRuntimeFolds(participant.id, participant.undoable, base);
    const appliers = new Map<Event2Class<any, any>, ParticipantApplier>();
    for (const [cls, fold] of folds) {
      appliers.set(cls, (state, event, ctx) => fold(state, event, ctx));
    }
    return {
      id: participant.id,
      appliers,
      meta: { checkpoints: [] },
      undoable: participant.undoable,
      initial: participant.getState(),
      getState: () => participant.getState(),
      commit: (state) => { participant.commit(state); },
    };
  }

  private attachParticipant(attachment: ParticipantAttachment): void {
    if (this.participantAttachments.has(attachment.id)) {
      throw new BugIndicatingError(`Durable participant '${attachment.id}' is already attached`);
    }
    this.participantAttachments.set(attachment.id, attachment);
    for (const cls of attachment.appliers.keys()) {
      const list = this.participantTargets.get(cls.type) ?? [];
      list.push(attachment);
      this.participantTargets.set(cls.type, list);
    }
  }

  private detachParticipant(attachment: ParticipantAttachment): void {
    if (this.participantAttachments.get(attachment.id) !== attachment) return;
    this.participantAttachments.delete(attachment.id);
    for (const cls of attachment.appliers.keys()) {
      const list = this.participantTargets.get(cls.type);
      if (list === undefined) continue;
      const next = list.filter((candidate) => candidate !== attachment);
      if (next.length === 0) this.participantTargets.delete(cls.type);
      else this.participantTargets.set(cls.type, next);
    }
  }

  dispatch(event: Event2<any>): Promise<void> {
    const cls = event.constructor as Event2Class;
    if (
      cls.agentDomain &&
      (this.agentScope === undefined ||
        (event as Event2<any> & AgentDomainTrait).agentId !== this.agentScope.agentId)
    ) {
      return Promise.reject(
        new Error(`Agent event '${event.type}' does not match dispatcher lifecycle context`),
      );
    }
    if (this.dispatching) {
      return new Promise<void>((resolve, reject) => {
        this.queue.push({ event, resolve, reject });
      });
    }
    this.dispatching = true;
    try {
      this.runDispatch(event);
      this.drainQueue();
      return Promise.resolve();
    } catch (error) {
      for (const entry of this.queue.splice(0)) {
        entry.reject(error);
      }
      return Promise.reject(error);
    } finally {
      this.queue.length = 0;
      this.dispatching = false;
      this.drainDepth = 0;
    }
  }

  private drainQueue(): void {
    while (this.queue.length > 0) {
      if (++this.drainDepth > MAX_DRAIN) {
        throw new CycleError(
          this.drainDepth,
          this.queue.map((entry) => entry.event.type),
        );
      }
      const entry = this.queue.shift()!;
      try {
        this.runDispatch(entry.event);
        entry.resolve();
      } catch (error) {
        entry.reject(error);
        throw error;
      }
    }
  }

  enqueue(event: Event2<any>): void {
    this.queue.push({
      event,
      resolve: () => {},
      reject: (error: unknown) => onUnexpectedError(error),
    });
  }

  private runDispatch(event: Event2<any>): void {
    this.executeEvent(event, false);
  }

  private executeEvent(event: Event2<any>, silent: boolean, replayUndoable?: boolean): void {
    const folds = this.folded.folds.get(event.type);
    const prepared: PreparedFold[] = [];
    if (folds !== undefined) {
      for (const { key, fold } of folds) {
        if (
          replayUndoable !== undefined &&
          (key.replayable.undoable !== undefined) !== replayUndoable
        ) {
          continue;
        }
        const meta = this.ensureMeta(key);
        const ctx = new FoldContextImpl(this, silent);
        const next = produce(
          this.agentState.get(key),
          (draft: any) => fold(draft, event, ctx),
        );
        if (ctx.pendingUndo !== undefined && next !== this.agentState.get(key)) {
          throw new BugIndicatingError(
            `Fold of event '${event.type}' on state '${key.name}' both mutates and undoes to a checkpoint`,
          );
        }
        sanitizePendingUndo(ctx, meta);
        prepared.push({ key, meta, ctx, next });
      }
    }
    const participantTargets = this.participantTargets.get(event.type);
    const preparedParticipants: PreparedParticipant[] = [];
    if (participantTargets !== undefined) {
      for (const attachment of participantTargets) {
        if (replayUndoable !== undefined && attachment.undoable !== replayUndoable) continue;
        const applier = attachment.appliers.get(event.constructor as Event2Class);
        if (applier === undefined) continue;
        const ctx = new FoldContextImpl(this, silent);
        const next = produce(
          attachment.getState(),
          (draft: any) => applier(draft, event, ctx),
        );
        if (ctx.pendingUndo !== undefined && next !== attachment.getState()) {
          throw new BugIndicatingError(
            `Fold of event '${event.type}' on durable participant '${attachment.id}' both mutates and undoes to a checkpoint`,
          );
        }
        sanitizePendingUndo(ctx, attachment.meta);
        preparedParticipants.push({ attachment, ctx, next });
      }
    }
    for (const p of prepared) {
      this.commit(p.key, p.meta, p.ctx, p.next);
    }
    for (const p of preparedParticipants) {
      this.commitParticipant(p.attachment, p.ctx, p.next);
    }
    if (silent) return;
    const cls = event.constructor as Event2Class;
    if (cls.durable) {
      const dehydrator = folds?.find(({ key }) => key.replayable.blobs !== undefined)?.key
        .replayable.blobs?.dehydrate;
      this.wire.appendRecord(event.serialize(), dehydrator);
    }
    if (cls.observable && !this.disposed) {
      this.eventBus.publish(event, this.agentScope?.agentContext);
    }
  }

  override dispose(): void {
    this.disposed = true;
    const pending = this.lateAttachments.splice(0);
    if (pending.length > 0) {
      const error = new Error('Event dispatcher disposed while a late attach was pending');
      for (const entry of pending) entry.reject(error);
    }
    super.dispose();
  }

  private commit(
    key: ReplayableStateKey<any>,
    meta: StateMeta,
    ctx: FoldContextImpl,
    next: any,
  ): void {
    if (ctx.pendingUndo !== undefined) {
      const targetIndex = meta.checkpoints.length - ctx.pendingUndo;
      const snapshot = meta.checkpoints[targetIndex]!;
      this.agentState.set(key, snapshot);
      meta.checkpoints.length = targetIndex;
      return;
    }
    this.agentState.set(key, next);
    if (ctx.pendingClear) {
      meta.checkpoints.length = 0;
    }
    if (ctx.pendingCheckpoint) {
      meta.checkpoints.push(next);
    }
  }

  private commitParticipant(
    attachment: ParticipantAttachment,
    ctx: FoldContextImpl,
    next: any,
  ): void {
    const meta = attachment.meta;
    if (ctx.pendingUndo !== undefined) {
      const targetIndex = meta.checkpoints.length - ctx.pendingUndo;
      const snapshot = meta.checkpoints[targetIndex]!;
      attachment.commit(snapshot);
      meta.checkpoints.length = targetIndex;
      return;
    }
    attachment.commit(next);
    if (ctx.pendingClear) {
      meta.checkpoints.length = 0;
    }
    if (ctx.pendingCheckpoint) {
      meta.checkpoints.push(next);
    }
  }

  private ensureMeta(key: ReplayableStateKey<any>): StateMeta {
    let meta = this.metas.get(key);
    if (meta === undefined) {
      meta = { checkpoints: [] };
      this.metas.set(key, meta);
    }
    return meta;
  }

  async restore(): Promise<void> {
    if (this.restorePhase === 'restoring') {
      throw new BugIndicatingError(
        `Agent state restore called while phase is ${this.restorePhase}`,
      );
    }
    const rerun = this.restorePhase !== 'new';
    this.restorePhase = 'restoring';
    if (rerun) this.dispatching = true;
    try {
      if (rerun) {
        await this.wire.flush();
        this.resetReplayState();
      }
      await this.replayRecords(true);
      await this.replayRecords(false);
      await this.rehydrateStates();
      this.restorePhase = 'ready';
      if (!this.didRunRestoreHooks) {
        await this.hooks.onDidRestore.run({});
        this.didRunRestoreHooks = true;
      }
      if (rerun) {
        this.drainQueue();
      }
      await this.drainLateAttachments();
    } catch (error) {
      this.restorePhase = 'failed';
      for (const pending of this.lateAttachments.splice(0)) pending.reject(error);
      if (rerun) {
        for (const entry of this.queue.splice(0)) entry.reject(error);
      }
      throw error;
    } finally {
      if (rerun) {
        this.queue.length = 0;
        this.dispatching = false;
        this.drainDepth = 0;
      }
    }
  }

  private async drainLateAttachments(): Promise<void> {
    for (const pending of this.lateAttachments.splice(0)) {
      try {
        pending.resolve(await this.attachLateNow(pending.participant));
      } catch (error) {
        pending.reject(error);
      }
    }
  }

  private resetReplayState(): void {
    for (const key of this.agentState.replayableKeys()) {
      this.agentState.set(key, key.initial());
    }
    for (const attachment of this.participantAttachments.values()) {
      attachment.commit(attachment.initial);
      attachment.meta.checkpoints.length = 0;
    }
    this.metas.clear();
  }

  private async replayRecords(undoable: boolean): Promise<void> {
    const stream = undoable ? this.wire.readRestorable() : this.wire.readJournal();
    let recordIndex = 0;
    for await (const record of stream) {
      if (record.type === 'metadata') continue;
      const cls = this.folded.events.get(record.type);
      if (cls === undefined) {
        if (
          !undoable &&
          !UNREPORTED_WIRE_RECORD_TYPES.has(record.type) &&
          !isHumanRecordType(record.type)
        ) {
          this.reportSkippedRecord(record.type, recordIndex, false);
        }
        recordIndex++;
        continue;
      }
      let eventRecord = record;
      if (cls.agentDomain) {
        if (this.agentScope === undefined) {
          if (!undoable) this.reportSkippedRecord(record.type, recordIndex, true);
          recordIndex++;
          continue;
        }
        const recordAgentId = record['agentId'];
        if (recordAgentId === undefined) {
          eventRecord = { ...record, agentId: this.agentScope.agentId };
        } else if (recordAgentId !== this.agentScope.agentId) {
          if (!undoable) this.reportSkippedRecord(record.type, recordIndex, true);
          recordIndex++;
          continue;
        }
      }
      const event = event2FromRecord(cls, eventRecord);
      if (event === undefined) {
        if (!undoable) this.reportSkippedRecord(record.type, recordIndex, true);
        recordIndex++;
        continue;
      }
      this.executeEvent(event, true, undoable);
      recordIndex++;
    }
  }

  private reportSkippedRecord(type: string, index: number, malformed: boolean): void {
    const message = malformed
      ? `Malformed wire record type '${type}' skipped during restore`
      : `Unknown wire record type '${type}' skipped during restore`;
    if (malformed) {
      onUnexpectedError(
        new WireError(WireErrors.codes.WIRE_UNKNOWN_RECORD, message, { details: { type, index } }),
      );
      return;
    }
    this.logger.warn(message, { code: WireErrors.codes.WIRE_UNKNOWN_RECORD, type, index });
  }

  private async rehydrateStates(): Promise<void> {
    const transform: PartsTransformer = (parts) =>
      this.blobService.loadParts(parts as readonly ContentPart[]) as Promise<readonly unknown[]>;
    for (const key of this.folded.states) {
      const codec = key.replayable.blobs;
      if (codec?.rehydrate === undefined) continue;
      this.agentState.set(key, Object.freeze(await codec.rehydrate(this.agentState.get(key), transform)));
    }
  }

  async flush(): Promise<void> {
    await this.wire.flush();
  }
}

registerScopedService(
  LifecycleScope.Agent,
  IEventDispatcher,
  EventDispatcherService,
  ScopeActivation.OnScopeCreated,
  'state',
);

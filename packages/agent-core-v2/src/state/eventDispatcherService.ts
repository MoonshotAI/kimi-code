import { applyPatches, produceWithPatches } from 'immer';

import { BugIndicatingError } from '#/_base/errors/errors';
import { onUnexpectedError } from '#/_base/errors/unexpectedError';
import { Service } from '#/_base/di/service';
import { toDisposable, type IDisposable } from '#/_base/di/lifecycle';
import { type CollectionView } from '#/_base/di/collection';
import { IAgentBlobService } from '#/agent/blob/agentBlobService';
import type { IAgentScopeContext } from '#/agent/scopeContext/scopeContext';
import { type DurableAgentRuntimeParticipant } from '#/agent/runtime/agentRuntime';
import { IAgentStateService } from '#/agent/state/agentState';
import {
  event2FromRecord,
  type AgentDomainTrait,
  type Event2,
  type Event2Class,
} from '#/app/event/event2';
import { IEventBus } from '#/app/event/eventBus';
import type { ContentPart } from '#/kosong/contract/message';
import { OrderedHookSlot } from '#/hooks';
import { IWireService } from '#/wire/wire';
import { WireError, WireErrors } from '#/wire/errors';
import type { PartsTransformer } from '#/wire/record';

import { IEventDispatcher, type ParticipantCheckpointDepth } from './eventDispatcher';
import { StateError, StateErrors } from './errors';
import {
  expandedRuntimeFolds,
  keepsUndoCheckpoints,
  type StateBlobCodec,
  type StateFold,
  type FoldContext,
  type PatchEntry,
  type ReplayableStateKey,
} from './state';
import {
  EventStateContribution,
  foldEventStateContributions,
  type EventStateContributionRecord,
  type FoldedEventStateRegistry,
} from './stateContribution';

const MAX_DRAIN = 100;
const HISTORY_TAIL = 500;

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
  history: PatchEntry[];
  checkpoints: number[];
  nextPatchId: number;
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
  readonly patches: PatchEntry['patches'];
  readonly inversePatches: PatchEntry['inversePatches'];
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
  readonly keepsCheckpoints: boolean;
  readonly blobs?: StateBlobCodec<any>;
  readonly getState: () => any;
  readonly commit: (state: any) => void;
}

interface PreparedParticipant {
  readonly attachment: ParticipantAttachment;
  readonly ctx: FoldContextImpl;
  readonly next: any;
  readonly patches: PatchEntry['patches'];
  readonly inversePatches: PatchEntry['inversePatches'];
}

type RestorePhase = 'new' | 'restoring' | 'ready' | 'failed';

class FoldContextImpl implements FoldContext {
  pendingCheckpoint = false;
  pendingClear = false;
  pendingUndo: number | undefined;

  constructor(
    private readonly owner: EventDispatcherService,
    readonly silent: boolean,
  ) {}

  checkpoint(): void {
    this.pendingCheckpoint = true;
  }

  clearCheckpoints(): void {
    this.pendingClear = true;
  }

  undoToCheckpoint(count: number): void {
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

  private restorePhase: RestorePhase = 'new';
  private dispatching = false;
  private disposed = false;
  private queue: QueuedEvent[] = [];
  private drainDepth = 0;

  constructor(
    @IWireService private readonly wire: IWireService,
    @IEventBus private readonly eventBus: IEventBus,
    private readonly agentScope: IAgentScopeContext | undefined,
    @IAgentBlobService private readonly blobService: IAgentBlobService,
    @IAgentStateService private readonly agentState: IAgentStateService,
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
    const base = new Map<Event2Class<any, any>, StateFold<any, any>>();
    for (const cls of participant.events) base.set(cls, participant.transition);
    const folds = expandedRuntimeFolds(
      participant.id,
      participant.undoable,
      base,
      participant.onUndo,
    );
    const appliers = new Map<Event2Class<any, any>, ParticipantApplier>();
    for (const [cls, fold] of folds) {
      appliers.set(cls, (state, event, ctx) => fold(state, event, ctx));
    }
    const attachment: ParticipantAttachment = {
      id: participant.id,
      appliers,
      meta: { history: [], checkpoints: [], nextPatchId: 1 },
      undoable: participant.undoable,
      keepsCheckpoints: participant.undoable && participant.onUndo === undefined,
      blobs: participant.blobs,
      getState: () => participant.getState(),
      commit: (state) => { participant.commit(state); },
    };
    this.attachParticipant(attachment);
    return toDisposable(() => { this.detachParticipant(attachment); });
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

  history<S>(key: ReplayableStateKey<S>): readonly PatchEntry[] {
    return this.ensureMeta(key).history;
  }

  checkpointDepth(key: ReplayableStateKey<any>): number {
    const meta = this.metas.get(key);
    return meta?.checkpoints.length ?? 0;
  }

  participantCheckpointDepths(): readonly ParticipantCheckpointDepth[] {
    const depths: ParticipantCheckpointDepth[] = [];
    for (const attachment of this.participantAttachments.values()) {
      if (!attachment.keepsCheckpoints) continue;
      depths.push({ id: attachment.id, depth: attachment.meta.checkpoints.length });
    }
    return depths;
  }

  undo<S>(key: ReplayableStateKey<S>, patchId: number): void {
    const meta = this.ensureMeta(key);
    const head = meta.history.at(-1);
    if (head === undefined || patchId > head.id || patchId <= 0) {
      throw new BugIndicatingError(
        `undo patch id ${patchId} is outside the retained history of state '${key.name}'`,
      );
    }
    const firstRetained = meta.history[0]!.id;
    if (patchId < firstRetained) {
      throw new BugIndicatingError(
        `undo patch id ${patchId} has been trimmed from the history of state '${key.name}'`,
      );
    }
    this.rollback(key, meta, patchId - 1);
    meta.checkpoints = meta.checkpoints.filter((id) => id < patchId);
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

  private executeEvent(event: Event2<any>, silent: boolean): void {
    const folds = this.folded.folds.get(event.type);
    const prepared: PreparedFold[] = [];
    if (folds !== undefined) {
      for (const { key, fold } of folds) {
        const meta = this.ensureMeta(key);
        const ctx = new FoldContextImpl(this, silent);
        const [next, patches, inversePatches] = produceWithPatches<any>(
          this.agentState.get(key),
          (draft: any) => fold(draft, event, ctx) as any,
        );
        if (ctx.pendingUndo !== undefined && patches.length > 0) {
          throw new BugIndicatingError(
            `Fold of event '${event.type}' on state '${key.name}' both mutates and undoes to a checkpoint`,
          );
        }
        sanitizePendingUndo(ctx, meta);
        prepared.push({ key, meta, ctx, next, patches, inversePatches });
      }
    }
    const participantTargets = this.participantTargets.get(event.type);
    const preparedParticipants: PreparedParticipant[] = [];
    if (participantTargets !== undefined) {
      for (const attachment of participantTargets) {
        const applier = attachment.appliers.get(event.constructor as Event2Class);
        if (applier === undefined) continue;
        const ctx = new FoldContextImpl(this, silent);
        const [next, patches, inversePatches] = produceWithPatches<any>(
          attachment.getState(),
          (draft: any) => applier(draft, event, ctx) as any,
        );
        if (ctx.pendingUndo !== undefined && patches.length > 0) {
          throw new BugIndicatingError(
            `Fold of event '${event.type}' on durable participant '${attachment.id}' both mutates and undoes to a checkpoint`,
          );
        }
        sanitizePendingUndo(ctx, attachment.meta);
        preparedParticipants.push({ attachment, ctx, next, patches, inversePatches });
      }
    }
    for (const p of prepared) {
      this.commit(p.key, p.meta, p.ctx, event, p.next, p.patches, p.inversePatches);
    }
    for (const p of preparedParticipants) {
      this.commitParticipant(p.attachment, p.ctx, event, p.next, p.patches, p.inversePatches);
    }
    if (silent) return;
    const cls = event.constructor as Event2Class;
    if (cls.durable) {
      const dehydrator =
        folds?.find(({ key }) => key.replayable.blobs !== undefined)?.key.replayable.blobs
          ?.dehydrate ??
        participantTargets?.find((attachment) => attachment.blobs !== undefined)?.blobs
          ?.dehydrate;
      this.wire.appendRecord(event.serialize(), dehydrator);
    }
    if (cls.observable && !this.disposed) {
      this.eventBus.publish(event, this.agentScope?.agentContext);
    }
  }

  override dispose(): void {
    this.disposed = true;
    super.dispose();
  }

  private commit(
    key: ReplayableStateKey<any>,
    meta: StateMeta,
    ctx: FoldContextImpl,
    event: Event2<any>,
    next: any,
    patches: PatchEntry['patches'],
    inversePatches: PatchEntry['inversePatches'],
  ): void {
    if (ctx.pendingUndo !== undefined) {
      const targetIndex = meta.checkpoints.length - ctx.pendingUndo;
      const targetId = meta.checkpoints[targetIndex]!;
      this.rollback(key, meta, targetId);
      meta.checkpoints = meta.checkpoints.slice(0, targetIndex);
      return;
    }
    this.agentState.set(key, next);
    if (ctx.pendingClear) {
      meta.history = [];
      meta.checkpoints = [];
    }
    let markerId = meta.history.at(-1)?.id ?? 0;
    if (patches.length > 0 || inversePatches.length > 0) {
      const entry: PatchEntry = {
        id: meta.nextPatchId++,
        eventType: event.type,
        patches,
        inversePatches,
      };
      meta.history.push(entry);
      markerId = entry.id;
    }
    if (ctx.pendingCheckpoint) {
      meta.checkpoints.push(markerId);
    }
    this.trimHistory(key, meta);
  }

  private commitParticipant(
    attachment: ParticipantAttachment,
    ctx: FoldContextImpl,
    event: Event2<any>,
    next: any,
    patches: PatchEntry['patches'],
    inversePatches: PatchEntry['inversePatches'],
  ): void {
    const meta = attachment.meta;
    if (ctx.pendingUndo !== undefined) {
      const targetIndex = meta.checkpoints.length - ctx.pendingUndo;
      const targetId = meta.checkpoints[targetIndex]!;
      this.rollbackParticipant(attachment, targetId);
      meta.checkpoints = meta.checkpoints.slice(0, targetIndex);
      return;
    }
    attachment.commit(next);
    if (ctx.pendingClear) {
      meta.history = [];
      meta.checkpoints = [];
    }
    let markerId = meta.history.at(-1)?.id ?? 0;
    if (patches.length > 0 || inversePatches.length > 0) {
      const entry: PatchEntry = {
        id: meta.nextPatchId++,
        eventType: event.type,
        patches,
        inversePatches,
      };
      meta.history.push(entry);
      markerId = entry.id;
    }
    if (ctx.pendingCheckpoint) meta.checkpoints.push(markerId);
    this.trimParticipantHistory(attachment);
  }

  private rollback(key: ReplayableStateKey<any>, meta: StateMeta, targetEntryId: number): void {
    let i = meta.history.length - 1;
    let current = this.agentState.get(key);
    while (i >= 0 && meta.history[i]!.id > targetEntryId) {
      current = applyPatches(current, [...meta.history[i]!.inversePatches]);
      i--;
    }
    this.agentState.set(key, current);
    meta.history = meta.history.slice(0, i + 1);
  }

  private rollbackParticipant(
    attachment: ParticipantAttachment,
    targetEntryId: number,
  ): void {
    const meta = attachment.meta;
    let i = meta.history.length - 1;
    let current = attachment.getState();
    while (i >= 0 && meta.history[i]!.id > targetEntryId) {
      current = applyPatches(current, [...meta.history[i]!.inversePatches]);
      i--;
    }
    attachment.commit(current);
    meta.history = meta.history.slice(0, i + 1);
  }

  private trimHistory(key: ReplayableStateKey<any>, meta: StateMeta): void {
    const oldest = meta.checkpoints[0];
    if (oldest !== undefined) {
      const firstRetained = meta.history.findIndex((entry) => entry.id >= oldest);
      if (firstRetained > 0) {
        meta.history.splice(0, firstRetained);
      }
      return;
    }
    if (!keepsUndoCheckpoints(key) && meta.history.length > HISTORY_TAIL) {
      meta.history.splice(0, meta.history.length - HISTORY_TAIL);
    }
  }

  private trimParticipantHistory(attachment: ParticipantAttachment): void {
    const meta = attachment.meta;
    const oldest = meta.checkpoints[0];
    if (oldest !== undefined) {
      const firstRetained = meta.history.findIndex((entry) => entry.id >= oldest);
      if (firstRetained > 0) meta.history.splice(0, firstRetained);
      return;
    }
    if (!attachment.keepsCheckpoints && meta.history.length > HISTORY_TAIL) {
      meta.history.splice(0, meta.history.length - HISTORY_TAIL);
    }
  }

  private ensureMeta(key: ReplayableStateKey<any>): StateMeta {
    let meta = this.metas.get(key);
    if (meta === undefined) {
      meta = { history: [], checkpoints: [], nextPatchId: 1 };
      this.metas.set(key, meta);
    }
    return meta;
  }

  async restore(): Promise<void> {
    if (this.restorePhase !== 'new') {
      throw new BugIndicatingError(
        `Agent state restore called while phase is ${this.restorePhase}`,
      );
    }
    this.restorePhase = 'restoring';
    try {
      let recordIndex = 0;
      for await (const record of this.wire.readJournal()) {
        if (record.type === 'metadata') continue;
        const cls = this.folded.events.get(record.type);
        if (cls === undefined) {
          this.reportSkippedRecord(record.type, recordIndex, false);
          recordIndex++;
          continue;
        }
        let eventRecord = record;
        if (cls.agentDomain) {
          if (this.agentScope === undefined) {
            this.reportSkippedRecord(record.type, recordIndex, true);
            recordIndex++;
            continue;
          }
          const recordAgentId = record['agentId'];
          if (recordAgentId === undefined) {
            eventRecord = { ...record, agentId: this.agentScope.agentId };
          } else if (recordAgentId !== this.agentScope.agentId) {
            this.reportSkippedRecord(record.type, recordIndex, true);
            recordIndex++;
            continue;
          }
        }
        const event = event2FromRecord(cls, eventRecord);
        if (event === undefined) {
          this.reportSkippedRecord(record.type, recordIndex, true);
          recordIndex++;
          continue;
        }
        this.executeEvent(event, true);
        recordIndex++;
      }
      await this.rehydrateStates();
      this.restorePhase = 'ready';
      await this.hooks.onDidRestore.run({});
    } catch (error) {
      this.restorePhase = 'failed';
      throw error;
    }
  }

  private reportSkippedRecord(type: string, index: number, malformed: boolean): void {
    onUnexpectedError(
      new WireError(
        WireErrors.codes.WIRE_UNKNOWN_RECORD,
        malformed
          ? `Malformed wire record type '${type}' skipped during restore`
          : `Unknown wire record type '${type}' skipped during restore`,
        { details: { type, index } },
      ),
    );
  }

  private async rehydrateStates(): Promise<void> {
    const transform: PartsTransformer = (parts) =>
      this.blobService.loadParts(parts as readonly ContentPart[]) as Promise<readonly unknown[]>;
    for (const key of this.folded.states) {
      const codec = key.replayable.blobs;
      if (codec?.rehydrate === undefined) continue;
      this.agentState.set(key, Object.freeze(await codec.rehydrate(this.agentState.get(key), transform)));
    }
    for (const attachment of this.participantAttachments.values()) {
      const codec = attachment.blobs;
      if (codec?.rehydrate === undefined) continue;
      attachment.commit(Object.freeze(await codec.rehydrate(attachment.getState(), transform)));
    }
  }

  async flush(): Promise<void> {
    await this.wire.flush();
  }
}


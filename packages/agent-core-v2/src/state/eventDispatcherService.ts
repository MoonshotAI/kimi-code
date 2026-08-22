import { applyPatches, produceWithPatches } from 'immer';

import { BugIndicatingError } from '#/_base/errors/errors';
import { onUnexpectedError } from '#/_base/errors/unexpectedError';
import { Service } from '#/_base/di/service';
import { type CollectionView } from '#/_base/di/collection';
import { LifecycleScope } from '#/app/scopes';
import { ScopeActivation, registerScopedService } from '#/_base/di/scope';
import { AgentSpaceImpl, type AgentSpaceHost } from '#/agent/agentContext/agentSpace';
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
import type { ContentPart } from '#/kosong/contract/message';
import { OrderedHookSlot } from '#/hooks';
import { IWireService } from '#/wire/wire';
import { WireError, WireErrors } from '#/wire/errors';
import type { PartsTransformer } from '#/wire/record';

import {
  AgentModelContribution,
  agentModelDefinitions,
  type AgentModel,
  type AgentModelDefinition,
} from './agentModel';
import { IEventDispatcher, type ModelCheckpointDepth } from './eventDispatcher';
import { StateError, StateErrors } from './errors';
import {
  expandedModelAppliers,
  keepsUndoCheckpoints,
  type EventApplier,
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

interface ModelAttachment {
  readonly definition: AgentModelDefinition<any, any>;
  readonly model: AgentModel<any>;
  readonly appliers: ReadonlyMap<Event2Class<any, any>, EventApplier>;
  readonly meta: StateMeta;
  readonly keepsCheckpoints: boolean;
}

interface PreparedModel {
  readonly attachment: ModelAttachment;
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

  private activeModelDefs = new Map<string, AgentModelDefinition<any, any>>();
  private readonly withdrawnModelIds = new Set<string>();
  private modelTargets = new Map<string, readonly AgentModelDefinition<any, any>[]>();
  private readonly attachments = new Map<AgentModelDefinition<any, any>, ModelAttachment>();

  private readonly spaceHost: AgentSpaceHost = {
    isActiveModelDefinition: (definition) =>
      this.activeModelDefs.get(definition.id) === definition,
    registerModel: (definition, model) => this.registerModel(definition, model),
    dispatchModelEvent: (event) => this.dispatch(event),
    readLegacyState: (key) => this.agentState.get(key),
  };

  private restorePhase: RestorePhase = 'new';
  private dispatching = false;
  private disposed = false;
  private queue: QueuedEvent[] = [];
  private drainDepth = 0;

  constructor(
    @IWireService private readonly wire: IWireService,
    @IEventBus private readonly eventBus: IEventBus,
    @IAgentScopeContext private readonly agentScope: IAgentScopeContext | undefined,
    @IAgentBlobService private readonly blobService: IAgentBlobService,
    @IAgentStateService private readonly agentState: IAgentStateService,
    @EventStateContribution view: CollectionView<EventStateContributionRecord>,
    @AgentModelContribution modelView: CollectionView<AgentModelDefinition<any, any>>,
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
    this.refoldModels(modelView.items);
    this._register(
      modelView.onDidChange(({ added, removed }) => {
        for (const definition of removed) {
          this.withdrawnModelIds.add(definition.id);
          const attachment = this.attachments.get(definition);
          if (attachment !== undefined) {
            this.attachments.delete(definition);
            this.space()?.retireModel(definition);
          }
        }
        for (const definition of added) {
          this.withdrawnModelIds.delete(definition.id);
        }
        this.refoldModels(modelView.items);
        this.materializeUndoableModels();
      }),
    );
    this.space()?._attachHost(this.spaceHost);
    this.materializeUndoableModels();
  }

  private space(): AgentSpaceImpl | undefined {
    const space = this.agentScope?.agentContext.space;
    return space instanceof AgentSpaceImpl ? space : undefined;
  }

  private foldContributions(
    view: CollectionView<EventStateContributionRecord>,
  ): FoldedEventStateRegistry {
    return foldEventStateContributions(view.items, this.agentState.replayableKeys());
  }

  private refoldModels(records: readonly AgentModelDefinition<any, any>[]): void {
    const defs = new Map<string, AgentModelDefinition<any, any>>();
    for (const definition of agentModelDefinitions()) {
      if (!this.withdrawnModelIds.has(definition.id)) defs.set(definition.id, definition);
    }
    for (const definition of records) defs.set(definition.id, definition);
    this.activeModelDefs = defs;
    this.rebuildModelTargets();
  }

  private rebuildModelTargets(): void {
    const targets = new Map<string, AgentModelDefinition<any, any>[]>();
    const add = (type: string, definition: AgentModelDefinition<any, any>): void => {
      const list = targets.get(type);
      if (list === undefined) {
        targets.set(type, [definition]);
        return;
      }
      if (!list.includes(definition)) list.push(definition);
    };
    const domainOwners = new Map<string, AgentModelDefinition<any, any>>();
    for (const definition of this.activeModelDefs.values()) {
      for (const cls of definition.events) {
        const owner = domainOwners.get(cls.type);
        if (owner !== undefined && owner !== definition) {
          throw new BugIndicatingError(
            `Event '${cls.type}' is applied by both agent models '${owner.id}' and '${definition.id}'`,
          );
        }
        domainOwners.set(cls.type, definition);
        add(cls.type, definition);
      }
    }
    for (const [definition, attachment] of this.attachments) {
      if (this.activeModelDefs.get(definition.id) !== definition) continue;
      for (const cls of attachment.appliers.keys()) add(cls.type, definition);
    }
    this.modelTargets = targets;
  }

  private materializeUndoableModels(): void {
    const space = this.space();
    if (space === undefined) return;
    for (const definition of this.activeModelDefs.values()) {
      if (!definition.undoable || this.attachments.has(definition)) continue;
      space.ensureModel(definition);
    }
  }

  private registerModel(
    definition: AgentModelDefinition<any, any>,
    model: AgentModel<any>,
  ): void {
    if (this.attachments.has(definition)) return;
    const domainAppliers = new Map<Event2Class<any, any>, EventApplier>();
    for (const [cls, applier] of model._appliersTable()) {
      domainAppliers.set(cls, (event) => applier.call(model, event));
    }
    const customUndo =
      model.onUndo === undefined ? undefined : (count: number): void => model.onUndo!(count);
    const expanded = expandedModelAppliers(
      definition.id,
      definition.undoable,
      domainAppliers,
      customUndo,
    );
    this.attachments.set(definition, {
      definition,
      model,
      appliers: expanded,
      meta: { history: [], checkpoints: [], nextPatchId: 1 },
      keepsCheckpoints: definition.undoable && customUndo === undefined,
    });
    this.rebuildModelTargets();
  }

  private materializeModel(definition: AgentModelDefinition<any, any>): ModelAttachment {
    const space = this.space();
    if (space === undefined) {
      throw new BugIndicatingError(
        `Agent model '${definition.id}' cannot materialize without an agent space`,
      );
    }
    space.ensureModel(definition);
    const attachment = this.attachments.get(definition);
    if (attachment === undefined) {
      throw new BugIndicatingError(`Agent model '${definition.id}' failed to attach`);
    }
    return attachment;
  }

  history<S>(key: ReplayableStateKey<S>): readonly PatchEntry[] {
    return this.ensureMeta(key).history;
  }

  checkpointDepth(key: ReplayableStateKey<any>): number {
    const meta = this.metas.get(key);
    return meta?.checkpoints.length ?? 0;
  }

  modelCheckpointDepths(): readonly ModelCheckpointDepth[] {
    const depths: ModelCheckpointDepth[] = [];
    for (const attachment of this.attachments.values()) {
      if (!attachment.keepsCheckpoints) continue;
      depths.push({ id: attachment.definition.id, depth: attachment.meta.checkpoints.length });
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
    const modelTargets = this.modelTargets.get(event.type);
    const preparedModels: PreparedModel[] = [];
    if (modelTargets !== undefined) {
      for (const definition of modelTargets) {
        const attachment = this.attachments.get(definition) ?? this.materializeModel(definition);
        const applier = attachment.appliers.get(event.constructor as Event2Class);
        if (applier === undefined) continue;
        const ctx = new FoldContextImpl(this, silent);
        const [next, patches, inversePatches] = produceWithPatches<any>(
          attachment.model._state(),
          (draft: any) => {
            attachment.model._enterWindow(draft, ctx);
            let windowResult: ReturnType<AgentModel<any>['_exitWindow']>;
            try {
              applier(event, ctx);
            } finally {
              windowResult = attachment.model._exitWindow();
            }
            return windowResult.replaced ? windowResult.replacement : undefined;
          },
        );
        if (ctx.pendingUndo !== undefined && patches.length > 0) {
          throw new BugIndicatingError(
            `Applier of event '${event.type}' on model '${definition.id}' both mutates and undoes to a checkpoint`,
          );
        }
        sanitizePendingUndo(ctx, attachment.meta);
        preparedModels.push({ attachment, ctx, next, patches, inversePatches });
      }
    }
    for (const p of prepared) {
      this.commit(p.key, p.meta, p.ctx, event, p.next, p.patches, p.inversePatches);
    }
    for (const p of preparedModels) {
      this.commitModel(p.attachment, p.ctx, event, p.next, p.patches, p.inversePatches);
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
    const space = this.space();
    if (space !== undefined) {
      space._detachHost(this.spaceHost);
      space._kill();
    }
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

  private commitModel(
    attachment: ModelAttachment,
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
      this.rollbackModel(attachment, targetId);
      meta.checkpoints = meta.checkpoints.slice(0, targetIndex);
      return;
    }
    attachment.model._commitState(next);
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
    this.trimModelHistory(attachment);
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

  private rollbackModel(attachment: ModelAttachment, targetEntryId: number): void {
    const meta = attachment.meta;
    let i = meta.history.length - 1;
    let current = attachment.model._state();
    while (i >= 0 && meta.history[i]!.id > targetEntryId) {
      current = applyPatches(current, [...meta.history[i]!.inversePatches]);
      i--;
    }
    attachment.model._commitState(current);
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

  private trimModelHistory(attachment: ModelAttachment): void {
    const meta = attachment.meta;
    const oldest = meta.checkpoints[0];
    if (oldest !== undefined) {
      const firstRetained = meta.history.findIndex((entry) => entry.id >= oldest);
      if (firstRetained > 0) {
        meta.history.splice(0, firstRetained);
      }
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

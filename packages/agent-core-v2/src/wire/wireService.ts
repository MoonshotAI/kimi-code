/**
 * `wire` domain (L2) — `IWireService` implementation.
 *
 * `WireService` is the sole runtime owner of an Agent wire aggregate. It
 * combines the model reducer engine with the `wire.jsonl` journal protocol,
 * including metadata, migrations, atomic healing rewrites, blob dehydration
 * and rehydration, ref-counted derived projections, and restore completion. It
 * is bound at Agent scope because the aggregate identity is the Agent identity.
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

import { InstantiationType } from '#/_base/di/extensions';
import { BugIndicatingError } from '#/_base/errors/errors';
import { onUnexpectedError } from '#/_base/errors/unexpectedError';
import { Emitter } from '#/_base/event';
import {
  combinedDisposable,
  Disposable,
  toDisposable,
  type IDisposable,
} from '#/_base/di/lifecycle';
import { LifecycleScope, registerScopedService } from '#/_base/di/scope';
import { IAgentBlobService } from '#/agent/blob/agentBlobService';
import { IAgentScopeContext } from '#/agent/scopeContext/scopeContext';
import { type DomainEvent, IEventBus } from '#/app/event/eventBus';
import type { ContentPart } from '#/app/llmProtocol/message';
import { IAppendLogStore } from '#/persistence/interface/appendLogStore';
import { StorageError, StorageErrors } from '#/persistence/interface/storage';

import { IWireService } from './wire';
import { WireError, WireErrors } from './errors';
import {
  WIRE_PROTOCOL_VERSION,
  isNewerWireVersion,
  migrateWireRecord,
  resolveWireMigrations,
  type WireMigration,
} from './migration/migration';
import type { DeepReadonly, DerivedModelDef, ModelDef, PartsTransformer } from './model';
import { MODEL_CROSS_REDUCERS } from './model';
import type { Op } from './op';
import { OP_REGISTRY } from './op';
import {
  AGENT_WIRE_RECORD_KEY,
  createWireMetadataRecord,
  isWireMetadataRecord,
  opToWireRecord,
  wireRecordToPayload,
  type WireRecord,
} from './record';

const MAX_DRAIN = 100;

export class CycleError extends WireError {
  constructor(readonly depth: number, readonly opTypes: readonly string[]) {
    super(
      WireErrors.codes.WIRE_CYCLE,
      `Wire dispatch cascade exceeded MAX_DRAIN (${depth}); possible op cycle`,
      { details: { depth, opTypes: opTypes.slice(0, 20) } },
    );
    this.name = 'CycleError';
  }
}

interface ModelChange<S> {
  readonly state: S;
  readonly prev: S;
}

interface ModelInstance {
  state: any;
  emitter: Emitter<ModelChange<any>>;
}

interface DerivedModelInstance {
  readonly inst: ModelInstance;
  references: number;
}

interface ReducerEntry {
  readonly inst: ModelInstance;
  readonly reducer: (state: any, payload: any) => any;
}

interface OpGroup {
  readonly ops: readonly Op[];
  readonly silent: boolean;
}

type RestorePhase = 'new' | 'restoring' | 'ready' | 'failed';

export class WireService extends Disposable implements IWireService {
  declare readonly _serviceBrand: undefined;

  private readonly models = new Map<ModelDef<any>, ModelInstance>();
  private readonly derivedModels = new Map<DerivedModelDef<any>, DerivedModelInstance>();
  private readonly reducerIndex = new Map<string, ReducerEntry[]>();
  private readonly restoredHandlers = new Set<() => void | Promise<void>>();
  private readonly wireScope: string;

  private restorePhase: RestorePhase = 'new';
  private dispatching = false;
  private queue: Op[] = [];
  private drainDepth = 0;
  private persistQueue: Promise<void> | undefined;

  constructor(
    @IAgentScopeContext scopeContext: IAgentScopeContext,
    @IAppendLogStore private readonly log: IAppendLogStore,
    @IAgentBlobService private readonly blobService: IAgentBlobService,
    @IEventBus private readonly eventBus: IEventBus,
  ) {
    super();
    this.wireScope = scopeContext.scope();
    this._register(this.log.acquire(this.wireScope, AGENT_WIRE_RECORD_KEY));
  }

  getModel<S>(model: ModelDef<S>): DeepReadonly<S> {
    return this.ensureModel(model).state as DeepReadonly<S>;
  }

  subscribe<S>(
    model: ModelDef<S> | DerivedModelDef<S>,
    handler: (state: DeepReadonly<S>, prev: DeepReadonly<S>) => void,
  ): IDisposable {
    if ('reducers' in model) {
      const derived = this.acquireDerivedModel(model);
      return combinedDisposable(
        derived.inst.emitter.event((change) =>
          handler(change.state as DeepReadonly<S>, change.prev as DeepReadonly<S>),
        ),
        derived.release,
      );
    }
    const inst = this.ensureModel(model);
    const subscription = inst.emitter.event((change) =>
      handler(change.state as DeepReadonly<S>, change.prev as DeepReadonly<S>),
    );
    return subscription;
  }

  onRestored(handler: () => void | Promise<void>): IDisposable {
    this.restoredHandlers.add(handler);
    return toDisposable(() => this.restoredHandlers.delete(handler));
  }

  private acquireDerivedModel<S>(model: DerivedModelDef<S>): {
    readonly inst: ModelInstance;
    readonly release: IDisposable;
  } {
    const existing = this.derivedModels.get(model);
    if (existing !== undefined) {
      existing.references++;
      return {
        inst: existing.inst,
        release: toDisposable(() => this.releaseDerivedModel(model, existing)),
      };
    }
    const inst: ModelInstance = {
      state: Object.freeze(model.initial()),
      emitter: new Emitter<ModelChange<unknown>>(),
    };
    this._register(inst.emitter);
    const entry: DerivedModelInstance = { inst, references: 1 };
    this.derivedModels.set(model, entry);

    for (const [opType, reducer] of Object.entries(model.reducers)) {
      if (reducer === undefined) continue;
      let list = this.reducerIndex.get(opType);
      if (list === undefined) {
        list = [];
        this.reducerIndex.set(opType, list);
      }
      list.push({ inst, reducer });
    }

    return {
      inst,
      release: toDisposable(() => this.releaseDerivedModel(model, entry)),
    };
  }

  private releaseDerivedModel<S>(
    model: DerivedModelDef<S>,
    entry: DerivedModelInstance,
  ): void {
    entry.references--;
    if (entry.references > 0 || this.derivedModels.get(model) !== entry) return;
    this.derivedModels.delete(model);
    this._store.delete(entry.inst.emitter);
    for (const [opType, list] of this.reducerIndex) {
      const filtered = list.filter((candidate) => candidate.inst !== entry.inst);
      if (filtered.length === 0) {
        this.reducerIndex.delete(opType);
      } else if (filtered.length !== list.length) {
        this.reducerIndex.set(opType, filtered);
      }
    }
  }

  dispatch(...ops: Op[]): void {
    if (ops.length === 0) return;
    if (this.dispatching) {
      this.queue.push(...ops);
      return;
    }
    this.dispatching = true;
    try {
      this.execute({ ops, silent: false });
      while (this.queue.length > 0) {
        if (++this.drainDepth > MAX_DRAIN) {
          throw new CycleError(this.drainDepth, this.queue.map((op) => op.type));
        }
        this.execute({ ops: this.queue.splice(0), silent: false });
      }
    } finally {
      this.queue.length = 0;
      this.dispatching = false;
      this.drainDepth = 0;
    }
  }

  async restore(): Promise<void> {
    if (
      this.restorePhase === 'restoring' ||
      this.restorePhase === 'failed' ||
      this.restorePhase === 'ready'
    ) {
      throw new BugIndicatingError(`Agent wire restore called while phase is ${this.restorePhase}`);
    }
    this.restorePhase = 'restoring';
    try {
      const source = this.log.read<WireRecord>(this.wireScope, AGENT_WIRE_RECORD_KEY);
      let migrations: readonly WireMigration[] = [];
      let rewrittenRecords: WireRecord[] | undefined;
      let newerWireVersion = false;
      let recordIndex = 0;
      let hasRecords = false;

      for await (const sourceRecord of source) {
        if (!hasRecords) {
          hasRecords = true;
          if (sourceRecord.type !== 'metadata') {
            rewrittenRecords = [createWireMetadataRecord()];
          } else if (!isWireMetadataRecord(sourceRecord)) {
            throw new StorageError(
              StorageErrors.codes.STORAGE_CORRUPTED,
              'Agent wire metadata is malformed',
              { details: { scope: this.wireScope, key: AGENT_WIRE_RECORD_KEY } },
            );
          } else if (isNewerWireVersion(sourceRecord.protocol_version)) {
            newerWireVersion = true;
          } else {
            migrations = resolveWireMigrations(sourceRecord.protocol_version);
            if (sourceRecord.protocol_version !== WIRE_PROTOCOL_VERSION) {
              rewrittenRecords = [];
            }
          }
        }

        const migratedRecord = migrateWireRecord(sourceRecord, migrations);
        const record =
          !newerWireVersion && migratedRecord.type === 'metadata'
            ? { ...migratedRecord, protocol_version: WIRE_PROTOCOL_VERSION }
            : migratedRecord;
        rewrittenRecords?.push(record);
        if (record.type === 'metadata') continue;

        this.replayRecord(record, recordIndex);
        recordIndex++;
      }

      if (!hasRecords) {
        rewrittenRecords = [createWireMetadataRecord()];
      }
      if (rewrittenRecords !== undefined) {
        await this.log.rewrite(this.wireScope, AGENT_WIRE_RECORD_KEY, rewrittenRecords);
      }

      await this.rehydrateModels();
      this.restorePhase = 'ready';
      await this.fireRestored();
    } catch (error) {
      this.restorePhase = 'failed';
      throw error;
    }
  }

  async flush(): Promise<void> {
    await this.persistQueue;
    await this.log.flush();
  }

  private replayRecord(record: WireRecord, index: number): void {
    const descriptor = OP_REGISTRY.get(record.type);
    if (descriptor === undefined) {
      onUnexpectedError(
        new WireError(
          WireErrors.codes.WIRE_UNKNOWN_RECORD,
          `Unknown wire record type '${record.type}' skipped during restore`,
          { details: { type: record.type, index } },
        ),
      );
      return;
    }
    this.execute({
      ops: [{ type: record.type, payload: wireRecordToPayload(record), descriptor }],
      silent: true,
    });
  }

  private execute(group: OpGroup): void {
    const changes: { inst: ModelInstance; change: ModelChange<unknown> }[] = [];

    for (const op of group.ops) {
      const inst = this.ensureModel(op.descriptor.model);
      const prev = inst.state;
      inst.state = Object.freeze(op.descriptor.apply(prev, op.payload));
      if (!group.silent) {
        if (op.descriptor.persist !== false) {
          const record = opToWireRecord(op);
          this.appendToJournal(record, op.descriptor.model);
        }
        const event = op.descriptor.toEvent?.(op.payload, inst.state);
        if (event !== undefined) {
          this.eventBus.publish(event as DomainEvent);
        }
      }
      if (inst.state !== prev) {
        changes.push({ inst, change: { state: inst.state, prev } });
      }

      const entries = this.reducerIndex.get(op.type);
      if (entries !== undefined) {
        for (const entry of entries) {
          const derivedPrev = entry.inst.state;
          entry.inst.state = Object.freeze(entry.reducer(derivedPrev, op.payload));
          if (entry.inst.state !== derivedPrev) {
            changes.push({
              inst: entry.inst,
              change: { state: entry.inst.state, prev: derivedPrev },
            });
          }
        }
      }

      const crossReducers = MODEL_CROSS_REDUCERS.get(op.type);
      if (crossReducers !== undefined) {
        for (const entry of crossReducers) {
          if (entry.model === op.descriptor.model) continue;
          const crossInst = this.ensureModel(entry.model);
          const crossPrev = crossInst.state;
          crossInst.state = Object.freeze(entry.reducer(crossPrev, op.payload));
          if (crossInst.state !== crossPrev) {
            changes.push({
              inst: crossInst,
              change: { state: crossInst.state, prev: crossPrev },
            });
          }
        }
      }
    }

    if (!group.silent) {
      for (const { inst, change } of changes) inst.emitter.fire(change);
    }
  }

  private ensureModel<S>(def: ModelDef<S>): ModelInstance {
    let inst = this.models.get(def);
    if (inst === undefined) {
      inst = {
        state: Object.freeze(def.initial()),
        emitter: new Emitter<ModelChange<unknown>>(),
      };
      this._register(inst.emitter);
      this.models.set(def, inst);
    }
    return inst;
  }

  private async fireRestored(): Promise<void> {
    for (const handler of Array.from(this.restoredHandlers)) {
      try {
        await handler();
      } catch (error) {
        onUnexpectedError(error);
      }
    }
  }

  private appendToJournal(record: WireRecord, model: ModelDef<any>): void {
    const dehydrate = model.blobs?.dehydrate?.bind(model.blobs);
    if (dehydrate === undefined && this.persistQueue === undefined) {
      try {
        this.appendRecord(record);
      } catch (error) {
        onUnexpectedError(error);
      }
      return;
    }
    const transform: PartsTransformer = (parts) =>
      this.blobService.offloadParts(
        parts as readonly ContentPart[],
      ) as Promise<readonly unknown[]>;
    const queued = (this.persistQueue ?? Promise.resolve())
      .then(async () => {
        let output = record;
        if (dehydrate !== undefined) {
          const prepared = dehydrate(record, transform);
          output = await prepared;
        }
        this.appendRecord(output);
      })
      .catch((error: unknown) => onUnexpectedError(error));
    this.persistQueue = queued;
    void queued.then(() => {
      if (this.persistQueue === queued) this.persistQueue = undefined;
    });
  }

  private appendRecord(record: WireRecord): void {
    this.log.append(this.wireScope, AGENT_WIRE_RECORD_KEY, record, {
      onError: onUnexpectedError,
    });
  }

  private async rehydrateModels(): Promise<void> {
    const transform: PartsTransformer = (parts) =>
      this.blobService.loadParts(
        parts as readonly ContentPart[],
      ) as Promise<readonly unknown[]>;
    for (const [def, inst] of this.models) {
      if (def.blobs?.rehydrate === undefined) continue;
      const result = def.blobs.rehydrate(inst.state, transform);
      inst.state = Object.freeze(await result);
    }
    for (const [def, entry] of this.derivedModels) {
      if (def.blobs?.rehydrate === undefined) continue;
      const result = def.blobs.rehydrate(entry.inst.state, transform);
      entry.inst.state = Object.freeze(await result);
    }
  }
}

registerScopedService(
  LifecycleScope.Agent,
  IWireService,
  WireService,
  InstantiationType.Eager,
  'wire',
);

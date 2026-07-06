/**
 * `wire` domain (L2) — `WireService`, the single scope-agnostic implementation
 * of `IWireService`, plus its construction options (`WireServiceOptions`), the
 * optional blob offload/rehydrate seam (`WireBlobSelector` / `WireBlobTarget`),
 * and the coded `CycleError`.
 *
 * One class serves every scope: per-scope isolation comes from the distinct DI
 * tokens in `tokens`, each seeded with its own `WireServiceOptions`
 * (`logScope` / `logKey`, and optionally a `blobSelector`) as the leading
 * (non-service) constructor argument through a `SyncDescriptor`, mirroring
 * `WireRecordServiceOptions`. `dispatch` and `replay` both lower to one
 * primitive, `execute(OpGroup)` — apply-all THEN onChange-all, so a subscriber
 * never observes a partially-applied group — with `dispatch` adding persistence
 * + emission + Op-derived `IEventBus` events (`silent: false`) and `replay`
 * staying silent (apply only, skipping
 * unknown record types, then `onRestored`). A reentrancy guard (`dispatching` +
 * `queue` + `drain`, capped by `MAX_DRAIN = 100`) lets onChange handlers enqueue
 * further ops without reentering `execute`; a cascade past the cap throws
 * `CycleError` (`code = 'ERR_WIRE_CYCLE'`), co-located here like
 * `DuplicateOpError` rather than the central `ErrorCodes` registry. After every
 * `apply` the new state is `Object.freeze`d — the runtime half of the
 * immutability guarantee whose compile-time half is `DeepReadonly`. Internally
 * each per-model instance is erased to `any` (the same localized erasure as
 * `OP_REGISTRY`) and restored at the public boundary; `signal` is a side channel
 * that never enters an OpGroup.
 *
 * Persists each dispatched op through `persistence` (`IAppendLogStore`) as a
 * flat `{ type, ...payload }` record — scalar / array payloads nested so a
 * JSONL line stays an object, with `type` / `time` stripped back out on replay.
 *
 * Blob handling has two asymmetric paths:
 *
 * - **Offload (dispatch → persist)**: record-level `WireBlobSelector` rewrites
 *   oversized inline parts to `blobref:` references before the record reaches
 *   the append log. `apply` and the live emission still see the original inline
 *   payload. Records with no offloadable targets short-circuit synchronously.
 *
 * - **Rehydrate (replay → model)**: `replay` applies all records first with
 *   blobref URLs entering the model state as-is (zero I/O). After all records
 *   are applied, `rehydrateModels` calls `ModelDef.rehydrate` on each model
 *   that declares it, replacing blobref URLs with inline data *only* in the
 *   surviving final state. This skips I/O for data later removed by compaction
 *   — a 20×+ speedup for long sessions with many images.
 *
 * Scope-agnostic.
 */

import { Disposable, type IDisposable } from '#/_base/di/lifecycle';
import { onUnexpectedError } from '#/_base/errors/unexpectedError';
import { Emitter } from '#/_base/event';
import { IAgentBlobService } from '#/agent/blob';
import { type DomainEvent, IEventBus } from '#/app/event';
import type { ContentPart } from '#/app/llmProtocol';
import { IAppendLogStore } from '#/persistence/interface/appendLogStore';

import type { DeepReadonly, DerivedModelDef, ModelDef, PartsRehydrator } from './model';
import type { Op } from './op';
import { OP_REGISTRY } from './op';
import type { Signal } from './signal';
import type {
  IWireService,
  ModelChange,
  OpGroup,
  PersistedRecord,
  WireEmission,
} from './wireService';

const MAX_DRAIN = 100;

export class CycleError extends Error {
  readonly code = 'ERR_WIRE_CYCLE' as const;

  constructor(readonly depth: number) {
    super(`Wire dispatch cascade exceeded MAX_DRAIN (${depth}); possible op cycle`);
    this.name = 'CycleError';
  }
}

export interface WireBlobTarget {
  readonly parts: readonly ContentPart[];
  replace(record: PersistedRecord, parts: readonly ContentPart[]): PersistedRecord;
}

export type WireBlobSelector = (record: PersistedRecord) => Iterable<WireBlobTarget>;

export interface WireServiceOptions {
  readonly logScope: string;
  readonly logKey: string;
  readonly blobSelector?: WireBlobSelector;
}

interface ModelInstance {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  state: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  emitter: Emitter<ModelChange<any>>;
}

interface ReducerEntry {
  readonly inst: ModelInstance;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  readonly reducer: (state: any, payload: any) => any;
}

export class WireService extends Disposable implements IWireService {
  declare readonly _serviceBrand: undefined;

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private readonly models = new Map<ModelDef<any>, ModelInstance>();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private readonly derivedModels = new Map<DerivedModelDef<any>, ModelInstance>();
  private readonly reducerIndex = new Map<string, ReducerEntry[]>();
  private readonly emissionEmitter = this._register(new Emitter<WireEmission>());
  private readonly restoredEmitter = this._register(new Emitter<void>());

  private dispatching = false;
  private queue: Op[] = [];
  private drainDepth = 0;
  private persistQueue: Promise<void> = Promise.resolve();

  constructor(
    private readonly options: WireServiceOptions,
    @IAppendLogStore private readonly log?: IAppendLogStore,
    @IAgentBlobService private readonly blobService?: IAgentBlobService,
    @IEventBus private readonly eventBus?: IEventBus,
  ) {
    super();
    if (this.log !== undefined) {
      this._register(this.log.acquire(this.options.logScope, this.options.logKey));
    }
  }

  getModel<S>(model: ModelDef<S> | DerivedModelDef<S>): DeepReadonly<S> {
    if ('reducers' in model) {
      const inst = this.derivedModels.get(model);
      return (inst?.state ?? Object.freeze(model.initial())) as DeepReadonly<S>;
    }
    return this.ensureModel(model).state as DeepReadonly<S>;
  }

  subscribe<S>(
    model: ModelDef<S> | DerivedModelDef<S>,
    handler: (state: DeepReadonly<S>, prev: DeepReadonly<S>) => void,
  ): IDisposable {
    const inst = 'reducers' in model
      ? this.derivedModels.get(model)
      : this.ensureModel(model);
    if (inst === undefined) return { dispose: () => {} };
    return inst.emitter.event((change) =>
      handler(change.state as DeepReadonly<S>, change.prev as DeepReadonly<S>),
    );
  }

  onEmission(handler: (emission: WireEmission) => void): IDisposable {
    return this.emissionEmitter.event(handler);
  }

  onRestored(handler: () => void): IDisposable {
    return this.restoredEmitter.event(handler);
  }

  attach<S>(model: DerivedModelDef<S>): IDisposable {
    const inst: ModelInstance = {
      state: Object.freeze(model.initial()),
      emitter: new Emitter<ModelChange<unknown>>(),
    };
    this._register(inst.emitter);
    this.derivedModels.set(model, inst);

    for (const opType of Object.keys(model.reducers)) {
      let list = this.reducerIndex.get(opType);
      if (list === undefined) {
        list = [];
        this.reducerIndex.set(opType, list);
      }
      list.push({ inst, reducer: model.reducers[opType]! });
    }

    return {
      dispose: () => {
        this.derivedModels.delete(model);
        for (const [opType, list] of this.reducerIndex) {
          const filtered = list.filter((e) => e.inst !== inst);
          if (filtered.length === 0) {
            this.reducerIndex.delete(opType);
          } else if (filtered.length !== list.length) {
            this.reducerIndex.set(opType, filtered);
          }
        }
      },
    };
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
          throw new CycleError(this.drainDepth);
        }
        this.execute({ ops: this.queue.splice(0), silent: false });
      }
    } finally {
      this.queue.length = 0;
      this.dispatching = false;
      this.drainDepth = 0;
    }
  }

  async replay(...records: PersistedRecord[]): Promise<void> {
    const ops: Op[] = [];
    for (const record of records) {
      const descriptor = OP_REGISTRY.get(record.type);
      if (descriptor === undefined) continue;
      ops.push({ type: record.type, payload: recordToPayload(record), descriptor });
    }
    this.execute({ ops, silent: true });
    await this.rehydrateModels();
    this.restoredEmitter.fire(undefined);
  }

  signal(signal: Signal): void {
    this.emissionEmitter.fire({ type: 'signal', signal });
  }

  async flush(): Promise<void> {
    await this.persistQueue;
    await this.log?.flush();
  }

  private execute(group: OpGroup): void {
    const changes: { inst: ModelInstance; change: ModelChange<unknown> }[] = [];

    for (const op of group.ops) {
      const inst = this.ensureModel(op.descriptor.model);
      const prev = inst.state;
      inst.state = Object.freeze(op.descriptor.apply(prev, op.payload));
      if (!group.silent) {
        const record = this.toRecord(op);
        this.appendToWireLog(record);
        this.emissionEmitter.fire({ type: 'record', record });
        const event = op.descriptor.toEvent?.(op.payload, inst.state);
        if (event !== undefined && this.eventBus !== undefined) {
          this.eventBus.publish(event as DomainEvent);
        }
      }
      if (inst.state !== prev) {
        changes.push({ inst, change: { state: inst.state, prev } });
      }

      const entries = this.reducerIndex.get(op.type);
      if (entries !== undefined) {
        for (const entry of entries) {
          const dPrev = entry.inst.state;
          entry.inst.state = Object.freeze(entry.reducer(dPrev, op.payload));
          if (entry.inst.state !== dPrev) {
            changes.push({ inst: entry.inst, change: { state: entry.inst.state, prev: dPrev } });
          }
        }
      }
    }

    if (!group.silent) {
      for (const { inst, change } of changes) {
        inst.emitter.fire(change);
      }
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

  private toRecord(op: Op): PersistedRecord {
    const payload = op.payload;
    if (payload !== null && typeof payload === 'object' && !Array.isArray(payload)) {
      return { type: op.type, ...(payload as Record<string, unknown>) };
    }
    return { type: op.type, payload };
  }

  private appendToWireLog(record: PersistedRecord): void {
    if (this.log === undefined) return;
    // When the blob hook is active, every append rides the serialized queue so a
    // record with no offloadable targets cannot leapfrog a pending offload and
    // reorder the log; otherwise append directly (no microtask, no queue).
    if (this.blobService === undefined || this.options.blobSelector === undefined) {
      this.log.append(this.options.logScope, this.options.logKey, record, {
        onError: onUnexpectedError,
      });
      return;
    }
    this.persistQueue = this.persistQueue
      .then(async () => {
        const prepared = this.prepareRecord(record);
        const offloaded = isPromise(prepared) ? await prepared : prepared;
        this.log?.append(this.options.logScope, this.options.logKey, offloaded, {
          onError: onUnexpectedError,
        });
      })
      .catch((error: unknown) => onUnexpectedError(error));
  }

  private prepareRecord(record: PersistedRecord): PersistedRecord | Promise<PersistedRecord> {
    const blobService = this.blobService;
    const selector = this.options.blobSelector;
    if (blobService === undefined || selector === undefined) return record;
    const targets = [...selector(record)];
    if (targets.length === 0) return record;
    return this.offloadTargets(record, targets, blobService);
  }

  private async offloadTargets(
    record: PersistedRecord,
    targets: readonly WireBlobTarget[],
    blobService: IAgentBlobService,
  ): Promise<PersistedRecord> {
    let current = record;
    for (const target of targets) {
      const parts = await blobService.offloadParts(target.parts);
      if (parts !== target.parts) {
        current = target.replace(current, parts);
      }
    }
    return current;
  }

  private async rehydrateModels(): Promise<void> {
    if (this.blobService === undefined) return;
    const rehydrateParts: PartsRehydrator = (parts) =>
      this.blobService!.rehydrateParts(
        parts as readonly ContentPart[],
      ) as Promise<readonly unknown[]>;
    for (const [def, inst] of this.models) {
      if (def.rehydrate === undefined) continue;
      const result = def.rehydrate(inst.state, rehydrateParts);
      inst.state = Object.freeze(isPromise(result) ? await result : result);
    }
    for (const [def, inst] of this.derivedModels) {
      if (def.rehydrate === undefined) continue;
      const result = def.rehydrate(inst.state, rehydrateParts);
      inst.state = Object.freeze(isPromise(result) ? await result : result);
    }
  }
}

function recordToPayload(record: PersistedRecord): unknown {
  const payload: Record<string, unknown> = {};
  for (const key of Object.keys(record)) {
    if (key === 'type' || key === 'time') continue;
    payload[key] = record[key];
  }
  return payload;
}

function isPromise<T>(value: T | Promise<T>): value is Promise<T> {
  return value !== null && typeof (value as Promise<T>).then === 'function';
}

/**
 * `wire` domain (L2) — `IWireService` implementation.
 *
 * `WireService` is the sole runtime owner of an Agent wire aggregate. It
 * combines the model reducer engine with the `wire.jsonl` journal protocol,
 * including creation-time sealing, metadata, migrations, atomic healing
 * rewrites, blob dehydration and rehydration plus an ordered post-restore hook.
 * It is bound at Agent scope because the aggregate identity is the Agent
 * identity.
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

import { InstantiationType } from '#/_base/di/extensions';
import { BugIndicatingError } from '#/_base/errors/errors';
import { onUnexpectedError } from '#/_base/errors/unexpectedError';
import { Disposable } from '#/_base/di/lifecycle';
import { LifecycleScope, registerScopedService } from '#/_base/di/scope';
import { IAgentBlobService } from '#/agent/blob/agentBlobService';
import { IAgentScopeContext } from '#/agent/scopeContext/scopeContext';
import { type DomainEvent, IEventBus } from '#/app/event/eventBus';
import type { ContentPart } from '#/kosong/contract/message';
import { OrderedHookSlot } from '#/hooks';
import { IAppendLogStore } from '#/persistence/interface/appendLogStore';
import { StorageError, StorageErrors } from '#/persistence/interface/storage';

import { IWireService } from './wire';
import { WireError, WireErrors } from './errors';
import {
  WIRE_PROTOCOL_VERSION,
  isNewerWireVersion,
  migrateV1_4ToV1_5,
  migrateWireRecord,
  resolveWireMigrations,
  type WireMigration,
} from './migration/migration';
import type { DeepReadonly, ModelDef, PartsTransformer } from './model';
import { MODEL_CROSS_REDUCERS } from './model';
import type { Op, OpApplyContext } from './op';
import { OP_REGISTRY } from './op';
import {
  AGENT_WIRE_RECORD_KEY,
  createLogCutRecord,
  createWireMetadataRecord,
  isLogCutRecord,
  isWireRecord,
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

interface ModelInstance {
  state: any;
}

interface OpGroup {
  readonly ops: readonly Op[];
  readonly silent: boolean;
}

type RestorePhase = 'new' | 'restoring' | 'ready' | 'failed';

export class WireService extends Disposable implements IWireService {
  declare readonly _serviceBrand: undefined;

  readonly hooks: IWireService['hooks'] = {
    onDidRestore: new OrderedHookSlot(),
  };

  private readonly models = new Map<ModelDef<any>, ModelInstance>();
  private readonly wireScope: string;

  private restorePhase: RestorePhase = 'new';
  private dispatching = false;
  private rewinding = false;
  private queue: Op[] = [];
  private drainDepth = 0;
  private persistQueue: Promise<void> | undefined;
  /**
   * Cursor over NON-metadata journal records (0-based): the index the next
   * appended data record will occupy in the metadata-free record coordinate
   * system shared by `log.cut` targets and `OpApplyContext.recordIndex`.
   * The metadata envelope line never consumes an index, so adding or
   * removing it (seal / migration rewrite) never shifts record positions.
   */
  private nextRecordIndex = 0;

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

  dispatch(...ops: Op[]): void {
    if (ops.length === 0) return;
    if (this.rewinding) {
      throw new BugIndicatingError('Wire dispatch during an in-flight rewind is not allowed');
    }
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

  async seal(): Promise<void> {
    for await (const record of this.log.read(this.wireScope, AGENT_WIRE_RECORD_KEY)) {
      void record;
      return;
    }
    this.appendRecord(createWireMetadataRecord());
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
      // Cursor over NON-metadata records — the metadata-free coordinate
      // system `log.cut` targets and `OpApplyContext.recordIndex` share.
      let recordIndex = 0;
      let hasRecords = false;

      for await (const candidate of source) {
        const sourceRecord: unknown = candidate;
        if (!isWireRecord(sourceRecord)) {
          this.reportSkippedRecord(undefined, recordIndex, true);
          recordIndex++;
          continue;
        }
        if (!hasRecords) {
          hasRecords = true;
          if (sourceRecord.type !== 'metadata') {
            rewrittenRecords = [createWireMetadataRecord()];
            migrations = [migrateV1_4ToV1_5];
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
        if (record.type === 'log.cut') {
          // Wire-layer control record: rewind every rewindable model to the
          // fold of records [0, target), then continue replay after it.
          if (isLogCutRecord(record)) {
            await this.rebuildRewindableModels(Math.min(record.target, recordIndex), migrations);
          } else {
            this.reportSkippedRecord(record.type, recordIndex, true);
          }
          recordIndex++;
          continue;
        }

        this.replayRecord(record, recordIndex);
        recordIndex++;
      }

      if (!hasRecords) {
        rewrittenRecords = [createWireMetadataRecord()];
      }
      this.nextRecordIndex = recordIndex;
      if (rewrittenRecords !== undefined) {
        await this.log.rewrite(this.wireScope, AGENT_WIRE_RECORD_KEY, rewrittenRecords);
      }

      await this.rehydrateModels();
      this.restorePhase = 'ready';
      await this.hooks.onDidRestore.run({});
    } catch (error) {
      this.restorePhase = 'failed';
      throw error;
    }
  }

  async flush(): Promise<void> {
    await this.persistQueue;
    await this.log.flush();
  }

  /**
   * Rewind every `rewindable` model to the fold of journal records
   * `[0, target)`, then append a `log.cut` control record marking the rewind.
   * Non-rewindable (world-time) models keep their current state. Live and
   * restore share the same rebuild path (`rebuildRewindableModels`), so the
   * post-rewind state is by construction identical to a fresh replay of the
   * journal up to the cut. Dispatches must not interleave with a rewind —
   * callers quiesce producers (loop, compaction) first; any dispatch arriving
   * while a rewind is in flight throws.
   */
  async rewind(target: number, reason?: string): Promise<void> {
    if (this.restorePhase === 'restoring' || this.restorePhase === 'failed') {
      throw new BugIndicatingError(`Wire rewind called while phase is ${this.restorePhase}`);
    }
    if (this.dispatching || this.rewinding) {
      throw new BugIndicatingError('Wire rewind re-entered while dispatching or rewinding');
    }
    if (!Number.isInteger(target) || target < 0 || target > this.nextRecordIndex) {
      throw new WireError(WireErrors.codes.WIRE_INVALID_REWIND_TARGET, `Invalid rewind target ${String(target)}`, {
        details: { target, nextRecordIndex: this.nextRecordIndex },
      });
    }
    this.rewinding = true;
    try {
      // Drain the persist queue so every record below `target` is durable
      // before the rebuild reads the journal back.
      await this.flush();
      await this.rebuildRewindableModels(target, []);
      this.appendRecord(createLogCutRecord(target, reason));
      this.nextRecordIndex++;
    } finally {
      this.rewinding = false;
    }
  }

  /**
   * Reset all rewindable models to their initial state and re-apply journal
   * records `[0, target)` to them only (cross-model reducers included; records
   * routing to non-rewindable models contribute cross effects but no state).
   * Nested `log.cut` records inside the range recurse — the cut's own
   * semantics is "rewindable models := fold([0, cut.target))", and replay
   * continues after the cut record, exactly like the restore main loop.
   * `migrations` lets the restore-time rebuild see the same record view as
   * the main replay when the on-disk file predates the current protocol.
   */
  private async rebuildRewindableModels(
    target: number,
    migrations: readonly WireMigration[],
  ): Promise<void> {
    for (const [def, inst] of this.models) {
      if (def.rewindable === true) {
        inst.state = Object.freeze(def.initial());
      }
    }
    let index = 0;
    const source = this.log.read<unknown>(this.wireScope, AGENT_WIRE_RECORD_KEY);
    for await (const candidate of source) {
      if (index >= target) break;
      if (!isWireRecord(candidate)) {
        index++;
        continue;
      }
      // The metadata envelope never consumes a record index (see
      // `nextRecordIndex`), so metadata-less and metadata-ful journals index
      // identically.
      if (candidate.type === 'metadata') continue;
      const record = migrateWireRecord(candidate, migrations);
      if (record.type === 'log.cut') {
        if (isLogCutRecord(record)) {
          await this.rebuildRewindableModels(Math.min(record.target, index), migrations);
        }
        index++;
        continue;
      }
      this.replayRewindableRecord(record, index);
      index++;
    }
    await this.rehydrateModels();
  }

  /**
   * Re-apply one record during a rewind rebuild: the owning model is updated
   * only when rewindable; cross-model reducers run only for rewindable
   * targets, so non-rewindable (world-time) models are never double-applied.
   */
  private replayRewindableRecord(record: WireRecord, index: number): void {
    const descriptor = OP_REGISTRY.get(record.type);
    if (descriptor === undefined) return;
    const payload = descriptor.schema.safeParse(wireRecordToPayload(record));
    if (!payload.success) return;
    const ctx: OpApplyContext = { recordIndex: index };
    if (descriptor.model.rewindable === true) {
      const inst = this.ensureModel(descriptor.model);
      inst.state = Object.freeze(descriptor.apply(inst.state, payload.data, ctx));
    }
    const crossReducers = MODEL_CROSS_REDUCERS.get(record.type);
    if (crossReducers !== undefined) {
      for (const entry of crossReducers) {
        if (entry.model.rewindable !== true) continue;
        const crossInst = this.ensureModel(entry.model);
        crossInst.state = Object.freeze(entry.reducer(crossInst.state, payload.data, ctx));
      }
    }
  }

  private replayRecord(record: WireRecord, index: number): void {
    const descriptor = OP_REGISTRY.get(record.type);
    if (descriptor === undefined) {
      this.reportSkippedRecord(record.type, index);
      return;
    }
    const payload = descriptor.schema.safeParse(wireRecordToPayload(record));
    if (!payload.success) {
      this.reportSkippedRecord(record.type, index, true);
      return;
    }
    this.execute({
      ops: [{ type: record.type, payload: payload.data, descriptor, recordIndex: index }],
      silent: true,
    });
  }

  private reportSkippedRecord(type: string | undefined, index: number, malformed = false): void {
    onUnexpectedError(
      new WireError(
        WireErrors.codes.WIRE_UNKNOWN_RECORD,
        type === undefined
          ? 'Malformed wire record skipped during restore'
          : malformed
            ? `Malformed wire record type '${type}' skipped during restore`
            : `Unknown wire record type '${type}' skipped during restore`,
        { details: { type, index } },
      ),
    );
  }

  private execute(group: OpGroup): void {
    for (const op of group.ops) {
      const inst = this.ensureModel(op.descriptor.model);
      const prev = inst.state;
      // Journal position of this op's record: replay supplies it; live
      // dispatch assigns the next line index for persisted ops. Transient ops
      // never occupy a journal line and keep `undefined`.
      let recordIndex = op.recordIndex;
      if (!group.silent && recordIndex === undefined && op.descriptor.persist !== false) {
        recordIndex = this.nextRecordIndex++;
      }
      const ctx: OpApplyContext = { recordIndex };
      inst.state = Object.freeze(op.descriptor.apply(prev, op.payload, ctx));
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
      const crossReducers = MODEL_CROSS_REDUCERS.get(op.type);
      if (crossReducers !== undefined) {
        for (const entry of crossReducers) {
          if (entry.model === op.descriptor.model) continue;
          const crossInst = this.ensureModel(entry.model);
          crossInst.state = Object.freeze(entry.reducer(crossInst.state, op.payload, ctx));
        }
      }
    }
  }

  private ensureModel<S>(def: ModelDef<S>): ModelInstance {
    let inst = this.models.get(def);
    if (inst === undefined) {
      inst = { state: Object.freeze(def.initial()) };
      this.models.set(def, inst);
    }
    return inst;
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
  }
}

registerScopedService(
  LifecycleScope.Agent,
  IWireService,
  WireService,
  InstantiationType.Eager,
  'wire',
);

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
import type { Op } from './op';
import { OP_REGISTRY } from './op';
import {
  AGENT_WIRE_RECORD_KEY,
  createWireMetadataRecord,
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
      ops: [{ type: record.type, payload: payload.data, descriptor }],
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
      const crossReducers = MODEL_CROSS_REDUCERS.get(op.type);
      if (crossReducers !== undefined) {
        for (const entry of crossReducers) {
          if (entry.model === op.descriptor.model) continue;
          const crossInst = this.ensureModel(entry.model);
          crossInst.state = Object.freeze(entry.reducer(crossInst.state, op.payload));
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

/**
 * `wire` domain — `IWireService` implementation.
 *
 * `WireService` is the journal adapter for one Agent's wire aggregate: it
 * owns the `wire.jsonl` append-log handle, creation-time sealing, the
 * migration/read protocol (including atomic healing rewrites), and the
 * ordered append path with blob dehydration. It holds no state and runs no
 * folds — state ownership, event dispatch, and restore orchestration live in
 * the state domain's event dispatcher, which consumes `readJournal` and
 * `appendRecord`. It is bound at Agent scope because the aggregate identity
 * is the Agent identity.
 */

import { onUnexpectedError } from '#/_base/errors/unexpectedError';
import { Service } from '#/_base/di/service';
import { LifecycleScope } from '#/app/scopes';
import { ScopeActivation, registerScopedService } from '#/_base/di/scope';
import { IAgentBlobService } from '#/agent/blob/agentBlobService';
import { IAgentScopeContext } from '#/agent/scopeContext/scopeContext';
import type { ContentPart } from '#/kosong/contract/message';
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
import {
  AGENT_WIRE_RECORD_KEY,
  createWireMetadataRecord,
  isWireRecord,
  isWireMetadataRecord,
  type PartsTransformer,
  type RecordDehydrator,
  type WireRecord,
} from './record';

export class WireService extends Service implements IWireService {
  declare readonly _serviceBrand: undefined;

  private readonly wireScope: string;
  private persistQueue: Promise<void> | undefined;

  constructor(
    @IAgentScopeContext scopeContext: IAgentScopeContext,
    @IAppendLogStore private readonly log: IAppendLogStore,
    @IAgentBlobService private readonly blobService: IAgentBlobService,
  ) {
    super();
    this.wireScope = scopeContext.scope();
    this._register(this.log.acquire(this.wireScope, AGENT_WIRE_RECORD_KEY));
  }

  async seal(): Promise<void> {
    for await (const record of this.log.read(this.wireScope, AGENT_WIRE_RECORD_KEY)) {
      void record;
      return;
    }
    this.appendRecordLow(createWireMetadataRecord());
  }

  appendRecord(record: WireRecord, dehydrate?: RecordDehydrator): void {
    if (dehydrate === undefined && this.persistQueue === undefined) {
      try {
        this.appendRecordLow(record);
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
        const output = dehydrate === undefined ? record : await dehydrate(record, transform);
        this.appendRecordLow(output);
      })
      .catch((error: unknown) => onUnexpectedError(error));
    this.persistQueue = queued;
    void queued.then(() => {
      if (this.persistQueue === queued) this.persistQueue = undefined;
    });
  }

  async *readJournal(): AsyncIterable<WireRecord> {
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
      yield record;
      if (record.type !== 'metadata') {
        recordIndex++;
      }
    }

    if (!hasRecords) {
      rewrittenRecords = [createWireMetadataRecord()];
    }
    if (rewrittenRecords !== undefined) {
      await this.log.rewrite(this.wireScope, AGENT_WIRE_RECORD_KEY, rewrittenRecords);
    }
  }

  async flush(): Promise<void> {
    await this.persistQueue;
    await this.log.flush();
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

  private appendRecordLow(record: WireRecord): void {
    this.log.append(this.wireScope, AGENT_WIRE_RECORD_KEY, record, {
      onError: onUnexpectedError,
    });
  }
}

registerScopedService(
  LifecycleScope.Agent,
  IWireService,
  WireService,
  ScopeActivation.OnScopeCreated,
  'wire',
);

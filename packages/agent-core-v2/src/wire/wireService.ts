import { onUnexpectedError } from '#/_base/errors/unexpectedError';
import { Service } from '#/_base/di/service';
import { ILogService } from '#/_base/log/log';
import { LifecycleScope } from '#/app/scopes';
import { ScopeActivation, registerScopedService } from '#/_base/di/scope';
import { IAgentBlobService } from '#/agent/blob/agentBlobService';
import { IAgentScopeContext } from '#/agent/scopeContext/scopeContext';
import { ITelemetryService } from '#/app/telemetry/telemetry';
import type { ContentPart } from '#/kosong/contract/message';
import {
  type AppendLogTruncation,
  IAppendLogStore,
} from '#/persistence/interface/appendLogStore';
import { IFileSystemStorageService, StorageError, StorageErrors } from '#/persistence/interface/storage';

import { IWireService } from './wire';
import { WireError, WireErrors } from './errors';
import { repairWireJournal } from './repair';
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
  private readonly agentId: string;
  private persistQueue: Promise<void> | undefined;
  private pendingRepair:
    | { readonly records: WireRecord[]; readonly truncation: AppendLogTruncation }
    | undefined;
  private persistError: Error | undefined;

  constructor(
    @IAgentScopeContext scopeContext: IAgentScopeContext,
    @IAppendLogStore private readonly log: IAppendLogStore,
    @IAgentBlobService private readonly blobService: IAgentBlobService,
    @IFileSystemStorageService private readonly storage: IFileSystemStorageService,
    @ILogService private readonly logger: ILogService,
    @ITelemetryService private readonly telemetry: ITelemetryService,
  ) {
    super();
    this.wireScope = scopeContext.scope();
    this.agentId = scopeContext.agentId;
    this._register(this.log.acquire(this.wireScope, AGENT_WIRE_RECORD_KEY));
  }

  async seal(): Promise<void> {
    const tolerate = { onTruncate: () => {} };
    for await (const record of this.log.read(this.wireScope, AGENT_WIRE_RECORD_KEY, tolerate)) {
      void record;
      return;
    }
    this.appendRecordLow(createWireMetadataRecord());
  }

  appendRecord(record: WireRecord, dehydrate?: RecordDehydrator): void {
    if (
      this.pendingRepair === undefined &&
      dehydrate === undefined &&
      this.persistQueue === undefined
    ) {
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
        if (this.pendingRepair !== undefined) {
          await this.repairPendingJournal();
        }
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
    let truncation: AppendLogTruncation | undefined;
    const source = this.log.read<WireRecord>(this.wireScope, AGENT_WIRE_RECORD_KEY, {
      onTruncate: (info) => {
        truncation = info;
      },
    });
    let migrations: readonly WireMigration[] = [];
    let rewrittenRecords: WireRecord[] | undefined;
    let newerWireVersion = false;
    let recordIndex = 0;
    let hasRecords = false;
    let legacyPlanRevisionMigrated = false;

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
      const normalized = newerWireVersion
        ? record
        : this.normalizePlanRevisionRecord(record, recordIndex);
      if (
        !newerWireVersion &&
        normalized !== undefined &&
        'path' in record &&
        !('key' in record)
      ) {
        legacyPlanRevisionMigrated = true;
      }
      if (normalized === undefined) {
        if (record.type === 'plan.revision') recordIndex++;
        continue;
      }
      rewrittenRecords?.push(normalized);
      yield normalized;
      if (normalized.type !== 'metadata') {
        recordIndex++;
      }
    }

    if (legacyPlanRevisionMigrated && rewrittenRecords === undefined) {
      rewrittenRecords = await this.rebuildRewriteRecords(migrations, newerWireVersion);
    }
    if (!hasRecords) {
      rewrittenRecords = [createWireMetadataRecord()];
    }
    if (truncation !== undefined) {
      await this.repairJournal(truncation, rewrittenRecords);
    } else if (rewrittenRecords !== undefined) {
      await this.log.rewrite(this.wireScope, AGENT_WIRE_RECORD_KEY, rewrittenRecords);
    }
  }

  private async repairJournal(
    truncation: AppendLogTruncation,
    rewrittenRecords: WireRecord[] | undefined,
  ): Promise<void> {
    let records: WireRecord[] = rewrittenRecords ?? [];
    if (rewrittenRecords === undefined) {
      const tolerate = { onTruncate: () => {} };
      for await (const record of this.log.read<WireRecord>(
        this.wireScope,
        AGENT_WIRE_RECORD_KEY,
        tolerate,
      )) {
        records.push(record);
      }
    }
    const outcome = await repairWireJournal(
      {
        appendLog: this.log,
        storage: this.storage,
        log: this.logger,
        telemetry: this.telemetry,
      },
      this.wireScope,
      AGENT_WIRE_RECORD_KEY,
      records,
      truncation,
    );
    this.pendingRepair = outcome === 'failed' ? { records, truncation } : undefined;
  }

  private async repairPendingJournal(): Promise<void> {
    const pending = this.pendingRepair;
    if (pending === undefined) return;
    await this.repairJournal(pending.truncation, pending.records);
    if (this.pendingRepair !== undefined) {
      const error = new WireError(
        WireErrors.codes.RECORDS_WRITE_FAILED,
        'Wire journal repair did not complete; record was not appended',
        {
          details: {
            scope: this.wireScope,
            key: AGENT_WIRE_RECORD_KEY,
            lineNumber: pending.truncation.lineNumber,
          },
        },
      );
      this.persistError = error;
      throw error;
    }
  }

  async flush(): Promise<void> {
    await this.persistQueue;
    const persistError = this.persistError;
    this.persistError = undefined;
    if (persistError !== undefined) throw persistError;
    await this.log.flush();
  }

  private async rebuildRewriteRecords(
    migrations: readonly WireMigration[],
    newerWireVersion: boolean,
  ): Promise<WireRecord[]> {
    const records: WireRecord[] = [];
    const tolerate = { onTruncate: () => {} };
    for await (const candidate of this.log.read<WireRecord>(
      this.wireScope,
      AGENT_WIRE_RECORD_KEY,
      tolerate,
    )) {
      if (!isWireRecord(candidate)) continue;
      const migratedRecord = migrateWireRecord(candidate, migrations);
      const record =
        !newerWireVersion && migratedRecord.type === 'metadata'
          ? { ...migratedRecord, protocol_version: WIRE_PROTOCOL_VERSION }
          : migratedRecord;
      const normalized = newerWireVersion
        ? record
        : this.normalizePlanRevisionRecord(record, 0, false);
      if (normalized !== undefined) records.push(normalized);
    }
    return records;
  }

  private normalizePlanRevisionRecord(
    record: WireRecord,
    index: number,
    report = true,
  ): WireRecord | undefined {
    if (record.type !== 'plan.revision' || 'key' in record) return record;
    if (!('path' in record) || typeof record['path'] !== 'string') {
      if (report) {
        this.telemetry.track2('wire_plan_revision_migrated', {
          record_type: 'plan.revision',
          legacy_field: 'path',
          migration_outcome: 'skipped',
        });
        this.reportSkippedRecord(record.type, index, true);
      }
      return undefined;
    }
    const key = extractLegacyPlanRevisionKey(record['path'], this.agentId);
    if (report) {
      this.telemetry.track2('wire_plan_revision_migrated', {
        record_type: 'plan.revision',
        legacy_field: 'path',
        migration_outcome: key === undefined ? 'skipped' : 'migrated',
      });
    }
    if (key === undefined) {
      if (report) this.reportSkippedRecord(record.type, index, true);
      return undefined;
    }
    const { path: _path, ...rest } = record;
    return { ...rest, key };
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

function extractLegacyPlanRevisionKey(path: string, agentId: string): string | undefined {
  if (path.includes('\\')) return undefined;
  const segments = path.split('/');
  if (
    segments.length < 8 ||
    segments[0] !== 'sessions' ||
    segments[3] !== 'agents' ||
    segments[4] !== agentId ||
    segments.slice(1, 3).some((segment) => segment.length === 0 || segment === '.' || segment === '..')
  ) {
    return undefined;
  }
  const key = segments.slice(5).join('/');
  return /^plan\/[^/]+\/v[0-9]+\.md$/.test(key) ? key : undefined;
}

registerScopedService(
  LifecycleScope.Agent,
  IWireService,
  WireService,
  ScopeActivation.OnScopeCreated,
  'wire',
);

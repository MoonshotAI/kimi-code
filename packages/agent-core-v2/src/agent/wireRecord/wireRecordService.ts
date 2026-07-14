/**
 * `wireRecord` domain (L2) — `IAgentWireRecordService` implementation.
 *
 * Restores and retains the owning agent's wire journal, applies protocol
 * migrations, rejects non-empty unversioned logs, and awaits durable atomic
 * rewrites before restore completes. Tracks live records through `wire`, uses
 * `agent/scopeContext` for storage addressing, and persists through the
 * `appendLog` access-pattern store. Bound at Agent scope.
 */

import { relative } from 'pathe';

import { InstantiationType } from '#/_base/di/extensions';
import { Disposable } from '#/_base/di/lifecycle';
import { LifecycleScope, registerScopedService } from '#/_base/di/scope';
import { IAgentScopeContext } from '#/agent/scopeContext/scopeContext';
import { IAppendLogStore } from '#/persistence/interface/appendLogStore';
import { IAgentWireService } from '#/wire/tokens';
import type { IWireService } from '#/wire/wireService';
import {
  AGENT_WIRE_PROTOCOL_VERSION,
  applyWireMigrations,
  isNewerWireVersion,
  resolveWireMigrations,
  type WireMigration,
  type WireMigrationRecord,
} from '#/agent/wireRecord/migration/migration';
import {
  IAgentWireRecordService,
  type PersistedWireRecord,
  type WireRecordMetadata,
  type WireRecordRestoreOptions,
  type WireRecordRestoreResult,
} from './wireRecord';

export class AgentWireRecordService extends Disposable implements IAgentWireRecordService {
  declare readonly _serviceBrand: undefined;
  private readonly records: PersistedWireRecord[] = [];
  private readonly wireScope: string;

  constructor(
    @IAgentScopeContext scopeContext: IAgentScopeContext,
    @IAppendLogStore private readonly log?: IAppendLogStore,
    @IAgentWireService private readonly wire?: IWireService,
  ) {
    super();
    // The agent scope carries its persistence scope (`sessions/<ws>/<sid>/
    // agents/<aid>`); the wire log is the fixed `wire.jsonl` beneath it —
    // the same scope `WireService` appends to, so `restore()` reads back
    // what live dispatch wrote.
    this.wireScope = scopeContext.scope();
    if (this.log !== undefined) {
      this._register(this.log.acquire(this.wireScope, WIRE_RECORD_FILENAME));
    }
    // Keep the in-memory journal current with live dispatch: `restore()` seeds
    // it from disk and every persisted record afterwards is appended here in
    // dispatch order, so transcript readers reduce memory instead of re-reading
    // `wire.jsonl`. Metadata envelopes are excluded to honor `getRecords()`.
    // `wire` is optional so direct construction (tests, migration round-trips)
    // keeps the restore-only journal; live tracking is active whenever DI
    // supplies the agent wire service.
    if (wire !== undefined) {
      this._register(
        wire.onEmission((emission) => {
          if (emission.type === 'record' && emission.record.type !== 'metadata') {
            this.records.push(emission.record as PersistedWireRecord);
          }
        }),
      );
    }
  }

  getRecords(): readonly PersistedWireRecord[] {
    return [...this.records];
  }

  async restore(
    records?: readonly PersistedWireRecord[],
    options: WireRecordRestoreOptions = {},
  ): Promise<WireRecordRestoreResult> {
    const fromPersistence = records === undefined;
    const source =
      records ??
      (this.log !== undefined
        ? this.log.read<PersistedWireRecord>(this.wireScope, WIRE_RECORD_FILENAME)
        : undefined);
    if (source === undefined) {
      return {};
    }

    const rewriteMigratedRecords =
      fromPersistence && (options.rewriteMigratedRecords ?? true);
    const restoredRecords: PersistedWireRecord[] | undefined =
      rewriteMigratedRecords ? [] : undefined;
    const requireMetadata =
      fromPersistence && this.log !== undefined;
    let migrations: readonly WireMigration[] = [];
    let shouldRewrite = false;
    let warning: string | undefined;
    const sourceRecords: PersistedWireRecord[] = [];

    for await (const record of source) {
      sourceRecords.push(record);
    }

    const firstRecord = sourceRecords[0];
    if (firstRecord !== undefined) {
      if (firstRecord.type === 'metadata') {
        if (!isWireRecordMetadata(firstRecord)) {
          throw new Error('WireRecord restore expected metadata protocol_version');
        }
        const readVersion = firstRecord.protocol_version;
        if (isNewerWireVersion(readVersion)) {
          warning = `Session wire protocol version ${readVersion} is newer than the current version ${AGENT_WIRE_PROTOCOL_VERSION}. Records will be restored without migration.`;
          shouldRewrite = false;
        } else {
          migrations = resolveWireMigrations(readVersion);
          shouldRewrite = readVersion !== AGENT_WIRE_PROTOCOL_VERSION;
        }
      } else if (requireMetadata) {
        throw missingWireMetadataError();
      }
    }

    const migratedRecords = applyWireMigrations(
      sourceRecords as WireMigrationRecord[],
      migrations,
    ) as PersistedWireRecord[];
    for (let migratedRecord of migratedRecords) {
      if (migratedRecord.type === 'metadata') {
        migratedRecord = {
          ...migratedRecord,
          protocol_version: AGENT_WIRE_PROTOCOL_VERSION,
        };
      }
      restoredRecords?.push(migratedRecord);
      if (migratedRecord.type === 'metadata') continue;
      this.records.push(migratedRecord);
    }

    if (shouldRewrite && restoredRecords !== undefined && this.log !== undefined) {
      await this.log.rewrite(this.wireScope, WIRE_RECORD_FILENAME, restoredRecords);
    }
    return warning === undefined ? {} : { warning };
  }

  async flush(): Promise<void> {
    // Drain the wire service's async persist pipeline first: with a model blob
    // codec, appends are queued on a microtask chain and only
    // reach the log store once that queue settles. Flushing the log alone
    // would miss records still in flight.
    await this.wire?.flush();
    await this.log?.flush();
  }

  async close(): Promise<void> {
    await this.log?.close();
  }
}

registerScopedService(
  LifecycleScope.Agent,
  IAgentWireRecordService,
  AgentWireRecordService,
  InstantiationType.Delayed,
  'wireRecord',
);

function isWireRecordMetadata(record: PersistedWireRecord): record is WireRecordMetadata {
  return record.type === 'metadata' && typeof record['protocol_version'] === 'string';
}

/**
 * File name of every agent's wire log, written beneath the agent's homedir
 * (`<homeDir>/sessions/<ws>/<sid>/agents/<aid>/wire.jsonl`).
 */
export const WIRE_RECORD_FILENAME = 'wire.jsonl';

export function missingWireMetadataError(): Error {
  return new Error('WireRecord restore expected metadata as the first record');
}

/**
 * Store `scope` of an agent's wire log: its homedir made relative to the app
 * `homeDir`. Paired with {@link WIRE_RECORD_FILENAME} by callers that read /
 * rewrite a wire log through `IAppendLogStore` without holding a live agent
 * handle (e.g. session fork).
 */
export function wireRecordScope(homedir: string, homeDir: string): string {
  return relative(homeDir, homedir);
}

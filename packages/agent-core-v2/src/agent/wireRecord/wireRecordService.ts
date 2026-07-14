/**
 * `wireRecord` domain (L2) — `IAgentWireRecordService` implementation.
 *
 * Restores and retains the owning agent's wire journal, applies protocol
 * migrations, rejects non-empty unversioned logs, and awaits durable atomic
 * rewrites before restore completes. Seals fresh logs with the `metadata`
 * envelope at creation (`seal`) so released v1 builds — whose replay
 * hard-rejects envelope-less logs — can read sessions on a shared
 * `KIMI_CODE_HOME`; legacy envelope-less logs are healed on `restore`.
 * Tracks live records through `wire`, uses `agent/scopeContext` for storage
 * addressing, and persists through the `appendLog` access-pattern store.
 * Bound at Agent scope.
 */

import { relative } from 'pathe';

import { InstantiationType } from '#/_base/di/extensions';
import { Disposable } from '#/_base/di/lifecycle';
import { LifecycleScope, registerScopedService } from '#/_base/di/scope';
import { onUnexpectedError } from '#/_base/errors/unexpectedError';
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
import { metadataRecord } from './metadataOps';
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
    this.wireScope = scopeContext.scope();
    if (this.log !== undefined) {
      this._register(this.log.acquire(this.wireScope, WIRE_RECORD_FILENAME));
    }
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

  async seal(): Promise<void> {
    if (this.log === undefined) return;
    if (await hasAnyRecord(this.log, this.wireScope, WIRE_RECORD_FILENAME)) return;
    this.log.append(this.wireScope, WIRE_RECORD_FILENAME, metadataRecord(), {
      onError: onUnexpectedError,
    });
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
    let migrations: readonly WireMigration[] = [];
    let shouldRewrite = false;
    let warning: string | undefined;

    const collected: PersistedWireRecord[] = [];
    for await (const record of source) {
      collected.push(record);
    }

    let sourceRecords = collected;
    const firstRecord = sourceRecords[0];
    if (firstRecord !== undefined) {
      if (firstRecord.type !== 'metadata') {
        // Envelope-less log: a fresh agent (creation no longer seals the log)
        // or a pre-envelope legacy log. Heal it in place: synthesize the
        // envelope at the current protocol version — records written by
        // current builds need no migration — and rewrite so the invariant
        // holds from now on.
        sourceRecords = [metadataRecord(), ...sourceRecords];
        shouldRewrite = fromPersistence;
      } else {
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
  InstantiationType.Eager,
  'wireRecord',
);

function isWireRecordMetadata(record: PersistedWireRecord): record is WireRecordMetadata {
  return record.type === 'metadata' && typeof record['protocol_version'] === 'string';
}

async function hasAnyRecord(log: IAppendLogStore, scope: string, key: string): Promise<boolean> {
  for await (const record of log.read(scope, key)) {
    void record;
    return true;
  }
  return false;
}

export const WIRE_RECORD_FILENAME = 'wire.jsonl';

export function missingWireMetadataError(): Error {
  return new Error('WireRecord restore expected metadata as the first record');
}

export function wireRecordScope(homedir: string, homeDir: string): string {
  return relative(homeDir, homedir);
}

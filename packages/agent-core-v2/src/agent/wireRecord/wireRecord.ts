/**
 * `wireRecord` contract (L6) — the persisted wire journal's public surface.
 *
 * Defines the on-disk record vocabulary (the `metadata` envelope and the
 * migration records) and `IAgentWireRecordService`. `seal` starts a fresh log
 * with the `metadata` envelope at agent creation (a no-op once any record
 * exists) so released v1 builds — whose replay hard-rejects a non-empty log
 * lacking the envelope — can read sessions on a shared `KIMI_CODE_HOME`;
 * legacy envelope-less logs are healed by `restore`, never by `seal`. Bound
 * at Agent scope.
 */

import { createDecorator } from '#/_base/di/instantiation';

import type { WireMigrationRecord } from '#/agent/wireRecord/migration/migration';

export * from '#/agent/wireRecord/migration/migration';

export interface WireRecordMetadata {
  readonly type: 'metadata';
  readonly protocol_version: string;
  readonly created_at: number;
  readonly time?: number;
}

export type PersistedWireRecord = WireRecordMetadata | WireMigrationRecord;

export interface WireRecordRestoreOptions {
  readonly rewriteMigratedRecords?: boolean;
}

export interface WireRecordRestoreResult {
  readonly warning?: string;
}

export interface IAgentWireRecordService {
  readonly _serviceBrand: undefined;

  seal(): Promise<void>;
  getRecords(): readonly PersistedWireRecord[];
  restore(
    records?: readonly PersistedWireRecord[],
    options?: WireRecordRestoreOptions,
  ): Promise<WireRecordRestoreResult>;
  flush(): Promise<void>;
  close(): Promise<void>;
}

export const IAgentWireRecordService = createDecorator<IAgentWireRecordService>('agentWireRecordService');

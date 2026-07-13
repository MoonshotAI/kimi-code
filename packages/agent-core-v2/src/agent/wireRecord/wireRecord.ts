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

  /**
   * Snapshot of every record held in memory, in order, excluding the leading
   * `metadata` envelope: the records seeded by {@link restore} plus every record
   * persisted by live dispatch afterwards (appended in dispatch order). Intended
   * for callers that need to replay or reduce the same history without
   * re-reading `wire.jsonl` (e.g. session fork, the messages/snapshot
   * transcript).
   */
  getRecords(): readonly PersistedWireRecord[];
  restore(
    records?: readonly PersistedWireRecord[],
    options?: WireRecordRestoreOptions,
  ): Promise<WireRecordRestoreResult>;
  flush(): Promise<void>;
  close(): Promise<void>;
}

export const IAgentWireRecordService = createDecorator<IAgentWireRecordService>('agentWireRecordService');

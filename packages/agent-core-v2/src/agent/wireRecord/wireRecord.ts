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

  getRecords(): readonly PersistedWireRecord[];
  restore(
    records?: readonly PersistedWireRecord[],
    options?: WireRecordRestoreOptions,
  ): Promise<WireRecordRestoreResult>;
  flush(): Promise<void>;
  close(): Promise<void>;
}

export const IAgentWireRecordService = createDecorator<IAgentWireRecordService>('agentWireRecordService');

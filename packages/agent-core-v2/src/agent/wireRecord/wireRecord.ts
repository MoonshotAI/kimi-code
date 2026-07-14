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
   * Ensure the on-disk wire log starts with the `metadata` envelope: append it
   * when the log is still empty (fresh agent), no-op otherwise. Called at
   * agent creation so the log always satisfies v1's replay invariant — v1's
   * `AgentRecords.replay()` hard-rejects a non-empty log whose first record is
   * not `metadata`, and sessions on a shared `KIMI_CODE_HOME` must stay
   * readable by both engines. Legacy envelope-less logs (written before this
   * existed) are healed by `restore()`, never here.
   */
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

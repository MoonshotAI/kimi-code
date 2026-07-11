import type { ContentPart } from '#/app/llmProtocol/message';

import { createDecorator } from "#/_base/di/instantiation";
import type { IDisposable } from "#/_base/di/lifecycle";

import type { Hooks } from '#/hooks';
import type { WireMigrationRecord } from '#/agent/wireRecord/migration/migration';

export * from '#/agent/wireRecord/migration/migration';

export interface WireRecordMap {}

export type WireRecord<K extends keyof WireRecordMap = keyof WireRecordMap> = {
  [T in K]: { readonly type: T; readonly time?: number } & Readonly<WireRecordMap[T]>;
}[K];

export interface WireRecordMetadata {
  readonly type: 'metadata';
  readonly protocol_version: string;
  readonly created_at: number;
  readonly time?: number;
}

export type PersistedWireRecord = WireRecord | WireRecordMetadata | WireMigrationRecord;

export interface WireRecordRestoringContext {
  readonly time?: number;
}

export interface WireRecordRestoredContext {
  readonly record: WireRecord;
  stop: boolean;
}

export interface WireRecordRestoreOptions {
  readonly rewriteMigratedRecords?: boolean;
}

export interface WireRecordRestoreResult {
  readonly warning?: string;
}

export interface WireRecordBlobTarget<TRecord = WireRecord> {
  readonly parts: readonly ContentPart[];
  replace(record: TRecord, parts: readonly ContentPart[]): TRecord;
}

export type WireRecordBlobSelector<TRecord = WireRecord> = (
  record: TRecord,
) => Iterable<WireRecordBlobTarget<TRecord>>;

export interface WireRecordRegisterOptions<T extends keyof WireRecordMap> {
  readonly blobs?: WireRecordBlobSelector<WireRecord<T>>;
}

/**
 * Static construction options for `AgentWireRecordService`, supplied through a
 * `SyncDescriptor` when the service is seeded into a scope. Kept separate from
 * injected services so each agent scope can pin its own persistence key.
 */
export interface WireRecordServiceOptions {
  /**
   * Per-agent home directory used to derive the wire-log persistence key.
   * Falls back to `IBootstrapService.homeDir` (the global home) when omitted.
   */
  readonly homedir?: string;
}

export interface IAgentWireRecordService {
  readonly _serviceBrand: undefined;

  readonly restoring: WireRecordRestoringContext | null;
  readonly postRestoring: boolean;
  /**
   * Snapshot of every record held in memory, in order, excluding the leading
   * `metadata` envelope: the records seeded by {@link restore} plus every record
   * persisted by live dispatch afterwards (appended in dispatch order). Intended
   * for callers that need to replay or reduce the same history without
   * re-reading `wire.jsonl` (e.g. session fork, the messages/snapshot
   * transcript).
   */
  getRecords(): readonly PersistedWireRecord[];
  register<T extends keyof WireRecordMap>(
    type: T,
    resumer: (data: WireRecord<T>) => void | Promise<void>,
    options?: WireRecordRegisterOptions<T>,
  ): IDisposable;
  restore(
    records?: readonly PersistedWireRecord[],
    options?: WireRecordRestoreOptions,
  ): Promise<WireRecordRestoreResult>;
  flush(): Promise<void>;
  close(): Promise<void>;

  readonly hooks: Hooks<{
    onDidRestoreRecord: WireRecordRestoredContext;
    onDidFinishResume: {};
  }>;
}

export const IAgentWireRecordService = createDecorator<IAgentWireRecordService>('agentWireRecordService');

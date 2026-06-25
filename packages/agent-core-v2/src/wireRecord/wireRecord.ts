import type { ContentPart } from '@moonshot-ai/kosong';

import { createDecorator } from "#/_base/di";
import type { IDisposable } from "#/_base/di";

import type { IBlobStoreService } from '../blobStore/blobStore';
import type { Hooks } from '../hooks';
import type { WireRecord, WireRecordMap } from '../types';
import type { WireMigrationRecord } from './migration';

export { AGENT_WIRE_PROTOCOL_VERSION } from './migration';

export interface WireRecordMetadata {
  readonly type: 'metadata';
  readonly protocol_version: string;
  readonly created_at: number;
  readonly time?: number;
}

export type PersistedWireRecord = WireRecord | WireRecordMetadata | WireMigrationRecord;

export interface WireRecordPersistence {
  read(): AsyncIterable<PersistedWireRecord>;
  append(input: PersistedWireRecord): void;
  rewrite(records: readonly PersistedWireRecord[]): void;
  flush(): Promise<void>;
  close(): Promise<void>;
}

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

export interface WireRecordServiceOptions {
  readonly homedir?: string;
  readonly persistence?: WireRecordPersistence;
  readonly blobStore?: IBlobStoreService;
  readonly onPersistenceError?: (
    error: unknown,
    record?: PersistedWireRecord,
  ) => void;
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

export interface IWireRecord {
  readonly restoring: WireRecordRestoringContext | null;
  readonly postRestoring: boolean;

  append(record: WireRecord): void;
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
    onRestoredRecord: WireRecordRestoredContext;
    onResumeEnded: {};
  }>;
}

// eslint-disable-next-line @typescript-eslint/no-redeclare
export const IWireRecord = createDecorator<IWireRecord>('agentWireRecordService');

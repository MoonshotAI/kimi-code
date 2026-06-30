import type { ContentPart } from '@moonshot-ai/kosong';

import { createDecorator } from "#/_base/di/instantiation";
import type { IDisposable } from "#/_base/di/lifecycle";

import type { Hooks } from '#/hooks';
import type { WireRecord, WireRecordMap } from '#/wireRecord';
import type { WireMigrationRecord } from './migration';

export { AGENT_WIRE_PROTOCOL_VERSION } from './migration';

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

export interface IWireRecord {
  readonly _serviceBrand: undefined;
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

export const IWireRecord = createDecorator<IWireRecord>('agentWireRecordService');

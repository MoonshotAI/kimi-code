/**
 * `wire` domain — the persisted journal record language.
 *
 * A `WireRecord` is the flat JSONL representation of one persisted durable
 * event. The first line of an Agent journal is a `WireMetadataRecord`;
 * metadata is a journal envelope, not an event, so it never enters the state
 * fold registry. This module owns only pure encoding and decoding plus the
 * blob-offload transform types.
 */

import { WIRE_PROTOCOL_VERSION } from './migration/migration';

export const AGENT_WIRE_RECORD_KEY = 'wire.jsonl';

export type PartsTransformer = (parts: readonly unknown[]) => Promise<readonly unknown[]>;

export type RecordDehydrator = (
  record: WireRecord,
  transform: PartsTransformer,
) => WireRecord | Promise<WireRecord>;

export interface WireRecord {
  readonly type: string;
  readonly time?: number;
  readonly [key: string]: unknown;
}

export interface WireMetadataRecord extends WireRecord {
  readonly type: 'metadata';
  readonly protocol_version: string;
  readonly created_at: number;
}

export function isWireRecord(record: unknown): record is WireRecord {
  return (
    record !== null &&
    typeof record === 'object' &&
    !Array.isArray(record) &&
    typeof (record as { type?: unknown }).type === 'string'
  );
}

export function createWireMetadataRecord(now = Date.now()): WireMetadataRecord {
  return {
    type: 'metadata',
    protocol_version: WIRE_PROTOCOL_VERSION,
    created_at: now,
  };
}

export function isWireMetadataRecord(record: WireRecord): record is WireMetadataRecord {
  return (
    record.type === 'metadata' &&
    typeof record['protocol_version'] === 'string' &&
    typeof record['created_at'] === 'number'
  );
}

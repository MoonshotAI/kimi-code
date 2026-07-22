/**
 * `wire` domain (L2) — the persisted journal record language.
 *
 * A `WireRecord` is the flat JSONL representation of one persisted Op. The
 * first line of an Agent journal is a `WireMetadataRecord`; metadata is a
 * journal envelope, not an Op, so it never enters the model reducer registry.
 * This module owns only pure encoding and decoding.
 */

import type { Op } from '#/wire/op';

import { WIRE_PROTOCOL_VERSION } from './migration/migration';

export const AGENT_WIRE_RECORD_KEY = 'wire.jsonl';

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

/**
 * `log.cut` — the wire layer's rewind control record. NOT an Op: it never
 * enters `OP_REGISTRY` or any business model. `WireService` interprets it
 * during restore and writes it from `rewind()`. `target` is a record index
 * (0-based over NON-metadata records — the metadata envelope never occupies
 * an index, so migration rewrites that add it never shift targets): on
 * encountering the record, every `rewindable` model is reset to the fold of
 * records `[0, target)`, and replay then continues after this record.
 * `reason` is audit metadata (e.g. 'undo').
 */
export const LOG_CUT_RECORD_TYPE = 'log.cut';

export interface LogCutRecord extends WireRecord {
  readonly type: typeof LOG_CUT_RECORD_TYPE;
  readonly target: number;
  readonly reason?: string;
}

export function isLogCutRecord(record: WireRecord): record is LogCutRecord {
  return (
    record.type === LOG_CUT_RECORD_TYPE &&
    typeof record['target'] === 'number' &&
    Number.isInteger(record['target']) &&
    record['target'] >= 0
  );
}

export function createLogCutRecord(target: number, reason?: string, now = Date.now()): LogCutRecord {
  return {
    type: LOG_CUT_RECORD_TYPE,
    target,
    ...(reason !== undefined ? { reason } : {}),
    time: now,
  };
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

export function opToWireRecord(op: Op, now = Date.now()): WireRecord {
  const payload = op.payload;
  const record: Record<string, unknown> =
    payload !== null && typeof payload === 'object' && !Array.isArray(payload)
      ? { type: op.type, ...(payload as Record<string, unknown>) }
      : { type: op.type, payload };
  if (record['time'] === undefined) record['time'] = now;
  return record as WireRecord;
}

export function wireRecordToPayload(record: WireRecord): unknown {
  const { type: _type, time: _time, ...payload } = record;
  return Object.keys(payload).length === 1 && 'payload' in payload
    ? payload['payload']
    : payload;
}

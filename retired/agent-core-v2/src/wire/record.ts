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

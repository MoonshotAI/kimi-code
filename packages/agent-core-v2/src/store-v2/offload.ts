import { mapJournal, type EventCodec } from './codec';
import type { Event, Journal } from './store';

export interface BlobRef {
  readonly ref: string;
  readonly size: number;
  readonly mediaType?: string;
}

export interface BlobStore {
  put(data: Uint8Array): Promise<BlobRef>;
  get(ref: BlobRef): Promise<Uint8Array>;
}

export const OFFLOADED_EVENT_TYPE = 'store.offloaded';

export interface OffloadMarker extends Event {
  readonly type: typeof OFFLOADED_EVENT_TYPE;
  readonly originalType: string;
  readonly originalTime?: number;
  readonly payload: BlobRef;
}

export type OffloadRecord = Event | OffloadMarker;

export class OffloadDecodeError extends Error {
  constructor(message: string, readonly ref: BlobRef, cause: unknown) {
    super(message, { cause });
  }
}

export class BlobNotFoundError extends Error {
  constructor(readonly ref: BlobRef) {
    super(`Blob '${ref.ref}' was not found.`);
  }
}

function hasOwn(value: object, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function inspectJson(value: unknown, ancestors = new Set<object>()): void {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return;
  if (typeof value === 'number') {
    if (Number.isFinite(value)) return;
    throw new TypeError('Events must contain only finite JSON numbers');
  }
  if (typeof value !== 'object' || ancestors.has(value)) throw new TypeError('Events must contain acyclic JSON values');
  const prototype = Object.getPrototypeOf(value);
  if (!Array.isArray(value) && prototype !== Object.prototype && prototype !== null) {
    throw new TypeError('Events must contain only plain objects and arrays');
  }
  if (Object.getOwnPropertySymbols(value).length > 0) throw new TypeError('Events must not contain symbol keys');
  ancestors.add(value);
  for (const key of Object.keys(value)) inspectJson((value as Record<string, unknown>)[key], ancestors);
  ancestors.delete(value);
}

function assertEvent(value: unknown): asserts value is Event {
  inspectJson(value);
  if (value === null || typeof value !== 'object' || Array.isArray(value) || !hasOwn(value, 'type')) {
    throw new TypeError('Events must be plain objects with a string type');
  }
  const record = value as Record<string, unknown>;
  const type = record['type'];
  if (typeof type !== 'string') throw new TypeError('Events must be plain objects with a string type');
  const time = record['time'];
  if (hasOwn(value, 'time') && (typeof time !== 'number' || !Number.isFinite(time))) {
    throw new TypeError(`Invalid event time for '${type}'`);
  }
}

function canonicalBytes(event: Event): Uint8Array {
  const json = JSON.stringify(event);
  if (json === undefined) throw new TypeError('Events must be JSON-serializable');
  return new TextEncoder().encode(json);
}

function assertBlobRef(value: unknown): asserts value is BlobRef {
  inspectJson(value);
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new TypeError('Invalid blob reference');
  const record = value as Record<string, unknown>;
  const ref = record['ref'];
  const size = record['size'];
  if (!hasOwn(value, 'ref') || typeof ref !== 'string' || ref.length === 0 || !hasOwn(value, 'size') || !Number.isSafeInteger(size) || (size as number) < 0) {
    throw new TypeError('Invalid blob reference');
  }
  if (hasOwn(value, 'mediaType') && typeof record['mediaType'] !== 'string') throw new TypeError('Invalid blob media type');
  const keys = Object.keys(value);
  if (keys.some((key) => key !== 'ref' && key !== 'size' && key !== 'mediaType')) throw new TypeError('Invalid blob reference fields');
}

function assertMarker(value: Event): asserts value is OffloadMarker {
  const marker = value as OffloadMarker;
  if (marker['type'] !== OFFLOADED_EVENT_TYPE) throw new TypeError('Not an offload marker');
  const originalType = marker['originalType'];
  if (!hasOwn(value, 'originalType') || typeof originalType !== 'string' || originalType === OFFLOADED_EVENT_TYPE) {
    throw new TypeError('Invalid offload marker original type');
  }
  const originalTime = marker['originalTime'];
  if (hasOwn(value, 'originalTime') && (typeof originalTime !== 'number' || !Number.isFinite(originalTime))) {
    throw new TypeError('Invalid offload marker original time');
  }
  if (!hasOwn(value, 'payload')) throw new TypeError('Offload marker payload is missing');
  assertBlobRef(marker['payload']);
  const keys = Object.keys(value);
  if (keys.some((key) => key !== 'type' && key !== 'originalType' && key !== 'originalTime' && key !== 'payload')) {
    throw new TypeError('Invalid offload marker fields');
  }
}

export interface OffloadOptions<E extends Event> {
  readonly blobs: BlobStore;
  readonly thresholdBytes: number;
  readonly shouldOffload?: (event: E) => boolean;
}

export function offloadJson<E extends Event>(options: OffloadOptions<E>): EventCodec<E, OffloadRecord> {
  if (!Number.isSafeInteger(options.thresholdBytes) || options.thresholdBytes < 0) {
    throw new RangeError('thresholdBytes must be a non-negative safe integer');
  }
  return {
    encode: async (event) => {
      assertEvent(event);
      const eventRecord = event as Record<string, unknown>;
      const eventType = eventRecord['type'] as string;
      if (eventType === OFFLOADED_EVENT_TYPE) throw new TypeError(`'${OFFLOADED_EVENT_TYPE}' is reserved for physical records`);
      const bytes = canonicalBytes(event);
      if (options.shouldOffload?.(event) === false || bytes.byteLength < options.thresholdBytes) return event;
      const payload = await options.blobs.put(bytes);
      assertBlobRef(payload);
      if (payload['size'] !== bytes.byteLength) throw new TypeError('Blob store returned an incorrect blob size');
      const marker: OffloadMarker = hasOwn(event, 'time')
        ? { type: OFFLOADED_EVENT_TYPE, originalType: eventType, originalTime: eventRecord['time'] as number, payload }
        : { type: OFFLOADED_EVENT_TYPE, originalType: eventType, payload };
      assertEvent(marker);
      assertMarker(marker);
      return marker;
    },
    decode: async (record) => {
      assertEvent(record);
      if (record.type !== OFFLOADED_EVENT_TYPE) return record as E;
      assertMarker(record);
      const marker = record;
      const payload = marker['payload'];
      let bytes: Uint8Array;
      try {
        bytes = await options.blobs.get(payload);
      } catch (error) {
        throw new OffloadDecodeError(`Unable to load offloaded event blob '${payload['ref']}'.`, payload, error);
      }
      if (!(bytes instanceof Uint8Array) || bytes.byteLength !== payload['size']) {
        throw new OffloadDecodeError(`Offloaded event blob '${payload['ref']}' has an unexpected size.`, payload, new TypeError('Blob size mismatch'));
      }
      let decoded: unknown;
      try {
        decoded = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
      } catch (error) {
        throw new OffloadDecodeError(`Offloaded event blob '${payload['ref']}' is not canonical JSON.`, payload, error);
      }
      assertEvent(decoded);
      const decodedRecord = decoded as unknown as Record<string, unknown>;
      if (decodedRecord['type'] === OFFLOADED_EVENT_TYPE || decodedRecord['type'] !== marker['originalType']) {
        throw new OffloadDecodeError(`Offloaded event blob '${payload['ref']}' has the wrong event type.`, payload, new TypeError('Event type mismatch'));
      }
      const hasTime = hasOwn(decoded, 'time');
      if (hasTime !== hasOwn(marker, 'originalTime') || (hasTime && decodedRecord['time'] !== marker['originalTime'])) {
        throw new OffloadDecodeError(`Offloaded event blob '${payload['ref']}' has the wrong event time.`, payload, new TypeError('Event time mismatch'));
      }
      return decoded as E;
    },
  };
}

export function withOffload<E extends Event, C>(journal: Journal<OffloadRecord, C>, options: OffloadOptions<E>): Journal<E, C> {
  return mapJournal(journal, offloadJson(options));
}

export function memoryBlobStore(): BlobStore {
  const blobs = new Map<string, Uint8Array>();
  let sequence = 0;
  return {
    put: async (data) => {
      if (!(data instanceof Uint8Array)) throw new TypeError('Blob data must be a Uint8Array');
      const ref = `memory:${sequence++}`;
      const copy = data.slice();
      blobs.set(ref, copy);
      return { ref, size: copy.byteLength };
    },
    get: async (ref) => {
      const data = blobs.get(ref['ref']);
      if (data === undefined) throw new BlobNotFoundError(ref);
      return data.slice();
    },
  };
}

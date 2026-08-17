/**
 * `event` domain — `Event2` base class, the durable-event registry, and the
 * record (de)serialization helpers.
 *
 * Every fact flowing through an Agent or the App is an `Event2` subclass:
 * the class declares the static `type` string, instances carry the payload
 * fields directly plus the epoch-ms `time`. Durable subclasses additionally
 * declare `durable = true` and a zod `schema`; their `serialize()` output is
 * the wire.jsonl record (flat `{ type, ...fields, time }`, byte-compatible
 * with the retired op encoding) and the schema validates payloads on replay.
 * `observable` subclasses are published to the scope's bus on live dispatch;
 * non-observable events only drive state folds (and the journal when
 * durable). Durable classes register into `EVENT2_REGISTRY` at import time
 * ("import = register") so restore can resolve a record type back to its
 * class; re-registering the same class is a no-op, a different class with an
 * already-taken type throws `DuplicateEventError`. Scope-agnostic.
 */

import type { z } from 'zod';

import { EventError, EventErrors } from './errors';

export interface SerializedEvent2 {
  readonly type: string;
  readonly time: number;
  readonly [key: string]: unknown;
}

export class DuplicateEventError extends EventError {
  constructor(readonly eventType: string) {
    super(
      EventErrors.codes.EVENT_DUPLICATE_EVENT,
      `Duplicate event type registered: '${eventType}'`,
      { details: { type: eventType } },
    );
    this.name = 'DuplicateEventError';
  }
}

export abstract class Event2<P = Record<string, unknown>> {
  declare static readonly type: string;
  static readonly durable: boolean = false;
  static readonly observable: boolean = false;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  declare static readonly schema: z.ZodType<any> | undefined;

  readonly type: string;
  readonly time: number;

  constructor(payload: P, time?: number) {
    Object.assign(this, payload);
    this.type = (this.constructor as Event2Class).type;
    this.time = time ?? Date.now();
  }

  serialize(): SerializedEvent2 {
    const record: Record<string, unknown> = { type: this.type };
    for (const key of Object.keys(this)) {
      if (key === 'type' || key === 'time') continue;
      record[key] = (this as unknown as Record<string, unknown>)[key];
    }
    record['time'] = this.time;
    return record as SerializedEvent2;
  }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export interface Event2Class<P = any, E extends Event2<P> = Event2<P>> {
  new (payload: P, time?: number): E;
  readonly type: string;
  readonly durable: boolean;
  readonly observable: boolean;
  readonly schema: z.ZodType<P> | undefined;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const EVENT2_REGISTRY = new Map<string, Event2Class<any, any>>();

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function registerEvent2Class(cls: Event2Class<any, any>): void {
  if (!cls.durable) return;
  if (cls.schema === undefined) {
    throw new EventError(
      EventErrors.codes.EVENT_SCHEMA_MISSING,
      `Durable event '${cls.type}' must declare a payload schema`,
      { details: { type: cls.type } },
    );
  }
  const existing = EVENT2_REGISTRY.get(cls.type);
  if (existing === cls) return;
  if (existing !== undefined) {
    throw new DuplicateEventError(cls.type);
  }
  EVENT2_REGISTRY.set(cls.type, cls);
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function event2FromRecord<P>(
  cls: Event2Class<P, any>,
  record: { readonly type: string; readonly time?: number } & Record<string, unknown>,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
): Event2<any> | undefined {
  const { type: _type, time: _time, ...payload } = record;
  const parsed = cls.schema?.safeParse(payload);
  if (parsed === undefined || !parsed.success) return undefined;
  return new cls(parsed.data, record.time);
}

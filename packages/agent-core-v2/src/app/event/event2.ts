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
  static readonly agentDomain: boolean = false;
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

export interface AgentDomainTrait {
  readonly agentId: string;
}

export abstract class AgentEvent2<P extends AgentDomainTrait> extends Event2<P> {
  static override readonly agentDomain = true;

  declare readonly agentId: string;
}

export interface Event2Class<P = any, E extends Event2<P> = Event2<P>> {
  new (payload: P, time?: number): E;
  readonly type: string;
  readonly durable: boolean;
  readonly observable: boolean;
  readonly agentDomain: boolean;
  readonly schema: z.ZodType<P> | undefined;
}

export const EVENT2_REGISTRY = new Map<string, Event2Class<any, any>>();

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

export function event2FromRecord<P>(
  cls: Event2Class<P, any>,
  record: { readonly type: string; readonly time?: number } & Record<string, unknown>,
): Event2<any> | undefined {
  const { type: _type, time: _time, ...payload } = record;
  const parsed = cls.schema?.safeParse(payload);
  if (parsed === undefined || !parsed.success) return undefined;
  return new cls(parsed.data, record.time);
}

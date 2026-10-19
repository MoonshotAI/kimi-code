import { z } from 'zod';

import { StoreError } from '#/store/types';

export type ExternalEvent<P = Record<string, unknown>> = P & { type: string; time: number };

export interface EventFactory<P> {
  (payload: P): ExternalEvent<P>;
  readonly type: string;
  readonly schema: z.ZodTypeAny;
}

export type EventOf<F> = F extends EventFactory<infer P> ? ExternalEvent<P> : never;

export type InternalEvent = { type: string } & Record<string, unknown>;

const registry = new Map<string, z.ZodTypeAny>();

export function defineEvent<P>(def: { type: string; schema: z.ZodType<P> }): EventFactory<P> {
  if (registry.has(def.type)) {
    throw new StoreError('duplicate-event', `duplicate event type '${def.type}'`);
  }
  registry.set(def.type, def.schema);
  const factory = (payload: P): ExternalEvent<P> => ({
    ...payload,
    type: def.type,
    time: Date.now(),
  });
  factory.type = def.type;
  factory.schema = def.schema;
  return factory;
}

export function eventSchemaFor(type: string): z.ZodTypeAny | undefined {
  return registry.get(type);
}

export function parseEvent(
  type: string,
  record: unknown,
): (ExternalEvent & Record<string, unknown>) | undefined {
  const schema = registry.get(type);
  if (schema === undefined) return undefined;
  if (typeof record !== 'object' || record === null) return undefined;
  const { type: _type, time: _time, ...payload } = record as Record<string, unknown>;
  if (!schema.safeParse(payload).success) return undefined;
  return record as ExternalEvent & Record<string, unknown>;
}

export function validateEvent(event: ExternalEvent): StoreError | undefined {
  const schema = registry.get(event.type);
  if (schema === undefined) {
    return new StoreError('unregistered-event', `event '${event.type}' is not a registered external event`);
  }
  const { type: _type, time: _time, ...payload } = event;
  const parsed = schema.safeParse(payload);
  if (!parsed.success) {
    return new StoreError('schema', `event '${event.type}' failed schema validation: ${parsed.error.message}`);
  }
  return undefined;
}

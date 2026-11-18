import type { z } from 'zod';

export type MutableDeep<T> = T extends readonly (infer U)[]
  ? MutableDeep<U>[]
  : T extends object
    ? { -readonly [K in keyof T]: MutableDeep<T[K]> }
    : T;

export type AssertWire<TSchema extends z.ZodType, TEngine> = ([
  z.infer<TSchema>,
] extends [MutableDeep<TEngine>]
  ? true
  : never) &
  ([MutableDeep<TEngine>] extends [z.infer<TSchema>] ? true : never);

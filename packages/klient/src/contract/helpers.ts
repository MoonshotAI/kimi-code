/**
 * Shared schema helpers for contract fragments.
 */

import { z } from 'zod';

/** `Page<T>` on the wire (`persistence/interface/queryStore.ts`). */
export const pageOf = <T extends z.ZodType>(item: T) =>
  z.object({
    items: z.array(item),
    nextCursor: z.string().optional(),
  });

/**
 * Engine `X | undefined` returns cross the wire as `null` over HTTP (JSON
 * has no `undefined`) and as `undefined` in-process — accept both and
 * normalize to `undefined`.
 */
export const maybe = <T extends z.ZodType>(schema: T) =>
  z.union([schema, z.null(), z.undefined()]).transform((value) => value ?? undefined);

/**
 * `void` method results arrive as `null` over HTTP (JSON has no `undefined`)
 * and as `undefined` in-process — accept both and normalize to `undefined`.
 */
export const noResult = z
  .union([z.void(), z.null()])
  .transform(() => undefined);

/** Engine `{ added, removed, changed }` change-set events. */
export const stringDeltaSchema = z.object({
  added: z.array(z.string()),
  removed: z.array(z.string()),
  changed: z.array(z.string()),
});

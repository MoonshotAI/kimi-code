import { z } from 'zod';

export const pageOf = <T extends z.ZodType>(item: T) =>
  z.object({
    items: z.array(item),
    nextCursor: z.string().optional(),
  });

export const maybe = <T extends z.ZodType>(schema: T) =>
  z.union([schema, z.null(), z.undefined()]).transform((value) => value ?? undefined);

export const noResult = z
  .union([z.void(), z.null()])
  .transform(() => undefined);

export const stringDeltaSchema = z.object({
  added: z.array(z.string()),
  removed: z.array(z.string()),
  changed: z.array(z.string()),
});

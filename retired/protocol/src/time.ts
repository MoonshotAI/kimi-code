import { z } from 'zod';

const ISO_8601_REGEX =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}(?::?\d{2})?)$/;

export const isoDateTimeSchema = z
  .string()
  .refine((value) => ISO_8601_REGEX.test(value), {
    message: 'must be an ISO 8601 datetime string',
  })
  .transform((value, ctx) => {
    const ms = Date.parse(value);
    if (Number.isNaN(ms)) {
      ctx.addIssue({
        code: 'custom',
        message: 'invalid ISO 8601 datetime',
      });
      return z.NEVER;
    }
    return new Date(ms).toISOString();
  });

export const IsoDateTime = isoDateTimeSchema;

export type IsoDateTime = string;

export function nowIsoDateTime(): IsoDateTime {
  return new Date().toISOString();
}

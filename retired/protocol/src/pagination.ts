import { z } from 'zod';

import { ErrorCode } from './error-codes';

export const cursorQuerySchema = z
  .object({
    before_id: z.string().min(1).optional(),
    after_id: z.string().min(1).optional(),
    page_size: z.number().int().min(1).max(100).optional(),
  })
  .superRefine((value, ctx) => {
    if (value.before_id !== undefined && value.after_id !== undefined) {
      ctx.addIssue({
        code: 'custom',
        message: 'before_id and after_id are mutually exclusive',
        path: ['before_id'],
        params: { code: ErrorCode.VALIDATION_FAILED },
      });
    }
  });

export type CursorQuery = z.infer<typeof cursorQuerySchema>;

export const CursorQuery = cursorQuerySchema;

export const pageResponseSchema = <T extends z.ZodTypeAny>(item: T) =>
  z.object({
    items: z.array(item),
    has_more: z.boolean(),
  });

export interface PageResponse<T> {
  items: T[];
  has_more: boolean;
}

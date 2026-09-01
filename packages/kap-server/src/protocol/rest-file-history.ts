import { z } from 'zod';

export const fileHistoryChangesQuerySchema = z.object({
  turn_id: z.coerce.number().int().nonnegative(),
});
export type FileHistoryChangesQuery = z.infer<typeof fileHistoryChangesQuerySchema>;

export const fileHistoryContentQuerySchema = z.object({
  turn_id: z.coerce.number().int().nonnegative(),
  path: z.string().min(1),
  phase: z.enum(['start', 'end']).optional(),
});
export type FileHistoryContentQuery = z.infer<typeof fileHistoryContentQuerySchema>;

export const fileHistoryChangeSchema = z.object({
  path: z.string(),
  status: z.enum(['added', 'modified', 'deleted']),
  additions: z.number(),
  deletions: z.number(),
  binary: z.boolean().optional(),
  oversize: z.boolean().optional(),
});
export type WireFileHistoryChange = z.infer<typeof fileHistoryChangeSchema>;

export const fileHistoryChangesResponseSchema = z.object({
  changes: z.array(fileHistoryChangeSchema),
  enabled: z.boolean(),
  recorded: z.boolean(),
});
export type FileHistoryChangesResponse = z.infer<typeof fileHistoryChangesResponseSchema>;

export const fileHistoryContentEntrySchema = z.object({
  version: z.number(),
  content: z.string().optional(),
  binary: z.boolean().optional(),
});

export const fileHistoryContentResponseSchema = z.object({
  content: fileHistoryContentEntrySchema.nullable(),
});
export type FileHistoryContentResponse = z.infer<typeof fileHistoryContentResponseSchema>;

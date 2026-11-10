import { z } from 'zod';

const turnNumberParam = z.coerce.number().int().nonnegative();

const turnSelectorShape = {
  turn_number: turnNumberParam.optional().describe('Turn number; required unless the deprecated turn_id is given'),
  turn_id: turnNumberParam.optional().describe('Deprecated alias of turn_number'),
};

function withTurnNumber<T extends { readonly turn_number?: number; readonly turn_id?: number }>(
  { turn_number, turn_id, ...rest }: T,
  ctx: z.RefinementCtx,
) {
  const turnNumber = turn_number ?? turn_id;
  if (turnNumber === undefined) {
    ctx.addIssue({ code: 'custom', message: 'turn_number is required', path: ['turn_number'] });
    return z.NEVER;
  }
  return { ...rest, turn_number: turnNumber };
}

export const fileHistoryChangesQuerySchema = z.object(turnSelectorShape).transform(withTurnNumber);
export type FileHistoryChangesQuery = z.infer<typeof fileHistoryChangesQuerySchema>;

export const fileHistoryContentQuerySchema = z
  .object({
    ...turnSelectorShape,
    path: z.string().min(1),
    phase: z.enum(['start', 'end']).optional(),
  })
  .transform(withTurnNumber);
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

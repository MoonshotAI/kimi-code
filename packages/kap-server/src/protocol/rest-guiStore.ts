import { z } from 'zod';

const keySchema = z.string().min(1).max(256);
const valueSchema = z.string().max(1_048_576);

export const guiStoreEntrySchema = z.object({
  value: z.string(),
  revision: z.number().int().min(1),
});

export type GuiStoreEntryWire = z.infer<typeof guiStoreEntrySchema>;

export const guiStoreGetQuerySchema = z.object({
  prefix: z.string().max(256).optional(),
  keys: z.union([keySchema, z.array(keySchema).max(256)]).optional(),
});

export const guiStoreSnapshotSchema = z.object({
  revision: z.number().int().min(0),
  entries: z.record(z.string(), guiStoreEntrySchema),
});

export type GuiStoreSnapshotResponse = z.infer<typeof guiStoreSnapshotSchema>;

export const guiStoreMutationSchema = z.object({
  key: keySchema,
  value: valueSchema.nullable(),
  if_revision: z.number().int().min(0).optional(),
});

export const guiStorePatchBodySchema = z.object({
  mutations: z
    .array(guiStoreMutationSchema)
    .min(1)
    .max(256)
    .superRefine((items, ctx) => {
      const seen = new Set<string>();
      for (let i = 0; i < items.length; i += 1) {
        const key = items[i]!.key;
        if (seen.has(key)) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: `Duplicate key in mutations: ${key}`,
            path: [i, 'key'],
          });
        }
        seen.add(key);
      }
    }),
});

export const guiStorePatchResponseSchema = z.object({
  applied: z.boolean(),
  revision: z.number().int().min(0),
  entries: z.record(z.string(), guiStoreEntrySchema.nullable()),
  conflicts: z.record(z.string(), guiStoreEntrySchema.nullable()),
});

export type GuiStorePatchResponse = z.infer<typeof guiStorePatchResponseSchema>;

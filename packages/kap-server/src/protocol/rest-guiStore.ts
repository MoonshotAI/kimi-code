import { z } from 'zod';

const MAX_VALUE_CHARS = 65_536;
const MAX_BATCH_MUTATIONS = 128;
const MAX_BATCH_UTF8_BYTES = 524_288;

const keySchema = z.string().min(1).max(256);
const valueSchema = z.string().max(MAX_VALUE_CHARS);

export const guiStoreEntrySchema = z.object({
  value: z.string(),
  revision: z.number().int().min(1),
});

export type GuiStoreEntryWire = z.infer<typeof guiStoreEntrySchema>;

export const guiStoreGetQuerySchema = z.object({
  prefix: z.string().max(256).optional(),
  keys: z.union([keySchema, z.array(keySchema).max(MAX_BATCH_MUTATIONS)]).optional(),
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
    .max(MAX_BATCH_MUTATIONS)
    .superRefine((items, ctx) => {
      const seen = new Set<string>();
      let totalBytes = 0;
      for (let i = 0; i < items.length; i += 1) {
        const item = items[i]!;
        if (seen.has(item.key)) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: `Duplicate key in mutations: ${item.key}`,
            path: [i, 'key'],
          });
        }
        seen.add(item.key);
        totalBytes += Buffer.byteLength(item.key, 'utf-8');
        if (item.value !== null) {
          totalBytes += Buffer.byteLength(item.value, 'utf-8');
        }
      }
      if (totalBytes > MAX_BATCH_UTF8_BYTES) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `Batch payload exceeds ${MAX_BATCH_UTF8_BYTES} UTF-8 bytes`,
          path: [],
        });
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

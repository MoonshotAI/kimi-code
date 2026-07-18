import { z } from 'zod';

const keySchema = z.string().min(1).max(256);

export const guiStoreGetItemQuerySchema = z.object({ key: keySchema });

export const guiStoreSetItemBodySchema = z.object({
  key: keySchema,
  value: z.string(),
});

export const guiStoreRemoveItemBodySchema = z.object({ key: keySchema });

export const guiStoreGetItemResponseSchema = z.object({
  value: z.string().nullable(),
});
export type GuiStoreGetItemResponse = z.infer<typeof guiStoreGetItemResponseSchema>;

export const guiStoreLengthResponseSchema = z.object({
  length: z.number(),
});
export type GuiStoreLengthResponse = z.infer<typeof guiStoreLengthResponseSchema>;

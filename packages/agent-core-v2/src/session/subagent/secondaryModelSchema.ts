import { z } from 'zod';

export const SecondaryModelEntryObjectSchema = z.object({
  description: z.string().optional(),
  effort: z.string().optional(),
});

export type SecondaryModelEntryObject = z.infer<typeof SecondaryModelEntryObjectSchema>;

export const SecondaryModelEntrySchema = z.union([
  z.string(),
  SecondaryModelEntryObjectSchema,
]);

export type SecondaryModelEntry = z.infer<typeof SecondaryModelEntrySchema>;

export const SecondaryModelConfigSchema = z.object({
  defaultModel: z.string().min(1).optional(),
  models: z.record(z.string(), SecondaryModelEntrySchema).optional(),
  model: z.string().min(1).optional(),
  defaultEffort: z.string().optional(),
  allModels: z.boolean().optional(),
  rule: z.string().optional(),
});

export type SecondaryModelConfig = z.infer<typeof SecondaryModelConfigSchema>;

import { z } from 'zod';

export const stepUsageSchema = z.object({
  input_other: z.number().int().nonnegative(),
  output: z.number().int().nonnegative(),
  input_cache_read: z.number().int().nonnegative(),
  input_cache_creation: z.number().int().nonnegative(),
});

export type StepUsage = z.infer<typeof stepUsageSchema>;
